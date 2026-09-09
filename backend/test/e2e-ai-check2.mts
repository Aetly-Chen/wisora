import 'dotenv/config';
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';

const BASE = process.env.AI_TEST_BASE ?? 'http://localhost:3001';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

type AnyEvent = Record<string, unknown> & { type: string };

async function getTicket(token: string) {
  const r = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const j = (await r.json()) as { data?: { ticket?: string } };
  return { status: r.status, ticket: j.data?.ticket };
}

/** 读一轮 SSE，返回事件列表 */
async function readStream(
  ticket: string,
  question: string,
  conversationId?: string,
) {
  const qs = new URLSearchParams({ ticket, q: question });
  if (conversationId) qs.set('conversationId', conversationId);

  const res = await fetch(`${BASE}/ai/chat/stream?${qs}`, {
    headers: { Accept: 'text/event-stream' },
  });
  const contentType = res.headers.get('content-type');

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  const events: AnyEvent[] = [];
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
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
      if (!raw || raw.startsWith(':')) continue;

      const ev = JSON.parse(raw) as AnyEvent;
      events.push(ev);
      if (ev.type === 'token') text += String(ev.content ?? '');
      if (ev.type === 'done' || ev.type === 'error') {
        void reader.cancel().catch(() => undefined);
        return { contentType, events, text };
      }
    }
  }
  void reader.cancel().catch(() => undefined);
  return { contentType, events, text };
}

async function main() {
  const email = 'e2e-test2@wisora.local';
  await prisma.user.deleteMany({ where: { email } });
  const user = await prisma.user.create({
    data: {
      email,
      password: await bcrypt.hash('Test@12345', 10),
      nickname: '工具测试员',
    },
  });

  const jwt = new JwtService();
  const token = await jwt.signAsync(
    { sub: user.id, email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  // ========== A. 多轮对话（验证 Redis 历史缓存）==========
  const t1 = await getTicket(token);
  const r1 = await readStream(t1.ticket!, '记住：我的代号是阿尔法。只回复"收到"。');
  const convId = (r1.events.find((e) => e.type === 'start') as { conversationId?: string })
    ?.conversationId;
  console.log(`[A1] content-type = ${r1.contentType}`);
  console.log(`[A1] 第一轮 -> ${JSON.stringify(r1.text)}  (会话 ${convId})`);

  const t2 = await getTicket(token);
  const r2 = await readStream(t2.ticket!, '我的代号是什么？', convId);
  console.log(`[A2] 第二轮 -> ${JSON.stringify(r2.text)}`);
  console.log(
    `[A2] 历史记忆${/阿尔法/.test(r2.text) ? '✅ 命中' : '❌ 未命中'}`,
  );

  // ========== B. ticket 一次性校验 ==========
  const t3 = await getTicket(token);
  const r3 = await readStream(t3.ticket!, '你好');
  console.log(`[B] 首次用 ticket -> ${r3.events.at(-1)?.type}`);
  const res4 = await fetch(
    `${BASE}/ai/chat/stream?ticket=${t3.ticket}&q=再来一次`,
  );
  console.log(`[B] 复用同一 ticket -> HTTP ${res4.status}（期望 401）`);
  void res4.body?.cancel();

  // ========== C. 工具调用 ==========
  const t5 = await getTicket(token);
  const r5 = await readStream(
    t5.ticket!,
    '用工具查一下昵称包含"工具测试员"的用户，告诉我他的邮箱。',
  );
  const toolCalls = r5.events.filter((e) => e.type === 'tool_call');
  const toolResults = r5.events.filter((e) => e.type === 'tool_result');
  console.log(`[C] tool_call 事件 ${toolCalls.length} 个：${JSON.stringify(toolCalls)}`);
  console.log(`[C] tool_result 事件 ${toolResults.length} 个：${JSON.stringify(toolResults)}`);
  console.log(`[C] 最终回答：${JSON.stringify(r5.text)}`);
  console.log(
    `[C] 工具链路${toolCalls.length > 0 && toolResults.length > 0 ? '✅ 打通' : '⚠️ 模型未调用工具'}`,
  );

  // ========== 清理 ==========
  await prisma.message.deleteMany({
    where: { conversation: { userId: user.id } },
  });
  await prisma.conversation.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log('[D] 测试数据已清理');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
