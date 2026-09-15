/**
 * 笔记模块全链路真机验证。
 *
 * 覆盖：建笔记 → 改笔记 → 列表 → 上传 PDF → 读回二进制 → 越权校验 → 删除。
 * 不依赖 Prisma 客户端（直连 PG 建测试用户 + 自签 JWT），
 * 与 verify-agent-live.cjs 同一套路。
 */
require('dotenv/config');
const path = require('path');
const { Client } = require(path.join(
  __dirname, '../node_modules/.pnpm/pg@8.23.0/node_modules/pg',
));
const { JwtService } = require('@nestjs/jwt');

const BASE = 'http://localhost:3000';
const EMAIL_A = 'e2e-notes-a@wisora.local';
const EMAIL_B = 'e2e-notes-b@wisora.local';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  [通过] ${name}`); }
  else { fail++; console.log(`  [失败] ${name}${extra ? ' -> ' + extra : ''}`); }
}

/** 构造一个最小但合法的 PDF，用于测试上传 */
function makePdf(text) {
  const body = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj
4 0 obj<</Length ${text.length + 40}>>stream
BT /F1 12 Tf 20 50 Td (${text}) Tj ET
endstream
endobj
trailer<</Root 1 0 R>>`;
  return Buffer.from(body, 'latin1');
}

async function api(token, method, url, body, isForm) {
  const headers = { Authorization: `Bearer ${token}` };
  if (!isForm && body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') ?? '';
  const data = ct.includes('application/json') ? await res.json() : null;
  return { status: res.status, json: data, raw: res };
}

async function ensureUser(db, email) {
  await db.query('DELETE FROM "User" WHERE email = $1', [email]);
  const { rows } = await db.query(
    `INSERT INTO "User" (id, email, password, nickname, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, 'x', 'e2e', now(), now()) RETURNING id`,
    [email],
  );
  const jwt = new JwtService();
  const token = await jwt.signAsync(
    { sub: rows[0].id, email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
  );
  return { id: rows[0].id, token };
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();

  const a = await ensureUser(db, EMAIL_A);
  const b = await ensureUser(db, EMAIL_B);
  console.log('用户 A:', a.id, '\n用户 B:', b.id, '\n');

  console.log('--- 1. 新建笔记 ---');
  const created = await api(a.token, 'POST', '/notes', { title: '第一篇', content: '# 标题' });
  check('POST /notes 返回 200', created.status === 200 || created.status === 201, `status=${created.status}`);
  const noteId = created.json?.data?.id;
  check('返回笔记 id', !!noteId, JSON.stringify(created.json));
  if (!noteId) throw new Error('后续测试依赖 noteId');

  console.log('\n--- 2. 更新笔记 ---');
  const updated = await api(a.token, 'PATCH', `/notes/${noteId}`, {
    content: '# 标题\n\n改过的正文',
    pinned: true,
  });
  check('PATCH 成功', updated.status === 200, `status=${updated.status}`);
  check('正文已更新', updated.json?.data?.content?.includes('改过的正文'));
  check('置顶已生效', updated.json?.data?.pinned === true);

  console.log('\n--- 3. 列表与搜索 ---');
  const list = await api(a.token, 'GET', '/notes');
  check('列表中能找到该笔记', list.json?.data?.some((n) => n.id === noteId));
  check('列表不返回正文', list.json?.data?.[0]?.content === undefined);
  const search = await api(a.token, 'GET', '/notes?keyword=改过的正文');
  check('按正文关键词可搜到', search.json?.data?.some((n) => n.id === noteId));

  console.log('\n--- 4. 上传 PDF 附件 ---');
  const pdf = makePdf('hello wisora');
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), '测试文档.pdf');
  const up = await api(a.token, 'POST', `/attachments?noteId=${noteId}`, form, true);
  check('上传成功', up.status === 200 || up.status === 201, `status=${up.status} ${JSON.stringify(up.json)}`);
  const attId = up.json?.data?.id;
  check('返回附件 id 与原始文件名', !!attId && up.json?.data?.filename === '测试文档.pdf');
  check('记录字节数一致', up.json?.data?.size === pdf.length);

  console.log('\n--- 5. 读回附件内容 ---');
  const content = await api(a.token, 'GET', `/attachments/${attId}/content`);
  check('读取成功', content.status === 200, `status=${content.status}`);
  check('Content-Type 为 pdf', content.raw.headers.get('content-type')?.includes('pdf'));
  check('Content-Disposition 为 inline', content.raw.headers.get('content-disposition')?.includes('inline'));
  const buf = Buffer.from(await content.raw.arrayBuffer());
  check('二进制内容与上传一致', buf.equals(pdf), `${buf.length} vs ${pdf.length}`);

  console.log('\n--- 6. 越权防护（用户 B 访问 A 的资源）---');
  const stealNote = await api(b.token, 'GET', `/notes/${noteId}`);
  check('他人笔记返回 404', stealNote.status === 404, `status=${stealNote.status}`);
  const stealAtt = await api(b.token, 'GET', `/attachments/${attId}/content`);
  check('他人附件返回 404', stealAtt.status === 404, `status=${stealAtt.status}`);
  const renameOther = await api(b.token, 'PATCH', `/notes/${noteId}`, { title: '篡改' });
  check('改他人笔记返回 404', renameOther.status === 404, `status=${renameOther.status}`);

  console.log('\n--- 7. 未鉴权访问 ---');
  const noAuth = await fetch(`${BASE}/notes`);
  check('无令牌返回 401', noAuth.status === 401, `status=${noAuth.status}`);

  console.log('\n--- 8. 附件类型白名单 ---');
  const badForm = new FormData();
  badForm.append('file', new Blob([Buffer.from('<script>')], { type: 'text/html' }), 'x.html');
  const bad = await api(a.token, 'POST', `/attachments?noteId=${noteId}`, badForm, true);
  check('html 被拒绝 400', bad.status === 400, `status=${bad.status}`);

  console.log('\n--- 9. 删除附件与笔记 ---');
  const delAtt = await api(a.token, 'DELETE', `/attachments/${attId}`);
  check('删附件成功', delAtt.status === 200, `status=${delAtt.status}`);
  const delNote = await api(a.token, 'DELETE', `/notes/${noteId}`);
  check('删笔记成功', delNote.status === 200, `status=${delNote.status}`);
  const afterDelete = await api(a.token, 'GET', `/notes/${noteId}`);
  check('软删除后不可读', afterDelete.status === 404, `status=${afterDelete.status}`);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  for (const u of [a, b]) {
    await db.query('DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId" = $1)', [u.id]);
    await db.query('DELETE FROM "Conversation" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "Note" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "Attachment" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "User" WHERE id = $1', [u.id]);
  }
  await db.end();
  console.log('[清理完成]');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('执行失败:', e.message); process.exit(1); });
