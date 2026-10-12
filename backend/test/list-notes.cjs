/**
 * 列出全部笔记（含层级、时间、内容指纹），用于人工判断哪些该清理。
 * 只读，不改任何数据。
 *
 * 用法：cd backend && node test/list-notes.cjs
 *      加 --json 输出机器可读格式到 stdout 便于后续比对
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  const base = path.join(__dirname, '..', 'node_modules', '.pnpm');
  const dir = fs.readdirSync(base).find((d) => /^pg@\d/.test(d));
  ({ Client } = require(path.join(base, dir, 'node_modules', 'pg')));
}

const mask = (s) =>
  s.replace(/1[3-9]\d{9}/g, '1**********').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');

(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();

  const all = (
    await c.query(
      `select id, "userId", title, content, "parentId", "pinned",
              "createdAt", "updatedAt", "deletedAt"
         from "Note"
        order by "createdAt" asc`,
    )
  ).rows;

  const alive = all.filter((r) => !r.deletedAt);
  const gone = all.filter((r) => r.deletedAt);

  console.log(`全部笔记 ${all.length} 篇（可见 ${alive.length} / 已软删 ${gone.length}）\n`);

  // 内容指纹（trim 后），用于识别完全重复
  const fp = new Map();
  for (const n of alive) {
    const k = crypto.createHash('sha1').update(n.content.trim()).digest('hex').slice(0, 8);
    n._fp = k;
    if (!fp.has(k)) fp.set(k, []);
    fp.get(k).push(n);
  }

  const order = [...alive].sort((a, b) => a.createdAt - b.createdAt);
  console.log(
    '序号  字数   指纹     创建时间            父页面  标题',
  );
  console.log('─'.repeat(100));
  order.forEach((n, i) => {
    const t = new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const par = n.parentId ? '  子  ' : '  顶  ';
    console.log(
      `${String(i + 1).padStart(3)}  ${String(n.content.length).padStart(5)}  ${n._fp}  ${t}  ${par}  ${mask(n.title).slice(0, 46)}`,
    );
  });

  console.log('\n===== 内容完全重复的组 =====');
  let dupCount = 0;
  for (const [k, list] of fp) {
    if (list.length < 2) continue;
    dupCount += list.length - 1;
    console.log(`\n指纹 ${k}（${list.length} 篇，内容 ${list[0].content.length} 字）:`);
    for (const n of list) {
      console.log(
        `   ${n.id}  创建 ${new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ')}  ` +
          `${n.parentId ? '子页面(父=' + n.parentId.slice(0, 8) + '…)' : '顶级页面'}  「${mask(n.title).slice(0, 30)}」`,
      );
    }
  }
  console.log(`\n可清理的重复：${dupCount} 篇`);

  console.log('\n===== 空壳笔记（内容 <30 字）=====');
  const empty = alive.filter((n) => n.content.trim().length < 30);
  for (const n of empty) {
    console.log(
      `   ${n.id}  字数 ${String(n.content.length).padStart(4)}  ` +
        `${n.parentId ? '子页面' : '顶级'}  「${mask(n.title).slice(0, 30)}」  内容=${JSON.stringify(mask(n.content).slice(0, 30))}`,
    );
  }
  console.log(`\n空壳笔记：${empty.length} 篇`);

  await c.end();
})();
