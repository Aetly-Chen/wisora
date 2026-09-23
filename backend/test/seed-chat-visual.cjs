/**
 * 聊天页视觉预览数据。
 *
 * 用途：给聊天页做视觉走查（气泡/时间戳/分组/未读/壁纸）时，
 * 需要一份内容固定、覆盖到每种消息形态的数据。真实账号里的数据
 * 是随机的，截图往往恰好落在"只有两条纯文本"上。
 *
 * 跑法：
 *   cd backend && node test/seed-chat-visual.cjs            # 建数据，打印可用的 access token
 *   cd backend && node test/seed-chat-visual.cjs --cleanup  # 删掉这批预览数据
 *
 * 刻意用 viz-*@wisora.local 这个独立命名空间，并且自带清理：
 * 绝不动真实用户的账号与会话（上一轮聊天模块往真实账号塞过演示数据，
 * 用户明确要求不要再出现这种情况）。
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { Client } = require(
  path.join(ROOT, 'node_modules/.pnpm/pg@8.23.0/node_modules/pg'),
);
const { JwtService } = require('@nestjs/jwt');
require('dotenv/config');

const PEOPLE = {
  a: { email: 'viz-a@wisora.local', nickname: '揭泽磊', handle: 'jiezeei' },
  b: { email: 'viz-b@wisora.local', nickname: '林以唯', handle: 'linyiwei' },
  c: { email: 'viz-c@wisora.local', nickname: '周慕云', handle: 'zhoumuyun' },
  d: { email: 'viz-d@wisora.local', nickname: '苏见月', handle: 'sujianyue' },
};

const MINUTE = 60_000;
const now = Date.now();
/**
 * 距现在 n 分钟的时间点，用来把消息铺到最近三天里。
 *
 * 返回 **ISO 字符串**而不是 Date 对象，这一条是必须的：
 * Prisma 的 DateTime 落库是 `timestamp without time zone`，
 * node-postgres 会把 Date 按「本地时间」序列化（带 +08:00 偏移），
 * PG 接到 timestamp 列时把偏移丢掉 —— 存进去的成了本地墙上时间，
 * 而读取时被当成 UTC，前端再转回本地就整整差了 8 小时。
 * 传 ISO 字符串则按 UTC 写入，与 Prisma 的行为一致，读回来才对得上。
 */
const ago = (minutes) => new Date(now - minutes * MINUTE).toISOString();

/**
 * 单聊：我自己(a) × 林以唯(b)。
 *
 * 覆盖点：
 *  - 跨三天 → 三个日期分隔胶囊
 *  - 连续三条同一个人 → 检查分组间距与"只挂一个头像"
 *  - 长文本 + 换行 → 检查气泡换行与最大宽度
 *  - 文件 / 笔记卡片 → 检查气泡内的卡片底色
 *  - 自己发的带 READ 勾、对方带时间
 */
const DIRECT_MESSAGES = [
  { from: 'a', kind: 'TEXT', at: 2942, text: '聊天的视觉稿我按 Telegram 的路子重做了一版，你有空看下' },
  { from: 'b', kind: 'TEXT', at: 2940, text: '好，我翻一下' },
  { from: 'b', kind: 'TEXT', at: 2938, text: '壁纸那层会不会跟白气泡打架' },

  { from: 'a', kind: 'TEXT', at: 1625, text: '不会，渐变压得很浅，气泡边界还是清楚的' },
  { from: 'a', kind: 'TEXT', at: 1623, text: '唯一动过的是蓝色：选中行用了加深档，白字才过得了对比度' },
  { from: 'b', kind: 'TEXT', at: 1615, text: '这个取舍我同意，原版那个蓝白字确实糊' },
  { from: 'a', kind: 'TEXT', at: 1610, text: '那我把尾巴和圆角也一起收一下' },

  { from: 'b', kind: 'TEXT', at: 302, text: '早上好' },
  { from: 'b', kind: 'TEXT', at: 301, text: '尾巴这块我有个想法' },
  { from: 'b', kind: 'TEXT', at: 300, text: '只有一组消息的最后一条才长尾巴，中间那些不要' },
  { from: 'a', kind: 'TEXT', at: 296, text: '对，就是这样。而且那一侧的圆角要归零，否则尾巴跟圆角会打架' },
  { from: 'b', kind: 'FILE', at: 240, text: '这是上次那个时序图' },
  { from: 'a', kind: 'NOTE', at: 232, text: '顺手把笔记也发你' },
  {
    from: 'a',
    kind: 'TEXT',
    at: 120,
    status: 'READ',
    text: '还有两点一起说：\n1. 时间戳和已读勾都放在气泡内右下角，不额外占一行\n2. 失败的消息不删，标红给重发入口',
  },
  { from: 'b', kind: 'TEXT', at: 6, text: '收到，我下午动一版' },
];

const GROUP_MESSAGES = [
  { from: 'c', kind: 'TEXT', at: 480, text: '群聊里的昵称要不要按人上色' },
  { from: 'b', kind: 'TEXT', at: 476, text: '上。Telegram 是同一套颜色既给头像也给昵称' },
  { from: 'a', kind: 'TEXT', at: 470, text: '那就用同一套哈希取值，同一个人两处必须一致' },
  { from: 'd', kind: 'TEXT', at: 90, text: '白底上 #7bc862 当正文太浅了，得用加深版' },
  { from: 'a', kind: 'TEXT', at: 86, text: '已经在做了，昵称那组全部拉到 4.5:1 以上' },
  { from: 'c', kind: 'TEXT', at: 12, text: '那这版可以走查了' },
];

const SINGLE_MESSAGES = [
  { from: 'c', kind: 'TEXT', at: 60, text: '笔记那块的右键分享入口做好了记得喊我' },
];

async function cleanupUser(db, userId) {
  // 先删会话（级联清掉成员、消息、附件），再删人，否则留下了无主会话
  await db.query(
    `DELETE FROM "ChatConversation" WHERE id IN (
       SELECT "conversationId" FROM "ChatConversationMember" WHERE "userId" = $1
     )`,
    [userId],
  );
  await db.query(`DELETE FROM "User" WHERE id = $1`, [userId]);
}

async function cleanup(db) {
  for (const { email } of Object.values(PEOPLE)) {
    const { rows } = await db.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    for (const row of rows) await cleanupUser(db, row.id);
  }
  /*
   * 兜底：中途失败会留下「已经建好会话、成员还没插进去」的行，
   * 上面按成员反查的方式找不到它，必须按前缀再清一次。
   */
  await db.query(`DELETE FROM "ChatConversation" WHERE id LIKE 'viz-conv-%'`);
}

/** 建会话 + 成员 + 消息。返回会话 id */
async function buildConversation(
  db,
  { slug, kind, title, ownerId, members, messages, pins = {} },
) {
  const conversationId = `viz-conv-${slug}`;
  const directKey = kind === 'DIRECT' ? [...members].sort().join(':') : null;

  await db.query(
    `INSERT INTO "ChatConversation"(id,kind,title,"ownerId","directKey","createdAt","updatedAt")
     VALUES($1,$2::"ChatConversationKind",$3,$4,$5,$6,$7)`,
    [
      conversationId,
      kind,
      title,
      ownerId,
      directKey,
      ago(3000),
      messages.length ? ago(messages[messages.length - 1].at) : ago(3000),
    ],
  );

  for (const userId of members) {
    const setting = pins[userId] ?? {};
    await db.query(
      `INSERT INTO "ChatConversationMember"
         (id,"conversationId","userId",pinned,muted,unread,"lastReadAt","joinedAt")
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,now())`,
      [
        conversationId,
        userId,
        setting.pinned ?? false,
        setting.muted ?? false,
        setting.unread ?? 0,
        setting.unread ? ago(3000) : ago(0),
      ],
    );
  }

  for (let index = 0; index < messages.length; index++) {
    const raw = messages[index];
    const createdAt = ago(raw.at);
    const messageId = `viz-msg-${conversationId}-${index}`;
    const hasNote = raw.kind === 'NOTE';

    await db.query(
      `INSERT INTO "ChatMessage"
         (id,"conversationId","senderId",kind,text,"noteId","noteTitle","noteKind","noteChildCount",status,"createdAt","updatedAt")
       VALUES($1,$2,$3,$4::"ChatMessageKind",$5,$6,$7,$8,$9,$10::"ChatMessageStatus",$11,$11)`,
      [
        messageId,
        conversationId,
        raw.from,
        raw.kind,
        raw.text ?? null,
        hasNote ? `viz-note-${messageId}` : null,
        hasNote ? '票据鉴权时序图（含 SSE 换票）' : null,
        hasNote ? 'note' : null,
        0,
        raw.status ?? 'SENT',
        createdAt,
      ],
    );

    if (raw.kind === 'FILE') {
      await db.query(
        `INSERT INTO "ChatAttachment"
           (id,"messageId","uploaderId",filename,"storageKey","mimeType",size,"createdAt")
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)`,
        [
          messageId,
          raw.from,
          '票据鉴权时序图.pdf',
          `viz/${messageId}.pdf`,
          'application/pdf',
          248_320,
          createdAt,
        ],
      );
    }
  }

  return conversationId;
}

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();

  if (process.argv.includes('--cleanup')) {
    await cleanup(db);
    console.log('已清理 viz-* 预览数据');
    await db.end();
    return;
  }

  await cleanup(db); // 幂等：上一轮失败残留会被外键挡住

  const ids = {};
  for (const [key, person] of Object.entries(PEOPLE)) {
    const { rows } = await db.query(
      `INSERT INTO "User"(id,email,password,nickname,handle,bio,"createdAt","updatedAt")
       VALUES(gen_random_uuid(),$1,'x',$2,$3,$4,$5,$5) RETURNING id`,
      [person.email, person.nickname, person.handle, 'Wisora 成员', ago(60 * 24 * 30)],
    );
    ids[key] = rows[0].id;
  }

  // 双向好友关系：会话能建，好友列表也才有内容
  const pairs = [
    ['a', 'b'],
    ['a', 'c'],
    ['a', 'd'],
    ['b', 'c'],
    ['b', 'd'],
    ['c', 'd'],
  ];
  for (const [x, y] of pairs) {
    for (const [from, to] of [
      [x, y],
      [y, x],
    ]) {
      await db.query(
        `INSERT INTO "ChatFriendship"(id,"userId","friendId","createdAt")
         VALUES(gen_random_uuid(),$1,$2,now())`,
        [ids[from], ids[to]],
      );
    }
  }

  await buildConversation(db, {
    slug: 'direct-lin',
    kind: 'DIRECT',
    title: null,
    ownerId: null,
    members: [ids.a, ids.b],
    messages: DIRECT_MESSAGES.map((m) => ({ ...m, from: ids[m.from] })),
    /* 置顶 + 无未读：列表里显示图钉、不显示角标 */
    pins: { [ids.a]: { pinned: true } },
  });

  await buildConversation(db, {
    slug: 'direct-zhou',
    kind: 'DIRECT',
    title: null,
    ownerId: null,
    members: [ids.a, ids.c],
    messages: SINGLE_MESSAGES.map((m) => ({ ...m, from: ids[m.from] })),
    /* 未读 3：展示绿色数字角标 */
    pins: { [ids.a]: { unread: 3 } },
  });

  await buildConversation(db, {
    slug: 'group-frontend',
    kind: 'GROUP',
    title: 'Wisora 前端组',
    ownerId: ids.a,
    members: [ids.a, ids.b, ids.c, ids.d],
    messages: GROUP_MESSAGES.map((m) => ({ ...m, from: ids[m.from] })),
    /* 免打扰 + 未读 7：展示小圆点而不是数字 */
    pins: { [ids.a]: { muted: true, unread: 7 } },
  });

  const token = await new JwtService().signAsync(
    { sub: ids.a, email: PEOPLE.a.email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '12h' },
  );

  console.log(
    JSON.stringify(
      {
        userId: ids.a,
        email: PEOPLE.a.email,
        nickname: PEOPLE.a.nickname,
        token,
        openUrl: 'http://localhost:5173/chat',
      },
      null,
      2,
    ),
  );

  await db.end();
})();
