/** 验证笔记层级：父/子页面、子页面摘要、子树软删除、层级上限、越权 */
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
let pass = 0, fail = 0;
const check = (n, ok, extra) => {
  if (ok) { pass++; console.log(`  [通过] ${n}`); }
  else { fail++; console.log(`  [失败] ${n}${extra ? ' -> ' + extra : ''}`); }
};

async function makeUser(db, email) {
  await db.query('DELETE FROM "User" WHERE email=$1', [email]);
  const { rows } = await db.query(
    `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,'x','t',now(),now()) RETURNING id`, [email]);
  const token = await new JwtService().signAsync(
    { sub: rows[0].id, email }, { secret: ENV.JWT_ACCESS_SECRET, expiresIn: '20m' });
  return { id: rows[0].id, token };
}

const api = (token) => async (method, url, body) => {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => null);
  return { status: res.status, data: j?.data, raw: j };
};

(async () => {
  const db = new Client({ connectionString: ENV.DATABASE_URL });
  await db.connect();
  const a = await makeUser(db, 'e2e-tree-a@wisora.local');
  const b = await makeUser(db, 'e2e-tree-b@wisora.local');
  const reqA = api(a.token);
  const reqB = api(b.token);

  console.log('--- 1. 建父页面 ---');
  /** 记录这棵树里创建过的所有节点，删除时按实际数量断言（不手算层数） */
  const treeIds = [];
  const track = (r) => { if (r.data?.id) treeIds.push(r.data.id); return r; };

  const root = track(await reqA('POST', '/notes', { title: '产品文档', content: '' }));
  check('建顶层页面成功', root.status === 201 || root.status === 200, `status=${root.status}`);
  check('parentId 为 null', root.data?.parentId === null, String(root.data?.parentId));
  check('新笔记带空的 children', Array.isArray(root.data?.children) && root.data.children.length === 0);
  const rootId = root.data.id;

  console.log('\n--- 2. 在其下建子页面 ---');
  const child1 = track(await reqA('POST', '/notes', { title: '子页面一', parentId: rootId }));
  const child2 = track(await reqA('POST', '/notes', { title: '子页面二', parentId: rootId }));
  check('建子页面成功', child1.status === 201 || child1.status === 200, `status=${child1.status}`);
  check('parentId 正确指向父页面', child1.data?.parentId === rootId, String(child1.data?.parentId));

  console.log('\n--- 3. 详情返回子页面摘要 ---');
  const detail = await reqA('GET', `/notes/${rootId}`);
  const kids = detail.data?.children ?? [];
  check('children 含两个子页面', kids.length === 2, `count=${kids.length}`);
  check('子页面含 id/title', kids.every((k) => k.id && typeof k.title === 'string'));
  check('列表接口也返回 parentId', (await reqA('GET', '/notes')).data?.some((n) => n.parentId === rootId));

  console.log('\n--- 4. 孙页面（子页面同样可以有子页面）---');
  const grand = track(await reqA('POST', '/notes', { title: '孙页面', parentId: child1.data.id }));
  check('孙页面创建成功', grand.data?.parentId === child1.data.id, String(grand.data?.parentId));
  const child1Detail = await reqA('GET', `/notes/${child1.data.id}`);
  check('子页面详情里能看到孙页面', child1Detail.data?.children?.some((c) => c.id === grand.data.id));

  console.log('\n--- 5. 层级上限 ---');
  // 当前：root(1) → child1(2) → grand(3)，再往下建到第 6 层应成功，第 7 层应被拒
  let currentId = grand.data.id;
  let lastOk = true;
  for (let depth = 4; depth <= 6; depth++) {
    const r = track(await reqA('POST', '/notes', { title: `第${depth}层`, parentId: currentId }));
    lastOk = r.status === 201 || r.status === 200;
    if (!lastOk) { console.log(`    第 ${depth} 层就失败了:`, r.raw?.message); break; }
    currentId = r.data.id;
  }
  check('第 6 层仍可创建', lastOk);
  const tooDeep = await reqA('POST', '/notes', { title: '第7层', parentId: currentId });
  check('第 7 层被拒 400', tooDeep.status === 400, `status=${tooDeep.status}`);

  console.log('\n--- 6. 越权：把子页面挂到别人的笔记下 ---');
  const cross = await reqB('POST', '/notes', { title: '偷挂', parentId: rootId });
  check('挂到他人页面被拒 404', cross.status === 404, `status=${cross.status}`);
  const fake = await reqA('POST', '/notes', { title: '不存在的父', parentId: 'nonexistent-id-xxx' });
  check('父页面不存在被拒 404', fake.status === 404, `status=${fake.status}`);

  console.log('\n--- 7. 删除父页面 = 整棵子树软删除 ---');
  const beforeCount = (await reqA('GET', '/notes')).data.length;
  const del = await reqA('DELETE', `/notes/${rootId}`);
  check('删除成功', del.status === 200, `status=${del.status}`);
  console.log(`    该子树实际节点数: ${treeIds.length}`);
  check('返回受影响数量 = 整棵子树节点数', del.data?.count === treeIds.length, `count=${del.data?.count} 期望 ${treeIds.length}`);
  const afterList = (await reqA('GET', '/notes')).data;
  check('列表中已无该子树的任何节点', afterList.length === beforeCount - treeIds.length, `${beforeCount} -> ${afterList.length}`);
  const orphan = await reqA('GET', `/notes/${grand.data.id}`);
  check('孙页面也一并不可访问', orphan.status === 404, `status=${orphan.status}`);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);

  for (const u of [a, b]) {
    await db.query('DELETE FROM "Note" WHERE "userId"=$1', [u.id]);
    await db.query('DELETE FROM "User" WHERE id=$1', [u.id]);
  }
  await db.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('执行失败:', e.message); process.exit(1); });
