/** 验证笔记移动：子树跟随、移到顶层、环拦截、层级上限、越权 */
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
     VALUES(gen_random_uuid(),$1,'x','m',now(),now()) RETURNING id`, [email]);
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
  return { status: res.status, data: j?.data, msg: j?.msg, raw: j };
};

(async () => {
  const db = new Client({ connectionString: ENV.DATABASE_URL });
  await db.connect();
  const a = await makeUser(db, 'e2e-move-a@wisora.local');
  const b = await makeUser(db, 'e2e-move-b@wisora.local');
  const reqA = api(a.token);
  const reqB = api(b.token);
  const parentOf = async (id) =>
    (await db.query('SELECT "parentId" FROM "Note" WHERE id=$1', [id])).rows[0]?.parentId ?? null;

  const mk = async (title, parentId = null) =>
    (await reqA('POST', '/notes', { title, parentId })).data;

  console.log('--- 准备两棵树 ---');
  // 树 1：P → C → G（三层）
  const P = await mk('项目 P');
  const C = await mk('子 C', P.id);
  const G = await mk('孙 G', C.id);
  // 树 2：X → Y
  const X = await mk('目标 X');
  const Y = await mk('目标子 Y', X.id);
  check('两棵树就绪', [P, C, G, X, Y].every((n) => n?.id));

  console.log('\n--- 1. 把 P（连同 C、G）移到 X 下 ---');
  const moved = await reqA('PATCH', `/notes/${P.id}`, { parentId: X.id });
  check('移动请求成功', moved.status === 200, `status=${moved.status} ${moved.msg ?? ''}`);
  check('P 的新父级是 X', (await parentOf(P.id)) === X.id, String(await parentOf(P.id)));
  check('C 的父级仍是 P（跟着走了）', (await parentOf(C.id)) === P.id);
  check('G 的父级仍是 C（也跟着走了）', (await parentOf(G.id)) === C.id);

  const xDetail = await reqA('GET', `/notes/${X.id}`);
  const xKids = (xDetail.data?.children ?? []).map((k) => k.title).sort();
  check('X 的详情里现在有 P 和 Y', xKids.join(',') === '目标子 Y,项目 P', xKids.join(','));

  console.log('\n--- 2. 环拦截：不能移到自己的后代下 ---');
  const toChild = await reqA('PATCH', `/notes/${P.id}`, { parentId: C.id });
  check('移到自己的子页面下被拒 400', toChild.status === 400, `status=${toChild.status} ${toChild.msg ?? ''}`);
  const toGrand = await reqA('PATCH', `/notes/${P.id}`, { parentId: G.id });
  check('移到自己的孙页面下也被拒 400', toGrand.status === 400, `status=${toGrand.status}`);
  const toSelf = await reqA('PATCH', `/notes/${P.id}`, { parentId: P.id });
  check('移到自己下面被拒 400', toSelf.status === 400, `status=${toSelf.status}`);
  check('被拒后层级未被改动', (await parentOf(P.id)) === X.id && (await parentOf(C.id)) === P.id);

  console.log('\n--- 3. 移到顶层 ---');
  const toRoot = await reqA('PATCH', `/notes/${P.id}`, { parentId: null });
  check('移到顶层成功', toRoot.status === 200, `status=${toRoot.status}`);
  check('P 的 parentId 变为 null', (await parentOf(P.id)) === null, String(await parentOf(P.id)));
  check('子 C 仍挂在 P 下', (await parentOf(C.id)) === P.id);
  check('孙 G 仍挂在 C 下', (await parentOf(G.id)) === C.id);

  console.log('\n--- 4. 层级上限：深子树不能挂到深处 ---');
  // 用 X → Y 继续往下加到第 6 层，再把 P（3 层深）挂到第 5 层
  let deep = Y.id;
  for (let d = 3; d <= 5; d++) {
    const n = await mk(`深层${d}`, deep);
    if (!n?.id) { console.log(`    第 ${d} 层创建失败`); break; }
    deep = n.id;
  }
  const tooDeep = await reqA('PATCH', `/notes/${P.id}`, { parentId: deep });
  check('移动会导致超层被拒 400', tooDeep.status === 400, `status=${tooDeep.status} ${tooDeep.msg ?? ''}`);
  check('被拒后仍在顶层', (await parentOf(P.id)) === null);

  console.log('\n--- 5. 越权 ---');
  const crossUser = await reqB('PATCH', `/notes/${P.id}`, { parentId: X.id });
  check('改他人笔记被拒 404', crossUser.status === 404, `status=${crossUser.status}`);
  const crossTarget = await reqA('PATCH', `/notes/${P.id}`, { parentId: (await reqB('GET', '/notes')).data?.[0]?.id ?? 'x' });
  check('移到他人页面下被拒 404', crossTarget.status === 404, `status=${crossTarget.status}`);

  console.log('\n--- 6. 普通字段更新不受影响 ---');
  const titleOnly = await reqA('PATCH', `/notes/${C.id}`, { title: '改名后的 C' });
  check('只改标题成功', titleOnly.status === 200 && titleOnly.data?.title === '改名后的 C');
  check('只改标题不会动层级', (await parentOf(C.id)) === P.id);

  console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`);

  for (const u of [a, b]) {
    await db.query('DELETE FROM "Note" WHERE "userId"=$1', [u.id]);
    await db.query('DELETE FROM "User" WHERE id=$1', [u.id]);
  }
  await db.end();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('执行失败:', e.message); process.exit(1); });
