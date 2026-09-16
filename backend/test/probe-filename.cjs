require('dotenv/config');
const path = require('path');
const { Client } = require(path.join(
  __dirname, '../node_modules/.pnpm/pg@8.23.0/node_modules/pg',
));
const { JwtService } = require('@nestjs/jwt');

const BASE = 'http://localhost:3000';

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();
  const email = 'e2e-name@wisora.local';
  await db.query('DELETE FROM "User" WHERE email=$1', [email]);
  const { rows } = await db.query(
    `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,'x','e',now(),now()) RETURNING id`,
    [email],
  );
  const token = await new JwtService().signAsync(
    { sub: rows[0].id, email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );

  const noteRes = await fetch(`${BASE}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'n' }),
  });
  const noteId = (await noteRes.json()).data.id;

  const pdf = Buffer.from('%PDF-1.4\ntrailer<</Root 1 0 R>>');
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), '测试文档.pdf');

  const r = await fetch(`${BASE}/attachments?noteId=${noteId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const j = await r.json();
  const fn = j?.data?.filename;

  console.log('返回 filename:', JSON.stringify(fn));
  console.log('字符码:', fn ? [...fn].map((c) => c.charCodeAt(0).toString(16)).join(' ') : '(空)');
  console.log('等于 "测试文档.pdf":', fn === '测试文档.pdf');
  console.log('ASCII 名测试:');

  const form2 = new FormData();
  form2.append('file', new Blob([pdf], { type: 'application/pdf' }), 'plain.pdf');
  const r2 = await fetch(`${BASE}/attachments?noteId=${noteId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form2,
  });
  console.log('  ', JSON.stringify((await r2.json()).data.filename));

  await db.query('DELETE FROM "Note" WHERE "userId"=$1', [rows[0].id]);
  await db.query('DELETE FROM "Attachment" WHERE "userId"=$1', [rows[0].id]);
  await db.query('DELETE FROM "User" WHERE id=$1', [rows[0].id]);
  await db.end();
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
