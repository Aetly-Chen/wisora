#!/usr/bin/env node
/**
 * 文档计数漂移审计
 *
 * 用途：`docs/wisora-代码逐文件详解.md` 的头部与目录树里写了大量「N 个文件 / N 张表」，
 * 每次大改代码后这些数字都会漂。这个脚本拿**实际文件系统**去核对，把不一致的全列出来。
 *
 * 背景：2026-10-13 那次审计发现 6 处漂移（common 8→10、chat 11→14、test 25→29、
 * components 23→21、docs 5→8、五份文档体积全变），全是手写数字跟不上代码导致。
 * 与其每次人肉数，不如让脚本数 —— 数错了它会说。
 *
 * 用法：
 *   node backend/test/audit-doc.cjs
 *
 * 零依赖（只用 fs / path），前后端都没起也能跑。
 *
 * ⚠️ 自指陷阱：这个脚本自己就在 `backend/test/` 下，所以「test 目录文件数」的
 *    期望值会随它自身增减而变。把它加进来那天起 +1 —— 这是正常的，不是 bug。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..'); // wisora-web/
const DOC = path.join(ROOT, 'docs', 'wisora-代码逐文件详解.md');

if (!fs.existsSync(DOC)) {
  console.error('找不到文档：' + DOC);
  process.exit(1);
}
const doc = fs.readFileSync(DOC, 'utf8');

/** 数文件 */
function countFiles(dir, opts) {
  opts = opts || {};
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return -1;
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (opts.excludeDir && opts.excludeDir.test(e.name)) continue;
        walk(p);
      } else {
        if (opts.onlyExt && !opts.onlyExt.test(e.name)) continue;
        if (opts.excludeFile && opts.excludeFile.test(e.name)) continue;
        n++;
      }
    }
  };
  walk(abs);
  return n;
}

/** 各域「业务文件数」口径：排除 .spec.ts / README.md / .gitkeep */
const BIZ = { excludeFile: /\.spec\.ts$|^README\.md$|^\.gitkeep$/ };

// 每条：key（显示名）/ actual（实际值）/ pattern（在文档里精确抓数字的正则，需带一个捕获组）
const checks = [
  { key: 'backend/src 手写 .ts', actual: countFiles('backend/src', { onlyExt: /\.ts$/, excludeDir: /^generated$/ }),
    pattern: /(\d+)\s*个手写/ },
  { key: 'backend/src/generated', actual: countFiles('backend/src/generated'),
    pattern: /另有\s*(\d+)\s*个\s*Prisma 生成/ },
  { key: 'frontend/src (.ts/.tsx)', actual: countFiles('frontend/src', { onlyExt: /\.tsx?$/ }),
    pattern: /frontend\/src`\s*下\s*\*\*(\d+)\s*个/ },
  { key: 'common 业务', actual: countFiles('backend/src/common', BIZ),
    pattern: /common\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'user 业务', actual: countFiles('backend/src/user', BIZ),
    pattern: /user\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'notes 业务', actual: countFiles('backend/src/notes', BIZ),
    pattern: /notes\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'chat 业务', actual: countFiles('backend/src/chat', BIZ),
    pattern: /chat\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'ai 业务', actual: countFiles('backend/src/ai', BIZ),
    pattern: /ai\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'rag 业务', actual: countFiles('backend/src/rag', BIZ),
    pattern: /rag\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'test 全部文件', actual: countFiles('backend/test'),
    pattern: /test\/\s+←\s*(\d+)\s*个验证文件/ },
  { key: 'components 业务', actual: countFiles('frontend/src/components', { excludeDir: /^ui$/ }),
    pattern: /components\/\s+←\s*(\d+)\s*个业务组件/ },
  { key: 'components/ui', actual: countFiles('frontend/src/components/ui'),
    pattern: /个业务组件\s*\+\s*(\d+)\s*个\s*shadcn/ },
  { key: 'request', actual: countFiles('frontend/src/request'),
    pattern: /request\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'stores', actual: countFiles('frontend/src/stores'),
    pattern: /stores\/\s+←[^（(]*[（(](\d+)\s*文件/ },
  { key: 'docs/*.md', actual: countFiles('docs', { onlyExt: /\.md$/ }),
    pattern: /docs\/\s+←\s*(\d+)\s*份\s*md/ },
];

const schema = fs.readFileSync(path.join(ROOT, 'backend/prisma/schema.prisma'), 'utf8');
checks.push({ key: 'schema.prisma model', actual: (schema.match(/^model /gm) || []).length,
  pattern: /共\s*(\d+)\s*个\s*model/ });
checks.push({ key: 'schema.prisma enum', actual: (schema.match(/^enum /gm) || []).length,
  pattern: /(\d+)\s*个\s*enum/ });

console.log('═'.repeat(68));
console.log('文档计数审计  →  docs/wisora-代码逐文件详解.md');
console.log('═'.repeat(68));

let bad = 0, missing = 0;
for (const c of checks) {
  const m = doc.match(c.pattern);
  const claimed = m ? Number(m[1]) : null;
  const ok = claimed !== null && claimed === c.actual;
  if (claimed === null) missing++;
  else if (!ok) bad++;
  const mark = claimed === null ? '  ?  ' : ok ? '  OK ' : ' !!  ';
  console.log(mark + c.key.padEnd(28) + ' 文档: ' + String(claimed ?? '—').padStart(4) +
    '   实际: ' + String(c.actual).padStart(4));
}

console.log('─'.repeat(68));
if (bad === 0 && missing === 0) console.log('✅ 全部一致');
else console.log('❌ ' + bad + ' 处不一致' + (missing ? '，' + missing + ' 处未匹配到（可能措辞变了）' : ''));

console.log('\n说明：scripts 用精确正则定位文档中的数字；若显示「—」说明该行措辞已改，需人工看。');
console.log('      本脚本自身位于 backend/test/，故 test 目录计数含它自己。');

process.exit(bad === 0 && missing === 0 ? 0 : 1);
