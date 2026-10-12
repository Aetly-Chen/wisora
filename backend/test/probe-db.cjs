// 数据库探活 + 笔记规模统计
const fs = require('fs');
const path = require('path');

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
const url = process.env.DATABASE_URL || env.DATABASE_URL;

// pnpm 只把 pg 装在 .pnpm 里、顶层没链接，所以动态找一下（不改动 node_modules）
let Client;
try {
  ({ Client } = require('pg'));
} catch {
  const base = path.join(__dirname, '..', 'node_modules', '.pnpm');
  const dir = fs.readdirSync(base).find((d) => /^pg@\d/.test(d));
  if (!dir) throw new Error('没找到 pg，检查 @prisma/adapter-pg 是否已安装');
  ({ Client } = require(path.join(base, dir, 'node_modules', 'pg')));
}

(async () => {
  const c = new Client({ connectionString: url });
  await c.connect();
  console.log('✅ 数据库连接成功');

  const ver = await c.query('select version()');
  console.log('版本:', ver.rows[0].version.split(',')[0]);

  const cfg = await c.query('select current_setting($1) as d', ['data_directory']);
  const lcfg = await c.query('select current_setting($1) as f', ['config_file']);
  console.log('数据目录:', cfg.rows[0].d);
  console.log('配置文件:', lcfg.rows[0].f);

  const ext2 = await c.query('select extname from pg_extension order by extname');
  console.log('已启用扩展:', ext2.rows.map((r) => r.extname).join(', ') || '(无)');

  const ext = await c.query(
    "select name, default_version, installed_version from pg_available_extensions where name in ('vector','pg_trgm','zhparser','pg_jieba') order by name",
  );
  console.log('\n可用扩展:', ext.rows.length ? '' : '(无)');
  for (const r of ext.rows) {
    console.log(`  ${r.name.padEnd(10)} 可装 ${r.default_version || '-'} | 已装 ${r.installed_version || '否'}`);
  }

  const notes = await c.query(
    'select id, title, length(content) as len, "parentId" from "Note" where "deletedAt" is null order by length(content) desc',
  );
  const totalChars = notes.rows.reduce((s, r) => s + r.len, 0);
  console.log(`\n可见笔记: ${notes.rows.length} 篇，正文合计 ${totalChars} 字`);
  console.log('最长的 8 篇：');
  for (const r of notes.rows.slice(0, 8)) {
    console.log(`  ${String(r.len).padStart(6)} 字  ${r.title}${r.parentId ? '  (子页面)' : ''}`);
  }

  const long = notes.rows.filter((r) => r.len > 150).slice(0, 3);
  for (const n of long) {
    const full = await c.query('select title, content from "Note" where id = $1', [n.id]);
    console.log('\n' + '='.repeat(70));
    console.log('###', full.rows[0].title);
    console.log(full.rows[0].content.slice(0, 700));
    console.log('   ...[截断]');
  }

  await c.end();
})();