/** 验证模型切换：列表接口、切模型后落库的模型、白名单回落 */
const path = require('path');
const fs = require('fs');

const ENV = Object.fromEntries(
  fs.readFileSync('D:/项目/wisora-web/backend/.env', 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const { Client } = require('D:/项目/wisora-web/backend/node_modules/.pnpm/pg@8.23.0/node_modules/pg');
const { JwtService } = require('D:/项目/wisora-web/backend/node_modules/@nestjs/jwt');

const API = 'http://localhost:3000';
const EMAIL = 'e2e-model@wisora.local';

let pass = 0, fail = 0;
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log(`  [通过] ${n}`); }
  else { fail++; console.log(`  [失败] ${n}${extra ? ' -> ' + extra : ''}`); }
};

/** 跑一轮对话，返回实际落库的 conversationId */
async function chat(token, question, model, conversationId) {
  const tr = await fetch(`${API}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowWrite: false }),
  });
  const ticket = (await tr.json())?.data?.ticket;
  const qs = new URLSearchParams({ ticket, q: question });
  if (conversationId) qs.set('conversationId', conversationId);
  if (model) qs.set('model', model);

  const res = await fetch(`${API}/ai/chat/stream?${qs}`, { headers: { Accept: 'text/event-stream' } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', convId = conversationId ?? '', text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i = buf.indexOf('\n\n');
    while (i >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2); i = buf.indexOf('\n\n');
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw.startsWith(':')) continue;
      const ev = JSON.parse(raw);
      if (ev.type === 'start') convId = ev.conversationId;
      if (ev.type === 'token') text += ev.content;
      if (ev.type === 'done') { reader.cancel().catch(() => {}); return { convId, text }; }
      if (ev.type === 'error') throw new Error(ev.message);
    }
  }
  return { convId, text };
}

(async () => {
  const db = new Client({ connectionString: ENV.DATABASE_URL });
  await db.connect();
  await db.query('DELETE FROM "User" WHERE email=$1', [EMAIL]);
  const { rows } = await db.query(
    `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,'x','m',now(),now()) RETURNING id`, [EMAIL]);
  const userId = rows[0].id;
  const token = await new JwtService().signAsync(
    { sub: userId, email: EMAIL }, { secret: ENV.JWT_ACCESS_SECRET, expiresIn: '20m' });

  console.log('--- 1. 模型列表接口 ---');
  const mres = await fetch(`${API}/ai/models`, { headers: { Authorization: `Bearer ${token}` } });
  const mj = await mres.json();
  console.log('    返回:', JSON.stringify(mj?.data));
  check('GET /ai/models 200', mres.ok, `status=${mres.status}`);
  check('options 含两个模型', mj?.data?.options?.length === 2, JSON.stringify(mj?.data?.options));
  check('current 为 deepseek-flash', mj?.data?.current === 'deepseek-flash', String(mj?.data?.current));
  const noAuth = await fetch(`${API}/ai/models`);
  check('未鉴权 401', noAuth.status === 401, `status=${noAuth.status}`);

  console.log('\n--- 2. 默认模型（不传 model）---');
  const c1 = await chat(token, '只回复"好"', undefined);
  const r1 = await db.query('SELECT model FROM "Conversation" WHERE id=$1', [c1.convId]);
  check('会话落库为默认模型 deepseek-flash', r1.rows[0]?.model === 'deepseek-flash', String(r1.rows[0]?.model));

  console.log('\n--- 3. 显式切换到 deepseek-v4-pro ---');
  const c2 = await chat(token, '只回复"好"', 'deepseek-v4-pro');
  const r2 = await db.query('SELECT model FROM "Conversation" WHERE id=$1', [c2.convId]);
  check('新会话落库为 deepseek-v4-pro', r2.rows[0]?.model === 'deepseek-v4-pro', String(r2.rows[0]?.model));

  console.log('\n--- 4. 已有会话中途换模型 ---');
  const before = (await db.query('SELECT model FROM "Conversation" WHERE id=$1', [c2.convId])).rows[0].model;
  await chat(token, '只回复"好"', 'deepseek-flash', c2.convId);
  const after = (await db.query('SELECT model FROM "Conversation" WHERE id=$1', [c2.convId])).rows[0].model;
  check('同一会话模型被更新', before === 'deepseek-v4-pro' && after === 'deepseek-flash', `${before} -> ${after}`);

  console.log('\n--- 5. 白名单校验（塞一个不存在的模型）---');
  const c3 = await chat(token, '只回复"好"', 'gpt-4o-不存在');
  const r3 = await db.query('SELECT model FROM "Conversation" WHERE id=$1', [c3.convId]);
  check('非法模型回落为默认', r3.rows[0]?.model === 'deepseek-flash', String(r3.rows[0]?.model));

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);

  await db.query('DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId"=$1)', [userId]);
  await db.query('DELETE FROM "Conversation" WHERE "userId"=$1', [userId]);
  await db.query('DELETE FROM "User" WHERE id=$1', [userId]);
  await db.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('执行失败:', e.message); process.exit(1); });
