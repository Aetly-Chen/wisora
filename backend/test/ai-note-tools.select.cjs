/**
 * 「**模型会不会把工具用对**」的验收（选择层 + 时序 + 失败改道 + 授权对话）。
 *
 *   cd backend && npx nest build
 *   RUN_AI_SELECT=1 node test/ai-note-tools.select.cjs
 *
 * ⚠️ 会**真调模型**（默认 deepseek-flash，七个场景约 15~20 次小请求），按 .env 计费 ——
 * 所以默认不跑，要显式 `RUN_AI_SELECT=1`。前置：PostgreSQL + OPENAI_API_KEY/BASE_URL。
 *
 * 为什么不走 HTTP：AI 换票接口依赖 Redis，这台机器 Docker 坏了、Redis 起不来。
 * 但工具这一层跟 Redis 无关。
 *
 * **执行走真实的 `AiService.invokeTool`**（而不是直接 `tool.invoke()`）——
 * 这样超时/重试策略与「写操作必须授权」的闸门都在链路里，
 * 场景 G 才能验到「没授权时模型怎么跟用户说」。
 * `invokeTool` 是 TS 的 private，运行时只是类型约束，可以直接调。
 *
 * 与另外几套的分工：
 * - `ai-note-tools.contract.cjs`  验工具自身契约（参数/返回值/错误语义）
 * - `ai-conversation-tools.contract.cjs` 验会话工具契约（含跨用户隔离）
 * - `ai-note-tools.gate.cjs`      验闸门本身（不经过模型）
 * - 本文件                        验「模型 + 提示词 + 闸门」合起来的真实行为
 */
require('dotenv/config');

const { ChatOpenAI } = require('@langchain/openai');
const { HumanMessage, SystemMessage, ToolMessage, AIMessage } = require('@langchain/core/messages');

const { PrismaService } = require('../dist/src/prisma/prisma.service');
const { NotesService } = require('../dist/src/notes/notes.service');
const { RealtimeService } = require('../dist/src/common/realtime/realtime.service');
const { ToolRegistry } = require('../dist/src/ai/tools/tool.registry');
const { createUserScopedTools } = require('../dist/src/ai/tools/index');
const { AiService } = require('../dist/src/ai/ai.service');
const { DEFAULT_SYSTEM_PROMPT } = require('../dist/src/ai/prompts/system.prompt');

const EMAIL = 'ai-select@wisora.local';
/** 连调两个工具时链路更长为多留一轮 */
const MAX_ROUNDS = 5;

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log(`  [通过] ${name}`); }
  else { fail += 1; console.log(`  [失败] ${name}${extra !== undefined ? ' -> ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)) : ''}`); }
}

const stubIndex = { reindexNote: async () => {}, removeChunks: async () => {} };
/** 本脚本不验检索（那是 search.cjs 的事），关掉以免多花 embedding 调用 */
const stubSearch = { enabled: false, search: async () => [] };

/**
 * 跑一轮完整的工具调用循环。
 * 工具**经 `AiService.invokeTool` 执行** —— 闸门、超时、重试都在里面。
 */
async function runTurn({ model, ai, extraTools }, question, { allowWrite = true } = {}) {
  const messages = [
    new SystemMessage(DEFAULT_SYSTEM_PROMPT),
    new HumanMessage(question),
  ];
  const calls = [];
  const outputs = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const msg = await model.invoke(messages);
    messages.push(msg);

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return { calls, outputs, reply: typeof msg.content === 'string' ? msg.content : '' };
    }

    for (const call of toolCalls) {
      calls.push({ name: call.name, args: call.args });
      // 真实执行路径：全局注册表为空，工具都在 extraTools 里（与 app 里一致）
      const result = await ai.invokeTool(call.name, call.args, allowWrite, extraTools);
      outputs.push({ name: call.name, ok: result.ok, output: result.output });
      messages.push(
        new ToolMessage({
          content: String(result.output),
          tool_call_id: call.id ?? call.name,
          name: call.name,
        }),
      );
    }
  }

  const last = [...messages].reverse().find((m) => m instanceof AIMessage);
  return { calls, outputs, reply: last && typeof last.content === 'string' ? last.content : '' };
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
  // 场景 F 用：一篇**已软删**的笔记，列表里看不到，模型不能凭空写进去
  const deleted = await prisma.note.create({
    data: { userId: user.id, title: 'Rust 借用', content: '# Rust 借用\n\n所有权与借用。\n' },
  });
  await prisma.note.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

  const extraTools = createUserScopedTools(prisma, user.id, notes, stubSearch);
  const registry = new ToolRegistry(); // 全局工具为空：笔记工具都是按请求创建的
  const ai = new AiService({}, registry);
  const ctx = { extraTools };

  const model = new ChatOpenAI({
    model: process.env.CHAT_MODEL_NAME || 'deepseek-chat',
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
    configuration: { baseURL: process.env.OPENAI_BASE_URL },
  }).bindTools(extraTools.map((t) => t.tool));
  Object.assign(ctx, { model, ai });

  const fmt = (calls) => calls.map((c) => c.name).join(' → ') || '(没调工具)';
  const turn = (q, opts) => runTurn(ctx, q, opts);

  /* ---------- 场景 A：往已有笔记追加 ---------- */
  console.log('\n=== A. 「把今天的事补到《周报 W45》后面」 ===');
  const a = await turn('把今天做的事补到《周报 W45》后面：修掉了笔记自动保存丢更新的问题。');
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
  const b = await turn('把《周报 W45》的标题改成「周报 W45（终稿）」。');
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
  const c = await turn('把《读书笔记》删了吧。');
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
  const d = await turn('把我笔记里关于读书的那篇读一下，然后告诉我它讲了什么。');
  console.log('  调用序列:', fmt(d.calls));
  check('先 list 再 read（不编 id）', d.calls.some((x) => x.name === 'list_my_notes'), fmt(d.calls));
  check('read 的 noteId 是真实 id', d.calls.every((x) => !x.args?.noteId || /^[a-z0-9]{20,}$/.test(String(x.args.noteId))), JSON.stringify(d.calls.map((x) => x.args?.noteId)));

  /* ---------- 场景 E：一句话里要两件事（时序 / 多工具） ---------- */
  console.log('\n=== E. 「《周报 W45》改标题 + 末尾补一句」（一次说两件事） ===');
  const e = await turn(
    '帮我做两件事：把《周报 W45（终稿）》的标题改成「周报 W45 定稿」，再在正文末尾补一句「周五：补验收脚本」。',
  );
  console.log('  调用序列:', fmt(e.calls));
  const eUpd = e.calls.find((x) => x.name === 'update_my_note');
  const eWrite = e.calls.find((x) => x.name === 'write_my_note');
  check('两个工具都调了（update + write）', !!eUpd && !!eWrite, fmt(e.calls));
  check('没有漏掉其中一半就收工', !!eUpd && !!eWrite, fmt(e.calls));
  const afterE = await prisma.note.findUnique({ where: { id: weekly.id } });
  check('标题改了', afterE.title === '周报 W45 定稿', afterE.title);
  check('正文追加了', afterE.content.includes('周五：补验收脚本'), afterE.content.slice(-40));
  check('两次写入都指向同一篇（没有写错笔记）', afterE.id === weekly.id);

  /* ---------- 场景 F：目标已被删除（不许瞎编 id） ---------- */
  console.log('\n=== F. 「《Rust 借用》那篇补一句」（其实已删除） ===');
  const f = await turn('把我那篇《Rust 借用》里补一句：生命周期标注要显式。');
  console.log('  调用序列:', fmt(f.calls));
  console.log('  回复:', (f.reply || '').slice(0, 100));
  check('没有对已删笔记执行写入', !f.calls.some((x) => x.name === 'write_my_note'), fmt(f.calls));
  const fWrite = f.calls.find((x) => x.name === 'write_my_note');
  check('若提交了写入，目标也不能是已删那篇', fWrite?.args?.noteId !== deleted.id, fWrite?.args?.noteId);
  const deletedAfter = await prisma.note.findUnique({ where: { id: deleted.id } });
  check('已删笔记的正文没被改', !deletedAfter.content.includes('生命周期标注'), deletedAfter.content);
  check('回复里说清"找不到/不存在"', /没有|不存在|找不到|未找到/.test(f.reply || ''), (f.reply || '').slice(0, 120));

  /* ---------- 场景 G：没开启"允许修改数据"时，模型要如实转达 ---------- */
  console.log('\n=== G. allowWrite=false 时让它改标题 ===');
  const beforeG = await prisma.note.findUnique({ where: { id: reading.id } });
  const g = await turn('把《读书笔记》的标题改成「重构（精读）」。', { allowWrite: false });
  console.log('  调用序列:', fmt(g.calls));
  console.log('  工具返回:', (g.outputs[0]?.output || '').slice(0, 90));
  console.log('  回复:', (g.reply || '').slice(0, 110));
  const afterG = await prisma.note.findUnique({ where: { id: reading.id } });
  check('库里标题没变', afterG.title === beforeG.title, afterG.title);
  const gateOutput = g.outputs.find((o) => o.name === 'update_my_note');
  check('工具结果是"被拦下"而不是成功', gateOutput?.ok === false, gateOutput?.ok);
  check('模型把"需要授权"转达给了用户', /授权|允许|开关|权限/.test(g.reply || ''), (g.reply || '').slice(0, 120));
  check('没有反复重试同一个被拦的调用', (g.calls ?? []).filter((x) => x.name === 'update_my_note').length <= 2, fmt(g.calls));

  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);

  await prisma.noteChunk.deleteMany({ where: { note: { userId: user.id } } });
  await prisma.note.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  const residue = await prisma.user.count({ where: { email: EMAIL } });
  console.log('[清理复核] 残留用户:', residue);

  await prisma.$disconnect();
  process.exit(fail > 0 ? 1 : 0);
})().catch(async (e) => { console.error('执行失败:', e); process.exit(1); });
