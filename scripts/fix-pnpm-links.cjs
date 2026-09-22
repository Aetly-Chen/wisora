#!/usr/bin/env node
/**
 * 修复 pnpm 缺失的顶层链接。
 *
 * 背景：pnpm 的布局是「实体放 node_modules/.pnpm/<pkg>@<ver>/，顶层只放链接」。
 * 安装被中断（本机是 safe-delete 沙箱守卫拦截删除操作）时，
 * **`.pnpm` 里的实体是完整的，缺的只是顶层链接**。
 * 症状是 `Cannot find module 'xxx'`，但 `.pnpm` 里明明有该包。
 *
 * 这种失败很隐蔽：`pnpm install` 会报 exit 0，甚至打印「+N 个包」，
 * 而缺的那个可能恰是关键包（本项目就丢过 @nestjs/core，后端起不来）。
 *
 * 用法：
 *   node scripts/fix-pnpm-links.cjs frontend
 *   node scripts/fix-pnpm-links.cjs backend
 *
 * 为什么必须建链接而不是拷目录：拷贝会产生两份实体，
 * Node 的 realpath 解析结果不同 —— 对 @nestjs/core 这类有单例语义的包
 * 会变成两份实例、DI 容器分裂，报错完全指不到原因。
 * Windows 上用 junction（mklink /J），不需要管理员权限，与 pnpm 自身做法一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const target = process.argv[2];
if (!target) {
  console.error('用法: node scripts/fix-pnpm-links.cjs <frontend|backend|目录名>');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', target);
const nm = path.join(root, 'node_modules');
const vstore = path.join(nm, '.pnpm');

if (!fs.existsSync(path.join(root, 'package.json'))) {
  console.error(`找不到 ${path.join(root, 'package.json')}`);
  process.exit(1);
}
if (!fs.existsSync(vstore)) {
  console.error(`找不到 ${vstore}，先跑一次 pnpm install`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const names = [
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
];

/** @scope/name → @scope+name（pnpm 的虚拟目录命名） */
const mangled = (name) => name.replace('/', '+');

const missing = [];
const broken = [];
for (const name of names) {
  const link = path.join(nm, ...name.split('/'));
  if (!fs.existsSync(link)) missing.push(name);
  else if (!fs.statSync(link).isDirectory()) broken.push(name);
}

console.log(`检查 ${root}`);
console.log(`  直接依赖 ${names.length} 个：缺失 ${missing.length}，异常 ${broken.length}`);

if (missing.length === 0 && broken.length === 0) {
  console.log('  ✓ 顶层链接完整，无需修复');
  process.exit(0);
}

let fixed = 0;
let failed = 0;

for (const name of [...missing, ...broken]) {
  const prefix = `${mangled(name)}@`;
  // 同一个包可能有多个 .pnpm 目录（peer 组合不同），取字典序第一个即可 ——
  // 它们内容一致，只是 peer 依赖不同
  const candidates = fs
    .readdirSync(vstore)
    .filter((d) => d.startsWith(prefix))
    .sort();

  if (candidates.length === 0) {
    console.log(`  ✗ ${name}：.pnpm 里没有实体，需要重新 pnpm install`);
    failed += 1;
    continue;
  }

  const source = path.join(
    vstore,
    candidates[0],
    'node_modules',
    ...name.split('/'),
  );
  if (!fs.existsSync(source)) {
    console.log(`  ✗ ${name}：实体路径不存在 ${source}`);
    failed += 1;
    continue;
  }

  const link = path.join(nm, ...name.split('/'));
  fs.mkdirSync(path.dirname(link), { recursive: true });

  try {
    // cmd 的 /c 与 /J 由 execFileSync 直接传给 CreateProcess，
    // 不经过 shell，所以不会被 MSYS 的路径转换改写
    execFileSync('cmd', ['/c', 'mklink', '/J', link, source], {
      stdio: 'ignore',
    });
  } catch {
    /* 失败靠下面的存在性检查判定 */
  }

  if (fs.existsSync(link)) {
    const extra = candidates.length > 1 ? `（候选 ${candidates.length} 个，取了第一个）` : '';
    console.log(`  ✓ ${name} -> ${candidates[0]}${extra}`);
    fixed += 1;
  } else {
    console.log(`  ✗ ${name}：创建链接失败`);
    failed += 1;
  }
}

console.log(`  结果：修复 ${fixed}，失败 ${failed}`);
process.exit(failed === 0 ? 0 : 1);
