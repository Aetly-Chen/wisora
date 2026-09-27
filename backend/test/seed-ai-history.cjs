/**
 * AI 会话历史走查数据。
 *
 * 用途：验证 GET /ai/conversations/:id/messages 是否返回**完整**历史，
 * 以及工具轮次（tool_call / tool_result 两行）在界面上的回显是否正确。
 *
 * 为什么单独写一个脚本而不是塞进 seed-chat-visual.cjs：
 * 那个脚本是聊天（Chat* 表）的视觉夹具，这里是 AI 会话（Conversation/Message），
 * 两套数据模型完全独立，混在一起会让各自的清理边界变模糊。
 *
 * 命名空间与清理：
 * - 账号固定用 `viz-a@wisora.local`（与 seed-chat-visual 同一个测试账号）
 * - 只删这个账号名下的 AI 会话；**不碰真实账号**
 * - `--cleanup` 只清数据、不删账号（账号由 seed-chat-visual 管）
 *
 *   cd backend && node test/seed-ai-history.cjs            # 建数据并打印 token
 *   cd backend && node test/seed-ai-history.cjs --cleanup  # 清空
 */
const fs = require('node:fs');
const path = require('node:path');

const { Client } = require(
  path.join(__dirname, '..', 'node_modules', '.pnpm', 'pg@8.23.0', 'node_modules', 'pg'),
);
require(path.join(__dirname, '..', 'node_modules', 'dotenv', 'config'));
const { JwtService } = require(path.join(__dirname, '..', 'node_modules', '@nestjs', 'jwt'));

const TEST_EMAIL = 'viz-a@wisora.local';
const TITLE = '历史记录走查';

/** 距现在 n 分钟的时间戳（ISO 字符串，理由见 seed-chat-visual.cjs 的注释） */
const agoIso = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * 构造消息序列。
 *
 * 刻意超过 20 条（HISTORY_LIMIT）—— 20 是给 LLM 上下文窗口用的，
 * 但历史接口复用了同一个方法，于是界面也只能看到最近 20 条。
 * 另外插入 3 组工具轮次，用来暴露「一次调用落两行」导致的重复卡片。
 */
function buildMessages() {
  const rows = [];
  let at = 300; // 从 5 小时前开始铺

  const push = (role, content, extra = {}) => {
    rows.push({ role, content, at: at, ...extra });
    at -= 1;
  };

  // 第 1 轮 + 工具调用：查目录
  push('user', '帮我看下我有哪些笔记');
  push('tool', 'list_my_notes {}', { name: 'list_my_notes', toolCallId: 'call-1' });
  push('tool', '1. 性能优化记录\n2. 前端规范\n3. 提交规范', {
    name: 'list_my_notes',
    toolCallId: 'call-1',
  });
  push('assistant', '你目前有 3 篇笔记：性能优化记录、前端规范、提交规范。');

  // 第 2 轮 + 工具调用：读正文
  push('user', '性能优化记录里写了什么');
  push('tool', 'read_my_note {"noteId":"n1"}', { name: 'read_my_note', toolCallId: 'call-2' });
  push('tool', 'longtask 那段先确认长任务为 0，根因是 Express 默认请求体上限 100KB。', {
    name: 'read_my_note',
    toolCallId: 'call-2',
  });
  push('assistant', '那篇记录讲的是：先确认长任务为 0，再把瓶颈定位到请求体上限。');

  // 第 3 轮 + 工具调用：写入
  push('user', '在性能优化记录末尾追加一行「已复核」');
  push('tool', 'write_my_note {"noteId":"n1","content":"已复核"}', {
    name: 'write_my_note',
    toolCallId: 'call-3',
  });
  push('tool', '已追加到《性能优化记录》末尾。', { name: 'write_my_note', toolCallId: 'call-3' });
  push('assistant', '已追加。');

  // 之后是纯文本轮次，用来把总数顶过 20
  const filler = [
    ['user', '我们的请求层是怎么处理 401 的'],
    ['assistant', '统一在拦截器里捕获 401，用刷新队列保证并发时只刷新一次，其余请求入队重放。'],
    ['user', '那 loading 是怎么和请求层解耦的'],
    ['assistant', '用发布订阅：请求层只负责发事件，界面自己决定要不要显示遮罩，还带了防闪烁的最短显示时长。'],
    ['user', '笔记的自动保存防抖是多少'],
    ['assistant', '800ms。切换笔记前会先落盘并取消定时器，避免内容写到另一篇。'],
    ['user', '虚拟列表的缓冲是多少行'],
    ['assistant', '上下各 6 行，行高必须与实际严格一致，否则滚动位置会漂移。'],
    ['user', '附件上传的文件名是怎么生成的'],
    ['assistant', 'UUID + 扩展名。顺带用 MIME 白名单挡掉 html 和 svg，防存储型 XSS。'],
    ['user', '群聊里每个人的颜色是怎么定的'],
    ['assistant', '按会话内成员序号取色，保证 7 人以内不撞色；单聊没有撞色语境，仍按 id 哈希。'],
    ['user', '好，先记到这'],
    ['assistant', '好的，有需要随时喊我。'],
    ['user', '最后一个问题：历史记录能翻到最早吗'],
    ['assistant', '这取决于后端给的历史接口是否做了截断 —— 正是这条消息要验证的事情。'],
    ['user', '收到'],
    ['assistant', '👌'],
    ['user', '再确认一下'],
    ['assistant', '确认完毕。'],
  ];
  for (const [role, content] of filler) push(role, content);

  // 末尾再放一组工具轮次：确保它落在「最近 20 条」范围内，
  // 否则历史截断会把它一起切掉，看不到工具卡片回显的问题
  push('user', '再帮我把那篇笔记的标题改一下');
  push('tool', 'update_my_note {"noteId":"n1","title":"性能优化记录（已复核）"}', {
    name: 'update_my_note',
    toolCallId: 'call-4',
  });
  push('tool', '已更新《性能优化记录》的标题。', { name: 'update_my_note', toolCallId: 'call-4' });
  push('assistant', '标题已改为「性能优化记录（已复核）」。');

  return rows;
}

async function cleanup(db, userId) {
  if (!userId) return;
  // Conversation → Message 是 onDelete: Cascade，删会话即可带走消息
  await db.query(`DELETE FROM "Conversation" WHERE "userId" = $1`, [userId]);
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();

  const { rows: users } = await db.query(`SELECT id FROM "User" WHERE email = $1`, [TEST_EMAIL]);
  const userId = users[0]?.id;

  await cleanup(db, userId);

  if (process.argv.includes('--cleanup')) {
    console.log(JSON.stringify({ cleaned: true, userId: userId ?? null }));
    await db.end();
    return;
  }

  if (!userId) {
    throw new Error(`账号 ${TEST_EMAIL} 不存在，先跑 node test/seed-chat-visual.cjs`);
  }

  const rows = buildMessages();

  const { rows: convRows } = await db.query(
    `INSERT INTO "Conversation"(id, "userId", title, model, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, 'deepseek-flash', $3, now()) RETURNING id`,
    [userId, TITLE, agoIso(310)],
  );
  const convId = convRows[0].id;

  for (const r of rows) {
    await db.query(
      `INSERT INTO "Message"(id, "conversationId", role, content, name, "toolCallId", "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
      [convId, r.role, r.content, r.name ?? null, r.toolCallId ?? null, agoIso(r.at)],
    );
  }

  // 再建一个短会话，用来确认「短历史不受影响」
  const { rows: shortRows } = await db.query(
    `INSERT INTO "Conversation"(id, "userId", title, model, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, '短会话对照', 'deepseek-flash', $2, now()) RETURNING id`,
    [userId, agoIso(20)],
  );
  for (const [i, m] of [
    ['user', '短会话第一条'],
    ['assistant', '短会话第二条'],
    ['user', '短会话第三条'],
    ['assistant', '短会话第四条'],
  ].entries()) {
    await db.query(
      `INSERT INTO "Message"(id, "conversationId", role, content, "createdAt")
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [shortRows[0].id, m[0], m[1], agoIso(20 - i)],
    );
  }

  const token = await new JwtService().signAsync(
    { sub: userId, email: TEST_EMAIL },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '12h' },
  );

  console.log(
    JSON.stringify(
      {
        userId,
        email: TEST_EMAIL,
        token,
        longConversation: { id: convId, title: TITLE, messageCount: rows.length },
        shortConversation: { id: shortRows[0].id, messageCount: 4 },
        toolPairs: 3,
      },
      null,
      2,
    ),
  );

  await db.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
