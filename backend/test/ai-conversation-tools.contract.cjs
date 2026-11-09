/**
 * AI **会话工具**的契约验收（`list_my_conversations` / `read_my_conversation` /
 * `rename_my_conversation`）。
 *
 *   cd backend && npx nest build && node test/ai-conversation-tools.contract.cjs
 *
 * 前置只有 PostgreSQL，**不需要 Redis / 模型，不花钱**。
 *
 * 和 `ai-note-tools.contract.cjs` 是同一类：验工具自己的契约。
 * 会话工具的重点与笔记不同 —— 它们**直接查 Prisma**（不像笔记走 NotesService），
 * 所以 `userId` 过滤只写在 where 里，少写一处就是跨用户泄漏，而且不会报错。
 * 断言里专门造了「另一个用户 + 相同标题」来抓这个。
 *
 * 注意返回形状不统一（历史原因，别按直觉写）：
 *   list → `{found, conversations[]}` / 空时 `{found:false}`
 *   read → `{found, title, messages[]}` / 失败 `{found:false, reason}`
 *   改标题 → `{success, conversationId, title}` / 失败 `{success:false, message}`
 */
require('dotenv/config');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const {
  createListConversationsTool,
  createReadConversationTool,
  createRenameConversationTool,
} = require('../dist/src/ai/tools/conversation.tool');

const OWNER = 'ai-conv@wisora.local';
const OTHER = 'ai-conv-other@wisora.local';
const EMPTY = 'ai-conv-empty@wisora.local';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); }
}

const LONG = '长'.repeat(600);

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();

  for (const email of [OWNER, OTHER, EMPTY]) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) continue;
    await prisma.message.deleteMany({ where: { conversation: { userId: u.id } } });
    await prisma.conversation.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }

  const owner = await prisma.user.create({ data: { email: OWNER, password: 'x', nickname: 'ai-conv' } });
  const other = await prisma.user.create({ data: { email: OTHER, password: 'x', nickname: 'other' } });
  const emptyU = await prisma.user.create({ data: { email: EMPTY, password: 'x', nickname: 'empty' } });

  // 有消息的会话（3 条，含一条超长）
  const conv = await prisma.conversation.create({
    data: { userId: owner.id, title: '性能排查', model: 'deepseek-flash' },
  });
  /*
   * ⚠️ 必须显式给 createdAt：`createMany` 三条消息在同一语句里，默认 now() 完全相同，
   * 而 `orderBy createdAt asc` 遇到平局时顺序是不确定的 —— 第一版就是这么"碰巧通过"的，
   * 后来复跑红了才知道。真实链路里消息是一条条插入的，不会并列，所以这是**测试的问题**。
   */
  const t0 = Date.now() - 30_000;
  await prisma.message.createMany({
    data: [
      { conversationId: conv.id, role: 'user', content: '首屏为什么慢', createdAt: new Date(t0) },
      { conversationId: conv.id, role: 'assistant', content: '看 LCP 与长任务', createdAt: new Date(t0 + 1000) },
      { conversationId: conv.id, role: 'user', content: LONG, createdAt: new Date(t0 + 2000) },
    ],
  });
  // 无标题的会话（标题回退）
  const unnamed = await prisma.conversation.create({ data: { userId: owner.id } });
  // 另一个用户：**同样的标题**，用来抓 userId 过滤
  const foreign = await prisma.conversation.create({
    data: { userId: other.id, title: '性能排查', model: 'deepseek-flash' },
  });
  await prisma.message.create({
    data: { conversationId: foreign.id, role: 'user', content: '别人的私密内容' },
  });

  const asJson = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };
  const list = createListConversationsTool(prisma, owner.id);
  const read = createReadConversationTool(prisma, owner.id);
  const rename = createRenameConversationTool(prisma, owner.id);
  const listEmpty = createListConversationsTool(prisma, emptyU.id);

  console.log('--- 1. list_my_conversations ---');
  const l1 = asJson(await list.invoke({}));
  check('found=true', l1.found === true, l1);
  check('只列自己的两条', l1.conversations?.length === 2, l1.conversations?.map((c) => c.id));
  check('没有别人的会话', !(l1.conversations ?? []).some((c) => c.id === foreign.id), l1.conversations?.map((c) => c.id));
  check('无标题回退成 (未命名)', (l1.conversations ?? []).find((c) => c.id === unnamed.id)?.title === '(未命名)', l1.conversations?.map((c) => c.title));
  // 不该假设顺序：列表按 updatedAt 倒序，但建/改的时间先后不一定符合直觉
  check('每条都带 updatedAt', (l1.conversations ?? []).every((c) => /^\d{4}-\d{2}-\d{2}T/.test(String(c.updatedAt))), l1.conversations?.map((c) => c.updatedAt));
  check('建会话时带的 model 透出来了', (l1.conversations ?? []).some((c) => c.model === 'deepseek-flash'), l1.conversations?.map((c) => c.model));
  const l2 = asJson(await listEmpty.invoke({}));
  check('没有任何会话时 found=false', l2.found === false, l2);

  console.log('\n--- 2. read_my_conversation ---');
  const r1 = asJson(await read.invoke({ conversationId: conv.id }));
  check('found=true 且带标题', r1.found === true && r1.title === '性能排查', r1.title);
  check('消息按时间正序（user 在前）', r1.messages?.[0]?.role === 'user' && r1.messages?.[0]?.content === '首屏为什么慢', r1.messages?.map((m) => m.role));
  check('超长消息被截到 500 字并加省略号', r1.messages?.[2]?.content.length === 501 && r1.messages[2].content.endsWith('…'), r1.messages?.[2]?.content.slice(-6));
  const r2 = asJson(await read.invoke({ conversationId: conv.id, limit: 1 }));
  check('limit 生效', r2.messages?.length === 1, r2.messages?.length);
  const r3 = asJson(await read.invoke({ conversationId: foreign.id }));
  check('读别人的会话失败', r3.found === false, r3);
  check('失败带原因', typeof r3.reason === 'string' && r3.reason.length > 0, r3.reason);
  check('没有泄漏别人的消息', !JSON.stringify(r3).includes('别人的私密内容'), r3);
  const r4 = asJson(await read.invoke({ conversationId: 'nope-not-exist' }));
  check('不存在的会话 found=false', r4.found === false, r4);

  console.log('\n--- 3. rename_my_conversation ---');
  const n1 = asJson(await rename.invoke({ conversationId: conv.id, title: '性能排查（改名后）' }));
  check('success=true', n1.success === true, n1);
  const afterRename = await prisma.conversation.findUnique({ where: { id: conv.id } });
  check('库里的标题变了', afterRename.title === '性能排查（改名后）', afterRename.title);
  const n2 = asJson(await rename.invoke({ conversationId: foreign.id, title: '越权改名' }));
  check('改别人的会话失败', n2.success === false, n2);
  const foreignAfter = await prisma.conversation.findUnique({ where: { id: foreign.id } });
  check('别人的标题没变', foreignAfter.title === '性能排查', foreignAfter.title);
  const n3 = asJson(await rename.invoke({ conversationId: 'nope-not-exist', title: 'x' }));
  check('改不存在的会话失败', n3.success === false, n3);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  for (const u of [owner, other, emptyU]) {
    await prisma.message.deleteMany({ where: { conversation: { userId: u.id } } });
    await prisma.conversation.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  const residue = await prisma.user.count({ where: { email: { in: [OWNER, OTHER, EMPTY] } } });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
