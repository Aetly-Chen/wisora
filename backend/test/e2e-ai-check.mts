import 'dotenv/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const BASE = 'http://localhost:3001';
const QUESTION = '你好，用一句话介绍你自己';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  // ---- 准备测试用户 ----
  const email = 'e2e-test@wisora.local';
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        email,
        password: await bcrypt.hash('Test@12345', 10),
        nickname: 'e2e-tester',
      },
    });
    console.log(`[0] 创建测试用户 ${user.id}`);
  } else {
    console.log(`[0] 复用测试用户 ${user.id}`);
  }

  const jwt = new JwtService();
  const token = await jwt.signAsync(
    { sub: user.id, email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  // ---- 1) JWT 换票 ----
  const r1 = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const j1 = (await r1.json()) as { code: number; data?: { ticket?: string } };
  console.log(`[1] POST /ai/chat/ticket -> ${r1.status} ${JSON.stringify(j1)}`);
  const ticket = j1.data?.ticket;
  if (!ticket) throw new Error('未拿到 ticket');

  // ---- 2) 用 ticket 开 SSE 流 ----
  const url = `${BASE}/ai/chat/stream?ticket=${ticket}&q=${encodeURIComponent(QUESTION)}`;
  const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
  console.log(
    `[2] GET /ai/chat/stream -> ${res.status} content-type=${res.headers.get('content-type')}`,
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';
  const events: string[] = [];
  const deadline = Date.now() + 60_000;
  let finished = false;

  while (!finished && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx = buffer.indexOf('\n\n');
    while (idx >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      idx = buffer.indexOf('\n\n');

      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw.startsWith(':')) {
        console.log('    <- 心跳 :ping');
        continue;
      }

      const ev = JSON.parse(raw) as {
        type: string;
        content?: string;
        message?: string;
        finishReason?: string;
        conversationId?: string;
      };
      events.push(ev.type);
      if (ev.type === 'token') {
        fullText += ev.content ?? '';
        process.stdout.write(
          `    <- token: ${JSON.stringify(ev.content ?? '')}\n`,
        );
      } else {
        console.log(`    <- ${ev.type}: ${JSON.stringify(ev)}`);
      }

      if (ev.type === 'done' || ev.type === 'error') {
        finished = true;
        break;
      }
    }
  }
  void reader.cancel().catch(() => undefined);

  console.log(`[2] 事件序列: ${events.join(' -> ') || '(空)'}`);
  console.log(`[2] 累计正文: ${JSON.stringify(fullText)}`);

  // ---- 3) 校验落库 ----
  const r3 = await fetch(`${BASE}/ai/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const j3 = (await r3.json()) as {
    code: number;
    data?: Array<{ id: string; title: string | null; model: string | null }>;
  };
  console.log(
    `[3] GET /ai/conversations -> ${r3.status} 共 ${j3.data?.length ?? 0} 条：${JSON.stringify(j3.data)}`,
  );

  const convId = j3.data?.[0]?.id;
  if (convId) {
    const msgs = await prisma.message.findMany({
      where: { conversationId: convId },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`[3] 会话 ${convId} 下消息 ${msgs.length} 条：`);
    for (const m of msgs) {
      console.log(
        `    - [${m.role}] ${m.content.slice(0, 60)}${m.content.length > 60 ? '…' : ''}`,
      );
    }

    // ---- 4) 删除会话 ----
    const r4 = await fetch(`${BASE}/ai/conversations/${convId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`[4] DELETE /ai/conversations/${convId} -> ${r4.status}`);
  }

  // ---- 清理测试数据 ----
  await prisma.message.deleteMany({
    where: { conversation: { userId: user.id } },
  });
  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('[5] 测试数据已清理');

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
