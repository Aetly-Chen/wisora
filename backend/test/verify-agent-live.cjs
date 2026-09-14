/**
 * Agent 功能真机验证：走真实 HTTP 链路，不依赖 Prisma 客户端。
 *   1) 建一个测试用户（直连 PG）
 *   2) 签 JWT
 *   3) POST /ai/chat/ticket 换票
 *   4) GET  /ai/chat/stream 开流，连续两轮，验证多轮记忆
 *   5) 清理测试数据
 */
require('dotenv/config');
const path = require('path');
const { Client } = require(path.join(
  __dirname, '../node_modules/.pnpm/pg@8.23.0/node_modules/pg',
));
const { JwtService } = require('@nestjs/jwt');

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-agent-check@wisora.local';

async function turn(token, question, conversationId) {
  // 1) 换票
  const tr = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowWrite: false }),
  });
  const tj = await tr.json();
  if (!tj?.data?.ticket) throw new Error(`换票失败: ${JSON.stringify(tj)}`);
  const ticket = tj.data.ticket;

  // 2) 开流
  const qs = new URLSearchParams({ ticket, q: question });
  if (conversationId) qs.set('conversationId', conversationId);
  const res = await fetch(`${BASE}/ai/chat/stream?${qs}`, {
    headers: { Accept: 'text/event-stream' },
  });
  if (!res.ok) throw new Error(`开流失败 HTTP ${res.status}: ${await res.text()}`);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let convId = conversationId ?? '';
  const seen = [];

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
      if (!raw || raw.startsWith(':')) continue;      // 跳过心跳
      const ev = JSON.parse(raw);
      if (!seen.includes(ev.type)) seen.push(ev.type);
      if (ev.type === 'start') convId = ev.conversationId;
      if (ev.type === 'token') text += ev.content;
      if (ev.type === 'done') { reader.cancel().catch(() => {}); return { text, convId, seen }; }
      if (ev.type === 'error') throw new Error(`流内错误: ${ev.message}`);
    }
  }
  return { text, convId, seen };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();

  await db.query('DELETE FROM "User" WHERE email = $1', [EMAIL]);
  const { rows } = await db.query(
    `INSERT INTO "User" (id, email, password, nickname, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'x', 'e2e-agent', now(), now()) RETURNING id`,
    [EMAIL],
  );
  const userId = rows[0].id;
  console.log('测试用户:', userId);

  const token = await new JwtService().signAsync(
    { sub: userId, email: EMAIL },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  console.log('\n===== 第 1 轮 =====');
  const r1 = await turn(token, '记住：我的代号是阿尔法。只回复"收到"两个字。');
  console.log('  收到事件类型:', r1.seen.join(' → '));
  console.log('  回复:', JSON.stringify(r1.text));

  console.log('\n===== 第 2 轮（验证多轮记忆）=====');
  const r2 = await turn(token, '我的代号是什么？只回答代号本身。', r1.convId);
  console.log('  回复:', JSON.stringify(r2.text));
  console.log('  记忆命中:', r2.text.includes('阿尔法') ? '✅ 是' : '❌ 否');

  console.log('\n===== 第 3 轮（验证工具调用）=====');
  const r3 = await turn(token, '列出我最近的会话列表。', r1.convId);
  console.log('  收到事件类型:', r3.seen.join(' → '));
  const calledTool = r3.seen.includes('tool_call') && r3.seen.includes('tool_result');
  console.log('  工具调用:', calledTool ? '✅ 已触发' : '❌ 未触发');
  console.log('  回复:', JSON.stringify(r3.text.slice(0, 120)));

  // 校验落库
  const msg = await db.query(
    'SELECT role, count(*)::int AS n FROM "Message" WHERE "conversationId" = $1 GROUP BY role ORDER BY role',
    [r1.convId],
  );
  console.log('\n===== 落库 =====');
  console.log('  ', msg.rows.map((r) => `${r.role}=${r.n}`).join(', '));

  // 清理
  await db.query('DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId" = $1)', [userId]);
  await db.query('DELETE FROM "Conversation" WHERE "userId" = $1', [userId]);
  await db.query('DELETE FROM "User" WHERE id = $1', [userId]);
  await db.end();
  console.log('\n[清理完成]');
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
