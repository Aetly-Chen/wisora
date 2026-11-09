/**
 * AI 笔记工具的**契约验收**：只验工具，不涉及模型。
 *
 *   cd backend && npx nest build && node test/ai-note-tools.contract.cjs
 *
 * 前置：只需要 PostgreSQL（脚本自己建 @wisora.local 隔离用户，跑完就删）。
 * **不需要 Redis、不需要模型密钥、不花钱** —— 改完工具就该跑一遍。
 *
 * 为什么不起整棵 Nest：Redis 没跑时 `NestFactory.createApplicationContext` 会卡在
 * Redis 的 onModuleInit 上，而这里要验的是「工具 → NotesService → 库」这一段，
 * 跟 Redis 无关。所以手动装配：真 Prisma、真 NotesService、索引换成空实现
 * （NotesService 只调 index.reindexNote / removeChunks，且都是后台 fire-and-forget）。
 *
 * 验的是**模型看到的那份契约**：参数名、返回的 JSON 形状（`list` 是
 * `{found,total,tree}`、写操作是 `{success,message}`）、`parentId` 的
 * undefined 与 null 语义差异、失败时是否返回 `success:false` 而不是抛错
 * （抛错会让整次工具调用中断），以及删除必须 `confirmedByUser`。
 */
require('dotenv/config');
const path = require('path');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { NotesService } = require('../dist/src/notes/notes.service');
const { RealtimeService } = require('../dist/src/common/realtime/realtime.service');
const {
  createListNotesTool,
  createReadNoteTool,
  createCreateNoteTool,
  createWriteNoteTool,
  createUpdateNoteTool,
  createDeleteNoteTool,
} = require('../dist/src/ai/tools/notes.tool');

const EMAIL = 'ai-tools@wisora.local';

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
}

const stubIndex = {
  reindexNote: async () => {},
  removeChunks: async () => {},
};

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const notes = new NotesService(prisma, stubIndex, new RealtimeService());

  // 清场并播种
  const old = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (old) {
    await prisma.noteChunk.deleteMany({ where: { note: { userId: old.id } } });
    await prisma.note.deleteMany({ where: { userId: old.id } });
    await prisma.user.delete({ where: { id: old.id } });
  }
  const user = await prisma.user.create({
    data: { email: EMAIL, password: 'x', nickname: 'ai-tools' },
  });
  const other = await prisma.user.create({
    data: { email: 'ai-tools-other@wisora.local', password: 'x', nickname: 'other' },
  });

  const parent = await prisma.note.create({
    data: { userId: user.id, title: '项目', content: '# 项目\n' },
  });
  const child = await prisma.note.create({
    data: {
      userId: user.id,
      parentId: parent.id,
      title: '周报',
      content: '# 周报\n\n- 周一：搭环境\n',
    },
  });
  const foreign = await prisma.note.create({
    data: { userId: other.id, title: '别人的', content: '# 别人的\n' },
  });

  const asJson = (s) => { try { return JSON.parse(s); } catch { return { raw: s }; } };
  const list = createListNotesTool(notes, user.id);
  const read = createReadNoteTool(notes, user.id);
  const create = createCreateNoteTool(notes, user.id);
  const write = createWriteNoteTool(notes, user.id);
  const update = createUpdateNoteTool(notes, user.id);
  const del = createDeleteNoteTool(notes, user.id);

  console.log('--- 1. list_my_notes ---');
  // 契约：{ found, total, returned, truncated, tree } —— tree 是渲染好的缩进文本，
  // 不是数组（省 token，也让模型直接看得出层级）
  const l1 = asJson(await list.invoke({ limit: 20 }));
  check('found=true', l1.found === true, l1);
  check('total=2', l1.total === 2, l1.total);
  check('tree 里两篇都在', typeof l1.tree === 'string' && l1.tree.includes('项目') && l1.tree.includes('周报'), l1.tree);
  check('看不到别人的笔记', !String(l1.tree ?? '').includes('别人的'), l1.tree);
  check('tree 带 id', /c[a-z0-9]{20,}/.test(String(l1.tree ?? '')), String(l1.tree ?? '').slice(0, 80));

  console.log('\n--- 2. read_my_note ---');
  // 契约：读成功用 found:true（不是 success），失败走 asFailure
  const r1 = asJson(await read.invoke({ noteId: child.id }));
  check('found=true 且带正文', r1.found === true && String(r1.content).includes('周一'), r1);
  const r2 = asJson(await read.invoke({ noteId: foreign.id }));
  check('读别人的笔记失败', r2.success === false, r2);

  console.log('\n--- 3. write_my_note（append 默认） ---');
  const w1 = asJson(await write.invoke({ noteId: child.id, content: '- 周二：接推送' }));
  check('成功', w1.success === true, w1);
  const afterAppend = await prisma.note.findUnique({ where: { id: child.id } });
  check('追加到末尾且保留原文', afterAppend.content.includes('周一') && afterAppend.content.includes('周二'), afterAppend.content);

  console.log('\n--- 4. write_my_note（replace） ---');
  const w2 = asJson(await write.invoke({ noteId: child.id, content: '# 周报\n\n整篇重写。\n', mode: 'replace' }));
  check('成功', w2.success === true, w2);
  const afterReplace = await prisma.note.findUnique({ where: { id: child.id } });
  check('原文被覆盖', afterReplace.content.includes('整篇重写') && !afterReplace.content.includes('周一'), afterReplace.content);

  console.log('\n--- 5. update_my_note 只改标题（不能顺手挪层级） ---');
  const u1 = asJson(await update.invoke({ noteId: child.id, title: '周报 W45' }));
  check('成功', u1.success === true, u1);
  const afterTitle = await prisma.note.findUnique({ where: { id: child.id } });
  check('标题改了', afterTitle.title === '周报 W45', afterTitle.title);
  check('parentId 没被清掉（undefined ≠ null）', afterTitle.parentId === parent.id, afterTitle.parentId);

  console.log('\n--- 6. update_my_note 传 null 才移到顶层 ---');
  const u2 = asJson(await update.invoke({ noteId: child.id, parentId: null }));
  check('成功', u2.success === true, u2);
  const afterMove = await prisma.note.findUnique({ where: { id: child.id } });
  check('已移到顶层', afterMove.parentId === null, afterMove.parentId);

  console.log('\n--- 7. 越权与不存在：应返回 success:false，不抛错 ---');
  const x1 = asJson(await write.invoke({ noteId: foreign.id, content: '越权写入' }));
  check('别人的笔记写入失败', x1.success === false, x1);
  check('失败带可读原因', typeof x1.message === 'string' && x1.message.length > 0, x1.message);
  const x2 = asJson(await write.invoke({ noteId: '00000000-0000-0000-0000-000000000000', content: 'x' }));
  check('不存在的笔记写入失败', x2.success === false, x2);

  console.log('\n--- 8. create_my_note ---');
  const c1 = asJson(await create.invoke({ title: '临时纪要', content: '# 临时纪要\n', parentId: parent.id }));
  check('成功', c1.success === true, c1);
  const created = c1.id ? await prisma.note.findUnique({ where: { id: c1.id } }) : null;
  check('挂到了父页面下', created?.parentId === parent.id, created?.parentId);

  console.log('\n--- 9. delete_my_note ---');
  const d0 = asJson(await del.invoke({ noteId: c1.id, confirmedByUser: false }));
  check('未确认时拒绝删除', d0.success === false, d0);
  const stillThere = await prisma.note.findUnique({ where: { id: c1.id } });
  check('未确认时数据还在', stillThere?.deletedAt == null);
  const d1 = asJson(await del.invoke({ noteId: c1.id, confirmedByUser: true }));
  check('确认后删除成功', d1.success === true, d1);
  const gone = await prisma.note.findUnique({ where: { id: c1.id } });
  check('软删（deletedAt 有值）', gone?.deletedAt != null, gone?.deletedAt);

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  // 清场
  for (const u of [user, other]) {
    await prisma.noteChunk.deleteMany({ where: { note: { userId: u.id } } });
    await prisma.note.deleteMany({ where: { userId: u.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }
  const residue = await prisma.user.count({
    where: { email: { in: [EMAIL, 'ai-tools-other@wisora.local'] } },
  });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
