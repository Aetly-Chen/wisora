/**
 * 「写操作必须获得授权」这道闸门的验收。
 *
 *   cd backend && npx nest build && node test/ai-note-tools.gate.cjs
 *
 * 前置只有 PostgreSQL，**不需要 Redis / 模型 / embedding，不花钱**。
 *
 * 为什么单独一套：前面两套都是绕过闸门直接 `tool.invoke()`，也就是说
 * **「AI 没有授权时不会改数据」这条从没被验过**。而它恰恰是最不能坏的一条 ——
 * 一旦闸门失效，模型会直接写用户的库，用户完全不知道。
 *
 * 闸门在 `AiService.invokeTool`：`policy.write && !allowWrite` → 不执行，只回一句
 * 给模型。所以这套脚本要造出「工具 + 策略 + allowWrite」三样东西，
 * 走真实方法（TS 的 private 在运行时只是个类型约束，能直接调）。
 */
require('dotenv/config');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { NotesService } = require('../dist/src/notes/notes.service');
const { RealtimeService } = require('../dist/src/common/realtime/realtime.service');
const { ToolRegistry } = require('../dist/src/ai/tools/tool.registry');
const { createUserScopedTools } = require('../dist/src/ai/tools/index');
const { AiService } = require('../dist/src/ai/ai.service');

const EMAIL = 'ai-gate@wisora.local';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); }
}

const stubIndex = { reindexNote: async () => {}, removeChunks: async () => {} };
/** 检索服务只在 read 路径用到；闸门测试不需要真向量 */
const stubSearch = { enabled: false, search: async () => [] };

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const notes = new NotesService(prisma, stubIndex, new RealtimeService());

  const old = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (old) {
    await prisma.noteChunk.deleteMany({ where: { note: { userId: old.id } } });
    await prisma.note.deleteMany({ where: { userId: old.id } });
    await prisma.user.delete({ where: { id: old.id } });
  }
  const user = await prisma.user.create({ data: { email: EMAIL, password: 'x', nickname: 'ai-gate' } });
  const note = await prisma.note.create({
    data: { userId: user.id, title: '闸门测试', content: '# 闸门测试\n\n原始内容。\n' },
  });

  const registry = new ToolRegistry();
  const extraTools = createUserScopedTools(prisma, user.id, notes, stubSearch);
  // models 在这条路径上用不到（invokeTool 只碰 tools + policy）
  const ai = new AiService({}, registry);

  /* ---------- 1. 策略自查：所有「会改数据」的工具都必须标 write ---------- */
  console.log('--- 1. 写工具的策略标记 ---');
  const destructive = extraTools.filter((t) =>
    /^(create|write|update|delete|rename|move)_/.test(t.tool.name),
  );
  check('确实取到了写工具（否则下面等于没测）', destructive.length >= 5, destructive.map((t) => t.tool.name));
  for (const t of destructive) {
    check(`${t.tool.name} 标了 write:true`, t.policy?.write === true, t.policy);
  }
  const readOnly = extraTools.filter((t) => /^(list|read|search)_/.test(t.tool.name));
  check('读工具没被误标成 write', readOnly.every((t) => t.policy?.write !== true), readOnly.map((t) => [t.tool.name, t.policy?.write]));

  /* ---------- 2. 未授权：写操作必须被拦下且数据不动 ---------- */
  console.log('\n--- 2. allowWrite=false 时调 write_my_note ---');
  const denied = await ai.invokeTool(
    'write_my_note',
    { noteId: note.id, content: '未授权写入，不该落库' },
    false,
    extraTools,
  );
  check('返回 ok=false', denied.ok === false, denied);
  check('给模型的说明提到授权', /授权/.test(denied.output), denied.output);
  const afterDenied = await prisma.note.findUnique({ where: { id: note.id } });
  check('库里内容没变', !afterDenied.content.includes('未授权写入'), afterDenied.content);

  /* ---------- 3. 同一个工具，授权后应当真的执行 ---------- */
  console.log('\n--- 3. allowWrite=true 时调同一个工具 ---');
  const allowed = await ai.invokeTool(
    'write_my_note',
    { noteId: note.id, content: '授权后写入' },
    true,
    extraTools,
  );
  check('返回 ok=true', allowed.ok === true, allowed);
  const afterAllowed = await prisma.note.findUnique({ where: { id: note.id } });
  check('内容已落库', afterAllowed.content.includes('授权后写入'), afterAllowed.content);

  /* ---------- 4. 读操作不受闸门影响 ---------- */
  console.log('\n--- 4. allowWrite=false 时调 read_my_note（读不该被拦） ---');
  const readRes = await ai.invokeTool('read_my_note', { noteId: note.id }, false, extraTools);
  check('返回 ok=true', readRes.ok === true, readRes);
  check('拿到了正文', readRes.output.includes('授权后写入'), readRes.output.slice(0, 60));

  /* ---------- 5. 未注册的工具 ---------- */
  console.log('\n--- 5. 调一个没注册的工具 ---');
  const unknown = await ai.invokeTool('drop_database', {}, true, extraTools);
  check('返回 ok=false', unknown.ok === false, unknown);
  check('说明是未注册', /未注册/.test(unknown.output), unknown.output);

  /* ---------- 6. 全局注册表里如果混进了写工具，也要照样拦 ---------- */
  console.log('\n--- 6. 把写工具塞进全局注册表（不给 allowWrite） ---');
  for (const t of extraTools) registry.register(t.tool, t.policy);
  const viaRegistry = await ai.invokeTool(
    'delete_my_note',
    { noteId: note.id, confirmedByUser: true },
    false,
    [], // 故意不给 extraTools：只走全局注册表
  );
  check('仍然被拦下', viaRegistry.ok === false && /授权/.test(viaRegistry.output), viaRegistry);
  const stillAlive = await prisma.note.findUnique({ where: { id: note.id } });
  check('笔记没被删', stillAlive?.deletedAt == null);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  await prisma.noteChunk.deleteMany({ where: { note: { userId: user.id } } });
  await prisma.note.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  const residue = await prisma.user.count({ where: { email: EMAIL } });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
