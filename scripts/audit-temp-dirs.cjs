#!/usr/bin/env node
/**
 * 临时目录审计：找出仓库里堆积的验证/构建残留。
 *
 *   node scripts/audit-temp-dirs.cjs            # 人读的报告
 *   node scripts/audit-temp-dirs.cjs --json     # 机器读
 *   node scripts/audit-temp-dirs.cjs --strict   # 有残留就以非零退出（给 hook / CI 用）
 *
 * **只报告，不删除。** 删除是不可逆动作，交给人确认后在最后一行给的命令上执行。
 *
 * 为什么需要它：这类目录（`.pvN` / `.verify-*-dist`）是 `vite build --outDir`
 * 的产物，写在 `.gitignore` 里所以 `git status` 永远干净 —— 于是一直堆着没人发现。
 * 2026-11-13 清掉过 16 个、31MB，最老的躺了 49 天。
 *
 * ⚠️ 实现上刻意**不做任何截断**（不 head / 不 slice）：上一轮清理就是
 * `find | head -12` 把结果截断了，漏报 4 个目录，删完复查才发现。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** 不往里走的目录：体积大、且与「残留」无关 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.workbuddy', '.turbo']);

/** 残留判定：命中的才算「该删的」 */
const RESIDUE_PATTERNS = [
  { re: /^\.pv\d+$/, why: 'vite build --outDir 的验证产物' },
  { re: /^\.verify.*/, why: '验证构建目录' },
  { re: /^\.tmp.*/, why: '临时输出' },
  { re: /^dist_old/, why: '旧的构建备份' },
];

/** 只提示、不建议删：可能是引擎缓存，删了要重装/重建 */
const CACHE_NAMES = new Set(['.cache', '.parcel-cache', '.rollup.cache']);

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');

/** 递归量体积（KB）。跳过 SKIP_DIRS，避免统计 node_modules */
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // 权限/竞态：跳过，不影响整体判断
    }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isSymbolicLink()) continue; // 软链不跟随，否则可能绕出去
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size;
          files += 1;
        } catch {
          /* 同上 */
        }
      }
    }
  }
  return { bytes, files };
}

/** 是否被 git 忽略（被忽略 = 不会误删用户代码，多一层保险） */
function isIgnored(relPath) {
  try {
    execFileSync('git', ['check-ignore', '-q', relPath], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** 广度优先找候选目录，深度限制 3（够覆盖 frontend/.pv9 这种） */
function collect(maxDepth = 3) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;

      const hit = RESIDUE_PATTERNS.find((p) => p.re.test(entry.name));
      if (hit) {
        const { bytes, files } = dirSize(full);
        const stat = fs.statSync(full);
        found.push({
          path: path.relative(ROOT, full).replace(/\\/g, '/'),
          kind: 'residue',
          why: hit.why,
          bytes,
          mb: +(bytes / 1024 / 1024).toFixed(1),
          files,
          ageDays: Math.floor((Date.now() - stat.mtimeMs) / 86400000),
          ignored: isIgnored(path.relative(ROOT, full)),
        });
        continue; // 命中就不再深入，避免把产物里的子目录也报一遍
      }
      if (CACHE_NAMES.has(entry.name)) {
        const { bytes, files } = dirSize(full);
        found.push({
          path: path.relative(ROOT, full).replace(/\\/g, '/'),
          kind: 'cache',
          why: '缓存目录（重建即可）',
          bytes,
          mb: +(bytes / 1024 / 1024).toFixed(1),
          files,
          ageDays: Math.floor((Date.now() - fs.statSync(full).mtimeMs) / 86400000),
          ignored: isIgnored(path.relative(ROOT, full)),
        });
        continue;
      }
      walk(full, depth + 1);
    }
  };
  walk(ROOT, 1);
  return found;
}

/** 小于 1MB 用 KB 显示：一律 "0MB" 会让人以为是空目录 */
const humanSize = (kb) =>
  kb >= 1024 ? `${(kb / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(kb))}KB`;

const items = collect();
const residue = items.filter((i) => i.kind === 'residue');
const cache = items.filter((i) => i.kind === 'cache');
const totalMb = +(residue.reduce((s, i) => s + i.mb, 0)).toFixed(1);

if (asJson) {
  console.log(JSON.stringify({ root: ROOT, residue, cache, totalMb }, null, 2));
} else if (items.length === 0) {
  console.log('干净：没有临时/验证残留目录。');
} else {
  const pad = (v, n) => String(v).padEnd(n);
  console.log(`仓库：${ROOT}\n`);
  console.log(`${pad('目录', 46)}${pad('体积', 8)}${pad('文件', 6)}${pad('闲置', 6)}忽略`);
  console.log('-'.repeat(78));
  for (const i of [...residue, ...cache]) {
    console.log(
      `${pad(i.path, 46)}${pad(humanSize(i.bytes / 1024), 8)}${pad(i.files, 6)}${pad(i.ageDays + '天', 6)}${
        i.ignored ? '是' : '否'
      }`,
    );
  }
  console.log('-'.repeat(78));
  if (residue.length > 0) {
    const totalKb = residue.reduce((s2, i) => s2 + i.bytes / 1024, 0);
    console.log(`残留 ${residue.length} 个，合计 ${humanSize(totalKb)}（都在 .gitignore 里，git status 看不到）`);
    console.log('\n确认无误后删除（本机 rm -rf 会被 safe-delete 静默拦下，用 find）：');
    const names = residue.map((i) => `'${i.path}'`).join(' ');
    console.log(`  cd ${ROOT} && find ${names} -type f -delete && find ${names} -depth -type d -empty -delete`);
  }
  if (cache.length > 0) {
    console.log(`\n另有 ${cache.length} 个缓存目录：删了不影响正确性，但下次构建会变慢，自行判断。`);
  }
}

if (strict && residue.length > 0) process.exit(1);
