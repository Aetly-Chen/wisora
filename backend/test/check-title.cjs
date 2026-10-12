const fs = require('fs');
const path = require('path');
function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}
const env = loadEnv();
let Client;
try { ({ Client } = require('pg')); } catch {
  const base = path.join(__dirname, '..', 'node_modules', '.pnpm');
  const dir = fs.readdirSync(base).find((d) => /^pg@\d/.test(d));
  ({ Client } = require(path.join(base, dir, 'node_modules', 'pg')));
}
(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();
  const r = await c.query(
    `select id, title, length(title) as tlen, left(content, 60) as head, length(content) as clen
       from "Note" where "deletedAt" is null order by length(title) desc limit 3`,
  );
  for (const n of r.rows) {
    console.log(`\nid=${n.id}`);
    console.log(`  标题长度 ${n.tlen}（MAX_TITLE_LENGTH=80）`);
    console.log(`  标题全文：${n.title}`);
    console.log(`  正文字数 ${n.clen}，正文开头：${JSON.stringify(n.head)}`);
    console.log(`  正文是否以该标题开头：${n.head.startsWith(n.title.slice(0, 30)) ? '是 ← 标题是正文的前缀' : '否'}`);
  }
  await c.end();
})();
