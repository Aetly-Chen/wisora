/**
 * `search_my_notes`（语义检索）的验收。
 *
 *   cd backend && npx nest build
 *   RUN_AI_EMBED=1 node test/ai-note-tools.search.cjs
 *
 * ⚠️ 会调**真的 embedding 接口**（照 .env 里的按键计费，这里只有十几条短文本），
 * 所以默认不跑，要显式 `RUN_AI_EMBED=1`。
 * 前置：PostgreSQL + 可用的 EMBEDDING_API_KEY / EMBEDDING_BASE_URL。
 *
 * 为什么值得单独一套：这是全仓唯一一条「AI 能捞回自己没提过的词」的路径，
 * 也是最容易出安全问题的路径 —— 少一个过滤条件不会报错，只会**悄悄多返回**。
 * 所以断言的重点不是"能搜到"，而是：
 *
 *   1. 语义命中：问题里**没有一个字**出现在笔记里，仍要捞对那篇
 *   2. userId 过滤：另一个用户有**一模一样的内容**，绝不能出现在结果里
 *   3. deletedAt 过滤：软删的笔记，块还在库里（软删不级联），也不能被搜出来
 *   4. limit 生效
 */
require('dotenv/config');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { EmbeddingService } = require('../dist/src/rag/embedding.service');
const { NoteIndexService } = require('../dist/src/rag/note-index.service');
const { NoteSearchService } = require('../dist/src/rag/note-search.service');
const { createSearchNotesTool } = require('../dist/src/ai/tools/search-notes.tool');

const OWNER = 'ai-search@wisora.local';
const OTHER = 'ai-search-other@wisora.local';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); }
}

// 注意：问题和正文刻意**不共享任何词**，否则测的是字面匹配，不是语义
const NOTES = {
  perf: {
    title: '首屏体验',
    content: [
      '# 首屏体验',
      '',
      '把 LCP 从 4.2s 压到 1.8s：入口图片换成 WebP、路由级按需加载、',
      '首屏依赖的外链字体改成本地子集。',
    ].join('\n'),
  },
  cat: {
    title: '养猫日常',
    content: '# 养猫日常\n\n膨润土结团快但灰尘大，豆腐砂冲厕所方便；猫砂盆要放在安静角落。\n',
  },
  db: {
    title: 'PostgreSQL 慢查询',
    content: '# PostgreSQL 慢查询\n\nEXPLAIN ANALYZE 看实际行数与预估行数的偏差，偏差大就先 ANALYZE 再考虑建索引。\n',
  },
  rust: {
    title: 'Rust 借用',
    content: '# Rust 借用\n\n所有权转移后原变量失效，借用检查器通过生命周期标注判断引用是否悬垂。\n',
  },
};

(async () => {
  if (process.env.RUN_AI_EMBED !== '1') {
    console.log('跳过（会调真 embedding 接口、计费）：要跑请 RUN_AI_EMBED=1 node test/ai-note-tools.search.cjs');
    process.exit(0);
  }

  const prisma = new PrismaService();
  await prisma.$connect();

  const embedding = new EmbeddingService();
  if (!embedding.enabled) {
    console.log('跳过：没有配置 EMBEDDING_API_KEY，检索链路是降级状态');
    await prisma.$disconnect();
    process.exit(0);
  }
  const index = new NoteIndexService(prisma, embedding);
  const search = new NoteSearchService(prisma, embedding);

  // 清场
  for (const email of [OWNER, OTHER]) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) continue;
    await prisma.noteChunk.deleteMany({ where: { note: { userId: u.id } } });
    await prisma.note.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }

  const owner = await prisma.user.create({ data: { email: OWNER, password: 'x', nickname: 'ai-search' } });
  const other = await prisma.user.create({ data: { email: OTHER, password: 'x', nickname: 'other' } });

  const mk = (userId, key) =>
    prisma.note.create({
      data: { userId, title: NOTES[key].title, content: NOTES[key].content },
    });

  const perf = await mk(owner.id, 'perf');
  const cat = await mk(owner.id, 'cat');
  const db = await mk(owner.id, 'db');
  const rust = await mk(owner.id, 'rust');
  // 另一个用户：**内容完全相同**的一篇，专门用来验 userId 过滤
  const otherDb = await mk(other.id, 'db');

  console.log('--- 建索引（真调 embedding 接口） ---');
  for (const n of [perf, cat, db, rust, otherDb]) {
    const chunks = await index.reindexNote(n.id);
    console.log(`  ${n.title}: ${chunks} 块`);
  }

  // 软删：块**留在库里**（软删不级联，rag 侧另有清理），专验检索时的 deletedAt 过滤
  await prisma.note.update({ where: { id: rust.id }, data: { deletedAt: new Date() } });
  const rustChunksLeft = await prisma.noteChunk.count({ where: { noteId: rust.id } });
  check('前提：软删后块仍在库里（否则这条测不到过滤）', rustChunksLeft > 0, rustChunksLeft);

  const tool = createSearchNotesTool(search, owner.id);
  const asJson = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };

  console.log('\n--- 1. 语义命中（问题里没有一个字出现在正文里） ---');
  const q1 = '网页打开很慢，怎么让它快点出来';
  const r1 = asJson(await tool.invoke({ query: q1 }));
  check('found=true', r1.found === true, r1);
  check('第一条是《首屏体验》', r1.results?.[0]?.noteId === perf.id, r1.results?.map((x) => x.noteTitle));
  check('问题里的词确实不在正文里', !NOTES.perf.content.includes('慢') && !NOTES.perf.content.includes('网页'), '正文/问题重叠了，这条测不到语义');
  console.log('    top:', r1.results?.[0]?.noteTitle, '| relevance', r1.results?.[0]?.relevance);

  console.log('\n--- 2. userId 过滤（另一个用户有一模一样的内容） ---');
  const r2 = asJson(await tool.invoke({ query: '数据库查询很慢怎么排查', limit: 10 }));
  const ids = (r2.results ?? []).map((x) => x.noteId);
  check('没返回别人的笔记', !ids.includes(otherDb.id), ids);
  check('返回的全是自己的', ids.every((id) => [perf.id, cat.id, db.id, rust.id].includes(id)), ids);
  check('命中了自己的那篇慢查询笔记', ids[0] === db.id, r2.results?.map((x) => x.noteTitle));

  console.log('\n--- 3. deletedAt 过滤（软删的块还在库里） ---');
  const r3 = asJson(await tool.invoke({ query: '所有权和借用检查是怎么判定的', limit: 10 }));
  const ids3 = (r3.results ?? []).map((x) => x.noteId);
  check('软删的笔记没被搜出来', !ids3.includes(rust.id), r3.results?.map((x) => x.noteTitle));
  if (r3.found) check('返回的都不是已删笔记', ids3.every((id) => id !== rust.id), ids3);

  console.log('\n--- 4. limit 生效 ---');
  const r4 = asJson(await tool.invoke({ query: '笔记里都记了些什么', limit: 1 }));
  check('count=1', r4.results?.length === 1, r4.results?.length);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  for (const u of [owner, other]) {
    await prisma.noteChunk.deleteMany({ where: { note: { userId: u.id } } });
    await prisma.note.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  const residue = await prisma.user.count({ where: { email: { in: [OWNER, OTHER] } } });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
