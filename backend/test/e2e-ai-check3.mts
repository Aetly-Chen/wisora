import 'dotenv/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const BASE = process.env.AI_TEST_BASE ?? 'http://localhost:3001';
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

/** 收到 done 立刻关闭连接并发起下一轮（复现竞态的最坏情况） */
async function turn(token: string, question: string, convId?: string) {
  const tr = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const { data } = (await tr.json()) as { data: { ticket: string } };

  const qs = new URLSearchParams({ ticket: data.ticket, q: question });
  if (convId) qs.set('conversationId', convId);

  const res = await fetch(`${BASE}/ai/chat/stream?${qs}`);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let startConvId = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      i = buf.indexOf('\n\n');
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw.startsWith(':')) continue;
      const ev = JSON.parse(raw) as {
        type: string;
        content?: string;
        conversationId?: string;
      };
      if (ev.type === 'start') startConvId = ev.conversationId ?? '';
      if (ev.type === 'token') text += ev.content ?? '';
      if (ev.type === 'done') {
        void reader.cancel(); // 立刻断开，不给服务端留缓冲时间
        return { text, convId: startConvId };
      }
    }
  }
  return { text, convId: startConvId };
}

async function main() {
  const email = 'e2e-rapid@wisora.local';
  await prisma.user.deleteMany({ where: { email } });
  const user = await prisma.user.create({
    data: { email, password: await bcrypt.hash('Test@12345', 10), nickname: 'rapid' },
  });
  const jwt = new JwtService();
  const token = await jwt.signAsync(
    { sub: user.id, email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  const rounds = [
    { q: '记住：我的代号是阿尔法。只回复"收到"。', expect: null },
    { q: '我的代号是什么？只回答代号本身。', expect: '阿尔法' },
    { q: '补充：我来自北京。现在回答：我的代号和所在城市？', expect: '阿尔法' },
    { q: '我来自哪个城市？只回答城市名。', expect: '北京' },
  ];

  let convId: string | undefined;
  let pass = 0;
  for (const [idx, r] of rounds.entries()) {
    const t = await turn(token, r.q, convId);
    convId ||= t.convId;
    const ok = r.expect ? t.text.includes(r.expect) : true;
    if (ok) pass++;
    console.log(
      `[${idx + 1}] Q: ${r.q}\n    A: ${JSON.stringify(t.text)}  ${r.expect ? (ok ? `✅ 含"${r.expect}"` : `❌ 缺"${r.expect}"`) : ''}`,
    );
  }

  const msgs = await prisma.message.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`\n[落库] 共 ${msgs.length} 条消息（期望 ${rounds.length * 2} 条）`);
  console.log(
    `        角色序列: ${msgs.map((m) => m.role).join(' -> ')}`,
  );
  console.log(`[结果] ${pass}/${rounds.filter((r) => r.expect).length} 轮记忆命中`);

  await prisma.message.deleteMany({
    where: { conversation: { userId: user.id } },
  });
  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('[清理完成]');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('FAILED:', e);
  await prisma.$disconnect();
  process.exit(1);
});
