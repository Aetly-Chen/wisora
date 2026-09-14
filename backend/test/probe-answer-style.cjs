/**
 * 探测模型回答风格：问两个问题，打印回复。
 * 用于对比系统提示词 / temperature 改动前后的效果。
 */
require('dotenv/config');
const path = require('path');
const { Client } = require(path.join(
  __dirname, '../node_modules/.pnpm/pg@8.23.0/node_modules/pg',
));
const { JwtService } = require('@nestjs/jwt');

const BASE = 'http://localhost:3000';
const EMAIL = 'e2e-style-probe@wisora.local';

async function ask(token, question, conversationId) {
  const tr = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowWrite: false }),
  });
  const ticket = (await tr.json())?.data?.ticket;
  if (!ticket) throw new Error('换票失败');

  const qs = new URLSearchParams({ ticket, q: question });
  if (conversationId) qs.set('conversationId', conversationId);

  const res = await fetch(`${BASE}/ai/chat/stream?${qs}`, {
    headers: { Accept: 'text/event-stream' },
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', convId = conversationId ?? '', hasTool = false;

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
      const ev = JSON.parse(raw);
      if (ev.type === 'start') convId = ev.conversationId;
      if (ev.type === 'token') text += ev.content;
      if (ev.type === 'tool_call') hasTool = true;
      if (ev.type === 'done') { reader.cancel().catch(() => {}); return { text, convId, hasTool }; }
      if (ev.type === 'error') throw new Error(ev.message);
    }
  }
  return { text, convId, hasTool };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();
  await db.query('DELETE FROM "User" WHERE email = $1', [EMAIL]);
  const { rows } = await db.query(
    `INSERT INTO "User" (id, email, password, nickname, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'x', 'probe', now(), now()) RETURNING id`,
    [EMAIL],
  );
  const userId = rows[0].id;
  const token = await new JwtService().signAsync(
    { sub: userId, email: EMAIL },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  const qs = [
    '你是什么模型',
    '你能做什么',
  ];
  let convId;
  for (const q of qs) {
    const r = await ask(token, q, convId);
    convId = r.convId;
    console.log(`\n【问】${q}`);
    console.log(`【答】${r.text.trim()}`);
    console.log(`【工具调用】${r.hasTool ? '有' : '无'}`);
  }

  await db.query('DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId" = $1)', [userId]);
  await db.query('DELETE FROM "Conversation" WHERE "userId" = $1', [userId]);
  await db.query('DELETE FROM "User" WHERE id = $1', [userId]);
  await db.end();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
