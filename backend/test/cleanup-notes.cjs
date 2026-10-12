/**
 * 笔记数据卫生清理：空壳 + 内容完全重复
 *
 * 默认 dry-run，只列候选不动数据。加 --apply 才执行，且执行前会导出完整备份。
 * 一律用软删除（写 deletedAt），不物理删除 —— 随时可恢复。
 *
 * 用法：
 *   node test/cleanup-notes.cjs            # 只看候选
 *   node test/cleanup-notes.cjs --apply    # 备份 + 软删除
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
const APPLY = process.argv.includes('--apply');

/** 空壳阈值：正文（trim 后）少于这个字数就算空壳 */
const EMPTY_THRESHOLD = 20;

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
const fmt = (d) => new Date(d).toISOString().slice(0, 16).replace('T', ' ');

(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();

  const alive = (
    await c.query(
      `select id, "userId", title, content, "parentId", "createdAt"
         from "Note" where "deletedAt" is null order by "createdAt" asc`,
    )
  ).rows;

  const reasons = new Map(); // id -> 原因

  // 规则 1：空壳
  for (const n of alive) {
    if (n.content.trim().length < EMPTY_THRESHOLD) {
      reasons.set(n.id, `空壳（正文 ${n.content.trim().length} 字）`);
    }
  }

  // 规则 2：内容完全重复 —— 每组保留 1 篇
  // 保留优先级：顶级页面（parentId 为 null）> 创建更早
  const groups = new Map();
  for (const n of alive) {
    const k = crypto.createHash('sha1').update(n.content.trim()).digest('hex');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(n);
  }
  for (const [, list] of groups) {
    if (list.length < 2) continue;
    const keep = [...list].sort((a, b) => {
      const ta = a.parentId ? 1 : 0;
      const tb = b.parentId ? 1 : 0;
      if (ta !== tb) return ta - tb; // 顶级优先（0 排前面）
      return a.createdAt - b.createdAt;
    })[0];
    for (const n of list) {
      if (n.id === keep.id) continue;
      // 空壳原因优先显示（更具体）
      if (!reasons.has(n.id)) {
        reasons.set(n.id, `与「${mask(keep.title).slice(0, 20)}」内容完全相同（保留 ${keep.id.slice(0, 12)}…）`);
      }
    }
  }

  const targets = alive.filter((n) => reasons.has(n.id));
  const survivors = alive.filter((n) => !reasons.has(n.id));

  console.log(`可见笔记 ${alive.length} 篇 → 待清理 ${targets.length} 篇，保留 ${survivors.length} 篇\n`);

  console.log('===== 待清理 =====');
  for (const n of targets) {
    console.log(
      `  ${n.id}\n     「${mask(n.title).slice(0, 34)}」${n.content.length} 字 · ${n.parentId ? '子页面' : '顶级'} · ${fmt(n.createdAt)}`,
    );
    console.log(`     原因：${reasons.get(n.id)}`);
  }

  console.log('\n===== 保留 =====');
  for (const n of survivors) {
    console.log(
      `  ${n.id}  「${mask(n.title).slice(0, 34)}」${n.content.length} 字 · ${n.parentId ? '子页面' : '顶级'}`,
    );
  }

  if (!APPLY) {
    console.log('\n（dry-run，未改动任何数据。加 --apply 执行）');
    await c.end();
    return;
  }

  // ---------- 备份 ----------
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    process.env.TEMP || process.env.TMP || __dirname,
    `wisora-notes-backup-${stamp}.json`,
  );
  fs.writeFileSync(backupPath, JSON.stringify(targets, null, 2), 'utf8');
  console.log(`\n✅ 已备份 ${targets.length} 篇到：${backupPath}`);

  // ---------- 软删除 ----------
  const ids = targets.map((n) => n.id);
  const r = await c.query(
    'update "Note" set "deletedAt" = now(), "updatedAt" = now() where id = any($1::text[]) and "deletedAt" is null',
    [ids],
  );
  console.log(`✅ 已软删除 ${r.rowCount} 篇`);

  const after = await c.query('select count(*)::int as n from "Note" where "deletedAt" is null');
  console.log(`复核：剩余可见笔记 ${after.rows[0].n} 篇`);

  await c.end();
})();
