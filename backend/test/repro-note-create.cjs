/** 复现「新建笔记报错」：确认创建接口返回体缺 attachments 字段 */
const fs = require('fs');
const path = require('path');

const ENV = Object.fromEntries(
  fs.readFileSync('D:/项目/wisora-web/backend/.env', 'utf8')
    .split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
);
const { Client } = require('D:/项目/wisora-web/backend/node_modules/.pnpm/pg@8.23.0/node_modules/pg');
const { JwtService } = require('D:/项目/wisora-web/backend/node_modules/@nestjs/jwt');

const API = 'http://localhost:3000';
const EMAIL = 'e2e-repro@wisora.local';

(async () => {
  const db = new Client({ connectionString: ENV.DATABASE_URL });
  await db.connect();
  await db.query('DELETE FROM "User" WHERE email=$1', [EMAIL]);
  const { rows } = await db.query(
    `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,'x','r',now(),now()) RETURNING id`, [EMAIL]);
  const token = await new JwtService().signAsync(
    { sub: rows[0].id, email: EMAIL }, { secret: ENV.JWT_ACCESS_SECRET, expiresIn: '15m' });
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const created = await (await fetch(`${API}/notes`, { method: 'POST', headers: H, body: JSON.stringify({ title: '新笔记' }) })).json();
  const d = created.data;
  console.log('POST /notes 返回的字段:', Object.keys(d).join(', '));
  console.log('有 attachments 吗:', 'attachments' in d, '| 值:', JSON.stringify(d.attachments));
  console.log();
  console.log('=> 前端 NoteDetail 类型要求 attachments: AttachmentMeta[]（必填）');
  console.log('=> 页面会执行 attachments.length，值为 undefined 时抛错');
  try {
    const undefinedLike = d.attachments;
    console.log('   模拟 attachments.length ->', undefinedLike.length);
  } catch (e) {
    console.log('   ✗ 复现成功:', e.constructor.name + ': ' + e.message);
  }

  const updated = await (await fetch(`${API}/notes/${d.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ content: 'x' }) })).json();
  console.log();
  console.log('PATCH /notes/:id 返回的字段:', Object.keys(updated.data).join(', '));
  console.log('有 attachments 吗:', 'attachments' in updated.data);

  const detail = await (await fetch(`${API}/notes/${d.id}`, { headers: H })).json();
  console.log();
  console.log('GET /notes/:id 返回的字段:', Object.keys(detail.data).join(', '), '（对比：详情接口是有的）');

  await db.query('DELETE FROM "Note" WHERE "userId"=$1', [rows[0].id]);
  await db.query('DELETE FROM "User" WHERE id=$1', [rows[0].id]);
  await db.end();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
