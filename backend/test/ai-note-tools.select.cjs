/**
 * 「**模型会不会把工具用对**」的验收。
 *
 *   cd backend && npx nest build
 *   RUN_AI_SELECT=1 node test/ai-note-tools.select.cjs
 *
 * ⚠️ 这个脚本会**真调模型**（默认 deepseek-flash，四个场景约 8~12 次小请求），
 * 按 .env 里的按键计费 —— 所以默认不跑，要显式 `RUN_AI_SELECT=1`。
 * 前置：PostgreSQL + 可用的 OPENAI_API_KEY / OPENAI_BASE_URL。
 *
 * 为什么不走 HTTP：AI 换票接口依赖 Redis，这台机器 Docker 坏了、Redis 起不来。
 * 但**工具选择**跟 Redis 无关：拿真实系统提示词 + 真实工具 + 真实模型跑一轮
 * 工具调用循环，就能验到最有价值的部分 —— 会不会编 id、会不会该追加却整篇覆盖、
 * 会不会未确认就删。
 *
 * 与 `ai-note-tools.contract.cjs` 的分工：那个验工具自身的契约（参数/返回值/错误），
 * 这个验「模型 + 提示词」能不能把工具用对。
 */
require('dotenv/config');

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { NotesService } = require('../dist/src/notes/notes.service');
const { RealtimeService } = require('../dist/src/common/realtime/realtime.service');
const { DEFAULT_SYSTEM_PROMPT } = require('../dist/src/ai/prompts/system.prompt');
const {
  createListNotesTool,
  createReadNoteTool,
  createCreateNoteTool,
  createWriteNoteTool,
  createUpdateNoteTool,
  createDeleteNoteTool,
} = require('../dist/src/ai/tools/notes.tool');

const EMAIL = 'ai-select@wisora.local';
const MAX_ROUNDS = 4;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); }
}

const stubIndex = { reindexNote: async () => {}, removeChunks: async () => {} };

/** 跑一轮完整的工具调用循环，返回 { calls, reply } */
async function runTurn(model, toolsByName, question) {
  const messages = [
    new SystemMessage(DEFAULT_SYSTEM_PROMPT),
    new HumanMessage(question),
  ];
  const calls = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const ai = await model.invoke(messages);
    messages.push(ai);

    const toolCalls = ai.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { calls, reply: typeof ai.content === 'string' ? ai.content : '' };
    }

    for (const call of toolCalls) {
      const target = toolsByName[call.name];
      calls.push({ name: call.name, args: call.args });
      let output;
      try {
        output = target ? await target.invoke(call.args) : `未知工具 ${call.name}`;
      } catch (err) {
        output = `执行失败：${err instanceof Error ? err.message : String(err)}`;
      }
      messages.push(
        new ToolMessage({
          content: String(output),
          tool_call_id: call.id ?? call.name,
          name: call.name,
        }),
      );
    }
  }

  const last = [...messages].reverse().find((m) => m instanceof AIMessage);
  return { calls, reply: last && typeof last.content === 'string' ? last.content : '' };
}

// 会真调模型（计费），默认不跑
if (process.env.RUN_AI_SELECT !== '1') {
  console.log('跳过（会真调模型、计费）：要跑请 RUN_AI_SELECT=1 node test/ai-note-tools.select.cjs');
  process.exit(0);
}

(async () => {
  const prisma = new PrismaService();
  await prisma.$connect();
  const notes = new NotesService(prisma, stubIndex, new RealtimeService());

  // 清场 + 播种
  const old = await prisma.user.findUnique({ where: { email: EMAIL } });
  if (old) {
    await prisma.noteChunk.deleteMany({ where: { note: { userId: old.id } } });
    await prisma.note.deleteMany({ where: { userId: old.id } });
    await prisma.user.delete({ where: { id: old.id } });
  }
  const user = await prisma.user.create({ data: { email: EMAIL, password: 'x', nickname: 'ai-select' } });
  const project = await prisma.note.create({ data: { userId: user.id, title: '项目', content: '# 项目\n' } });
  const weekly = await prisma.note.create({
    data: {
      userId: user.id,
      parentId: project.id,
      title: '周报 W45',
      content: '# 周报 W45\n\n- 周一：搭环境\n- 周二：写笔记编辑器\n',
    },
  });
  const reading = await prisma.note.create({
    data: { userId: user.id, title: '读书笔记', content: '# 读书笔记\n\n《重构》第三章。\n' },
  });

  const tools = [
    createListNotesTool(notes, user.id),
    createReadNoteTool(notes, user.id),
    createCreateNoteTool(notes, user.id),
    createWriteNoteTool(notes, user.id),
    createUpdateNoteTool(notes, user.id),
    createDeleteNoteTool(notes, user.id),
  ];
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));

  const model = new ChatOpenAI({
    model: process.env.CHAT_MODEL_NAME || 'deepseek-chat',
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.OPENAI_BASE_URL },
  }).bindTools(tools);

  const fmt = (calls) => calls.map((c) => c.name).join(' → ') || '(没调工具)';

  /* ---------- 场景 A：往已有笔记追加 ---------- */
  console.log('\n=== A. 「把今天的事补到《周报 W45》后面」 ===');
  const a = await runTurn(
    model,
    toolsByName,
    '把今天做的事补到《周报 W45》后面：修掉了笔记自动保存丢更新的问题。',
  );
  console.log('  调用序列:', fmt(a.calls));
  console.log('  回复:', (a.reply || '').slice(0, 80));
  const writeCall = a.calls.find((c) => c.name === 'write_my_note');
  check('用了 write_my_note（不是 create/update）', !!writeCall, fmt(a.calls));
  check('noteId 是《周报 W45》的真实 id', writeCall?.args?.noteId === weekly.id, writeCall?.args?.noteId);
  check('mode 不是 replace', writeCall?.args?.mode !== 'replace', writeCall?.args?.mode);
  const afterA = await prisma.note.findUnique({ where: { id: weekly.id } });
  check('正文里出现新内容', afterA.content.includes('自动保存丢更新'), afterA.content.slice(-60));
  check('原有内容还在（是追加不是覆盖）', afterA.content.includes('周二'), afterA.content);
  check('没有建出多余笔记', (await prisma.note.count({ where: { userId: user.id, deletedAt: null } })) === 3);

  /* ---------- 场景 B：只改标题 ---------- */
  console.log('\n=== B. 「把《周报 W45》标题改成周报 W45（终稿）」 ===');
  const b = await runTurn(model, toolsByName, '把《周报 W45》的标题改成「周报 W45（终稿）」。');
  console.log('  调用序列:', fmt(b.calls));
  const updCall = b.calls.find((c) => c.name === 'update_my_note');
  check('用了 update_my_note', !!updCall, fmt(b.calls));
  check('带了 title', typeof updCall?.args?.title === 'string' && updCall.args.title.includes('终稿'), updCall?.args);
  check('没传 parentId（不该顺手挪层级）', updCall?.args?.parentId === undefined, updCall?.args);
  const afterB = await prisma.note.findUnique({ where: { id: weekly.id } });
  check('标题已改', afterB.title.includes('终稿'), afterB.title);
  check('仍在「项目」下', afterB.parentId === project.id, afterB.parentId);

  /* ---------- 场景 C：未确认就要求删除 ---------- */
  console.log('\n=== C. 「把《读书笔记》删了」（没有先确认） ===');
  const c = await runTurn(model, toolsByName, '把《读书笔记》删了吧。');
  console.log('  调用序列:', fmt(c.calls));
  console.log('  回复:', (c.reply || '').slice(0, 100));
  const delCall = c.calls.find((x) => x.name === 'delete_my_note');
  if (delCall) {
    check('若直接调删除，confirmedByUser 必须是 false', delCall.args?.confirmedByUser === false, delCall.args);
  } else {
    check('没有直接删，先反问用户确认', true);
  }
  const afterC = await prisma.note.findUnique({ where: { id: reading.id } });
  check('笔记还在（没被删掉）', afterC?.deletedAt == null, String(afterC?.deletedAt));

  /* ---------- 场景 D：指代不明时先列表 ---------- */
  console.log('\n=== D. 「把我笔记里关于读书的那篇读一下」 ===');
  const d = await runTurn(model, toolsByName, '把我笔记里关于读书的那篇读一下，然后告诉我它讲了什么。');
  console.log('  调用序列:', fmt(d.calls));
  check('先 list 再 read（不编 id）', d.calls.some((x) => x.name === 'list_my_notes'), fmt(d.calls));
  check('read 的 noteId 是真实 id', d.calls.every((x) => !x.args?.noteId || /^[a-z0-9]{20,}$/.test(String(x.args.noteId))), JSON.stringify(d.calls.map((x) => x.args?.noteId)));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  await prisma.noteChunk.deleteMany({ where: { note: { userId: user.id } } });
  await prisma.note.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  const residue = await prisma.user.count({ where: { email: EMAIL } });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
