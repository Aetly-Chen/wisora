/**
 * 聊天模块演示数据播种。
 *
 * 用途：给某个账号造一批好友 / 会话 / 消息，让聊天页有东西可看、可测。
 * 数据是**直接写库**的（不走 API）—— 因为目标账号可能是你自己的真实账号，
 * 脚本不知道你的密码，无法登录取令牌。
 * 接口层面的正确性由 `verify-chat.cjs` 单独覆盖（72 项断言）。
 *
 * 用法：
 *   cd backend
 *   node test/seed-chat-demo.cjs                          # 给默认账号造数据
 *   node test/seed-chat-demo.cjs --me 896306149@qq.com    # 指定账号
 *   node test/seed-chat-demo.cjs --json                   # 额外输出令牌等机器可读信息
 *   node test/seed-chat-demo.cjs --reset                  # 清掉全部演示数据
 *
 * 幂等：重复执行不会产生重复的好友、会话与消息（会先清掉同会话的旧演示消息）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const { Client } = require(
  path.join(ROOT, 'node_modules/.pnpm/pg@8.23.0/node_modules/pg'),
);
const { JwtService } = require('@nestjs/jwt');
require('dotenv/config');

const DEFAULT_ME = '896306149@qq.com';
/** 演示账号统一用这个前缀，便于一键清理 */
const PEER_PREFIX = 'demo-chat-';
const PEER_DOMAIN = '@wisora.local';

/* ------------------------------ 参数 ------------------------------ */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const ME_EMAIL = value('me', DEFAULT_ME);
const JSON_OUT = flag('json');
const RESET = flag('reset');

/** 演示好友。name 与 handle 都写死，保证每次播出来的界面一致 */
const PEERS = [
  {
    email: `${PEER_PREFIX}shenyanzhou${PEER_DOMAIN}`,
    nickname: '沈砚舟',
    handle: 'shenyanzhou',
    bio: '后端 / 基础设施',
  },
  {
    email: `${PEER_PREFIX}linzhiwei${PEER_DOMAIN}`,
    nickname: '林知微',
    handle: 'linzhiwei',
    bio: '交互设计',
  },
  {
    email: `${PEER_PREFIX}heche${PEER_DOMAIN}`,
    nickname: '何澈',
    handle: 'heche',
    bio: '产品',
  },
  {
    email: `${PEER_PREFIX}qiuchi${PEER_DOMAIN}`,
    nickname: '邱迟',
    handle: 'qiuchi',
    bio: '前端',
  },
];

const log = (...args) => {
  if (!JSON_OUT) console.log(...args);
};

/* ------------------------------ 工具 ------------------------------ */

/** 由两个成员 id 生成单聊去重键，与 ConversationsService 的算法一致 */
const directKeyOf = (a, b) => [a, b].sort().join(':');

async function upsertUser(db, { email, nickname, handle, bio }) {
  const found = await db.query('SELECT id FROM "User" WHERE email=$1', [email]);
  if (found.rows.length > 0) {
    await db.query(
      'UPDATE "User" SET nickname=$2, handle=$3, bio=$4 WHERE id=$1',
      [found.rows[0].id, nickname, handle, bio ?? null],
    );
    return found.rows[0].id;
  }
  const created = await db.query(
    `INSERT INTO "User"(id,email,password,nickname,handle,bio,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,'demo-not-loginable',$2,$3,$4,now(),now()) RETURNING id`,
    [email, nickname, handle, bio ?? null],
  );
  return created.rows[0].id;
}

async function addFriendship(db, userId, friendId, alias = null) {
  for (const [a, b] of [
    [userId, friendId],
    [friendId, userId],
  ]) {
    await db.query(
      `INSERT INTO "ChatFriendship"(id,"userId","friendId",alias,"createdAt")
       VALUES(gen_random_uuid(),$1,$2,$3,now())
       ON CONFLICT ("userId","friendId") DO UPDATE SET alias = EXCLUDED.alias`,
      [a, b, a === userId ? alias : null],
    );
  }
}

async function ensureDirectConversation(db, a, b) {
  const key = directKeyOf(a, b);
  const found = await db.query(
    'SELECT id FROM "ChatConversation" WHERE "directKey"=$1',
    [key],
  );
  if (found.rows.length > 0) {
    await db.query(
      `INSERT INTO "ChatConversationMember"(id,"conversationId","userId","joinedAt")
       VALUES(gen_random_uuid(),$1,$2,now())
       ON CONFLICT ("conversationId","userId") DO NOTHING`,
      [found.rows[0].id, a],
    );
    await db.query(
      `INSERT INTO "ChatConversationMember"(id,"conversationId","userId","joinedAt")
       VALUES(gen_random_uuid(),$1,$2,now())
       ON CONFLICT ("conversationId","userId") DO NOTHING`,
      [found.rows[0].id, b],
    );
    return found.rows[0].id;
  }
  const created = await db.query(
    `INSERT INTO "ChatConversation"(id,kind,"directKey","createdAt","updatedAt")
     VALUES(gen_random_uuid(),'DIRECT',$1,now(),now()) RETURNING id`,
    [key],
  );
  const convId = created.rows[0].id;
  for (const uid of [a, b]) {
    await db.query(
      `INSERT INTO "ChatConversationMember"(id,"conversationId","userId","joinedAt")
       VALUES(gen_random_uuid(),$1,$2,now())`,
      [convId, uid],
    );
  }
  return convId;
}

async function ensureGroupConversation(db, ownerId, memberIds, title) {
  /*
   * 幂等判断必须带上「我是不是成员」。
   *
   * 群聊不是全局资源 —— 同一个群名可能是另一个演示账号建的，
   * 只按 title 找会命中别人的群并直接返回，于是当前账号
   * 完全不在成员列表里，会话列表里什么都看不到。
   */
  const found = await db.query(
    `SELECT c.id FROM "ChatConversation" c
     JOIN "ChatConversationMember" m
       ON m."conversationId" = c.id AND m."userId" = $2 AND m."leftAt" IS NULL
     WHERE c.kind = 'GROUP' AND c.title = $1`,
    [title, ownerId],
  );
  if (found.rows.length > 0) return found.rows[0].id;

  const created = await db.query(
    `INSERT INTO "ChatConversation"(id,kind,title,"ownerId","createdAt","updatedAt")
     VALUES(gen_random_uuid(),'GROUP',$1,$2,now(),now()) RETURNING id`,
    [title, ownerId],
  );
  const convId = created.rows[0].id;
  for (const uid of [ownerId, ...memberIds]) {
    await db.query(
      `INSERT INTO "ChatConversationMember"(id,"conversationId","userId","joinedAt")
       VALUES(gen_random_uuid(),$1,$2,now())`,
      [convId, uid],
    );
  }
  return convId;
}

/**
 * 写入一条消息。
 * @param offsetMinutes 相对现在往前推多少分钟，用来造出「昨天 / 今天」的分隔
 */
async function addMessage(db, { convId, senderId, kind, text, note, attachmentId, minutesAgo }) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const created = await db.query(
    `INSERT INTO "ChatMessage"(id,"conversationId","senderId",kind,text,
       "noteId","noteTitle","noteKind","noteChildCount",status,"createdAt","updatedAt")
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,'READ',$9,$9) RETURNING id`,
    [
      convId,
      senderId,
      kind,
      text ?? null,
      note?.noteId ?? null,
      note?.title ?? null,
      note?.kind ?? null,
      note?.childCount ?? 0,
      at,
    ],
  );
  const messageId = created.rows[0].id;
  if (attachmentId) {
    // 注意参数顺序：是把这条附件的 messageId 指到刚建的消息上。
    // 写反成 `SET messageId=$2 WHERE id=$1` 会去更新一条 id 等于 messageId 的行
    // （不存在），而把 messageId 设成附件自己的 id —— 静默不生效，
    // 表现为「消息有 kind=image 但没有附件」，气泡直接不渲染
    await db.query('UPDATE "ChatAttachment" SET "messageId"=$1 WHERE id=$2', [
      messageId,
      attachmentId,
    ]);
  }
  return messageId;
}

/**
 * 落一个演示附件：把文件复制进 uploads 并写元数据。
 *
 * 直接写盘而不是调上传接口，同样是因为演示账号登不进去。
 * 文件名用随机串，与 StorageService 的规则一致。
 */
async function addAttachment(db, { uploaderId, sourcePath, filename, mimeType }) {
  const uploadDir = path.resolve(ROOT, process.env.UPLOAD_DIR ?? 'uploads');
  await fs.promises.mkdir(uploadDir, { recursive: true });

  const ext = path.extname(sourcePath).toLowerCase();
  const storageKey = `${randomUUID()}${ext}`;
  const bytes = await fs.promises.readFile(sourcePath);
  await fs.promises.writeFile(path.join(uploadDir, storageKey), bytes);

  const row = await db.query(
    `INSERT INTO "ChatAttachment"(id,"uploaderId",filename,"storageKey","mimeType",size,"createdAt")
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,now()) RETURNING id`,
    [uploaderId, filename, storageKey, mimeType, bytes.length],
  );
  return { id: row.rows[0].id, size: bytes.length };
}

/* ------------------------------ 主流程 ------------------------------ */

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_URL.replace(/"/g, ''),
  });
  await db.connect();

  /* -------- reset：只清演示数据，不动目标账号自己的东西 -------- */
  if (RESET) {
    const peers = await db.query('SELECT id FROM "User" WHERE email LIKE $1', [
      `${PEER_PREFIX}%`,
    ]);
    const ids = peers.rows.map((r) => r.id);
    for (const id of ids) await purgeUser(db, id);
    const groups = await db.query(
      `SELECT id FROM "ChatConversation" WHERE kind='GROUP' AND title LIKE '演示%'`,
    );
    for (const g of groups.rows) {
      await db.query('DELETE FROM "ChatAttachment" WHERE "messageId" IN (SELECT id FROM "ChatMessage" WHERE "conversationId"=$1)', [g.id]);
      await db.query('DELETE FROM "ChatMessage" WHERE "conversationId"=$1', [g.id]);
      await db.query('DELETE FROM "ChatConversationMember" WHERE "conversationId"=$1', [g.id]);
      await db.query('DELETE FROM "ChatConversation" WHERE id=$1', [g.id]);
    }
    log(`已清理 ${ids.length} 个演示账号与 ${groups.rows.length} 个演示群聊`);
    await db.end();
    if (JSON_OUT) process.stdout.write(JSON.stringify({ reset: true }) + '\n');
    return;
  }

  /* -------- 目标账号 -------- */
  let me = (
    await db.query('SELECT id, nickname, email FROM "User" WHERE email=$1', [
      ME_EMAIL,
    ])
  ).rows[0];

  if (!me) {
    const created = await db.query(
      `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
       VALUES(gen_random_uuid(),$1,'demo-not-loginable','演示用户',now(),now())
       RETURNING id, nickname, email`,
      [ME_EMAIL],
    );
    me = created.rows[0];
    log(`目标账号不存在，已创建：${ME_EMAIL}`);
  }
  const meId = me.id;
  log(`目标账号：${me.nickname ?? ''} <${me.email}>`);

  /* -------- 好友 -------- */
  const peerIds = [];
  for (const p of PEERS) {
    const id = await upsertUser(db, p);
    await addFriendship(db, meId, id);
    peerIds.push({ ...p, id });
  }
  log(`好友：${PEERS.map((p) => p.nickname).join('、')}`);

  /* -------- 单聊 + 消息 -------- */
  const [shen, lin, he, qiu] = peerIds;
  const directId = await ensureDirectConversation(db, meId, shen.id);

  // 清掉这个会话里的旧演示消息，保证幂等（附件记录一并清）
  const oldAttachments = await db.query(
    `SELECT id,"storageKey" FROM "ChatAttachment"
     WHERE "messageId" IN (SELECT id FROM "ChatMessage" WHERE "conversationId"=$1)`,
    [directId],
  );
  for (const a of oldAttachments.rows) {
    const uploadDir = path.resolve(ROOT, process.env.UPLOAD_DIR ?? 'uploads');
    await fs.promises.unlink(path.join(uploadDir, a.storageKey)).catch(() => {});
  }
  await db.query(
    `UPDATE "ChatAttachment" SET "messageId"=NULL
     WHERE "messageId" IN (SELECT id FROM "ChatMessage" WHERE "conversationId"=$1)`,
    [directId],
  );
  await db.query('DELETE FROM "ChatMessage" WHERE "conversationId"=$1', [directId]);
  await db.query(
    'DELETE FROM "ChatAttachment" WHERE "messageId" IS NULL AND "uploaderId" = ANY($1::text[])',
    [peerIds.map((p) => p.id)],
  );

  // 「昨天」几条，用来验证日期分隔
  await addMessage(db, {
    convId: directId, senderId: shen.id, kind: 'TEXT',
    text: '昨天的构建结果出来了，虚拟列表那块的帧率稳定在 58 以上。', minutesAgo: 1500,
  });
  await addMessage(db, {
    convId: directId, senderId: meId, kind: 'TEXT',
    text: '好，那我把这套实现整理进文档。', minutesAgo: 1490,
  });

  // 「今天」的来回
  await addMessage(db, {
    convId: directId, senderId: shen.id, kind: 'TEXT',
    text: '顺手把导入的性能数据也补进去了：主线程阻塞从 1167ms 降到 74ms。', minutesAgo: 96,
  });
  await addMessage(db, {
    convId: directId, senderId: shen.id, kind: 'TEXT',
    text: '这个是长任务测量的截图，你确认下口径。', minutesAgo: 95,
  });

  // 图片消息：内容是仓库里现成的 webp（白名单里有 image/webp）
  const imageSource = path.resolve(
    ROOT,
    '../frontend/public/parallax/scene-1.webp',
  );
  if (fs.existsSync(imageSource)) {
    const img = await addAttachment(db, {
      uploaderId: shen.id,
      sourcePath: imageSource,
      filename: '长任务测量.webp',
      mimeType: 'image/webp',
    });
    await addMessage(db, {
      convId: directId, senderId: shen.id, kind: 'IMAGE',
      text: '这是优化后的曲线', attachmentId: img.id, minutesAgo: 94,
    });
  }

  // 文件消息
  const fileBytes = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  const tmpFile = path.join(ROOT, 'uploads', '.demo-seed.pdf');
  await fs.promises.mkdir(path.dirname(tmpFile), { recursive: true });
  await fs.promises.writeFile(tmpFile, fileBytes);
  const file = await addAttachment(db, {
    uploaderId: shen.id,
    sourcePath: tmpFile,
    filename: '接口设计稿.pdf',
    mimeType: 'application/pdf',
  });
  await fs.promises.unlink(tmpFile).catch(() => {});
  await addMessage(db, {
    convId: directId, senderId: shen.id, kind: 'FILE',
    attachmentId: file.id, minutesAgo: 93,
  });

  // 笔记分享卡片（先造一个带子页面的目录）
  const noteRow = await db.query(
    `INSERT INTO "Note"(id,"userId",title,content,"updatedAt")
     VALUES(gen_random_uuid(),$1,'导入性能优化记录','# 优化记录
',now()) RETURNING id`,
    [meId],
  );
  const noteId = noteRow.rows[0].id;
  for (const t of ['长任务测量', '虚拟列表']) {
    await db.query(
      `INSERT INTO "Note"(id,"userId",title,content,"parentId","updatedAt")
       VALUES(gen_random_uuid(),$1,$2,'',$3,now())`,
      [meId, t, noteId],
    );
  }
  await addMessage(db, {
    convId: directId, senderId: meId, kind: 'NOTE',
    text: '整理好了，你看下有没有漏的。',
    note: { noteId, title: '导入性能优化记录', kind: 'folder', childCount: 2 },
    minutesAgo: 40,
  });
  await addMessage(db, {
    convId: directId, senderId: shen.id, kind: 'TEXT',
    text: '收到，我下午过一遍。', minutesAgo: 38,
  });

  // 给我留 3 条未读，让列表上有红点
  await db.query(
    `UPDATE "ChatConversationMember" SET unread=3 WHERE "conversationId"=$1 AND "userId"=$2`,
    [directId, meId],
  );
  await db.query(
    `UPDATE "ChatConversation" SET "updatedAt"=now() WHERE id=$1`,
    [directId],
  );

  /* -------- 群聊 -------- */
  const groupId = await ensureGroupConversation(
    db,
    meId,
    [lin.id, he.id, qiu.id],
    '演示群 · 工作台周会',
  );
  const groupCount = await db.query(
    'SELECT count(*)::int AS n FROM "ChatMessage" WHERE "conversationId"=$1',
    [groupId],
  );
  if (groupCount.rows[0].n === 0) {
    await addMessage(db, {
      convId: groupId, senderId: lin.id, kind: 'TEXT',
      text: '界面的层级我调了一版，缩进从 14 改到 12，看起来更透气。', minutesAgo: 300,
    });
    await addMessage(db, {
      convId: groupId, senderId: he.id, kind: 'TEXT',
      text: '周会材料我放共享目录了，明天上午十点过。', minutesAgo: 280,
    });
    await addMessage(db, {
      convId: groupId, senderId: meId, kind: 'TEXT',
      text: '好，我把聊天模块的进度也一并同步。', minutesAgo: 270,
    });
  }
  await db.query(
    `UPDATE "ChatConversationMember" SET pinned=true WHERE "conversationId"=$1 AND "userId"=$2`,
    [groupId, meId],
  );

  /* -------- 输出 -------- */
  const token = await new JwtService().signAsync(
    { sub: meId, email: me.email },
    { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '2h' },
  );

  log('');
  log('已写入演示数据：');
  log(`  好友 ${PEERS.length} 位`);
  log('  单聊 1 个（含图片、文件、笔记分享卡片、3 条未读）');
  log('  群聊 1 个（已置顶）');
  log('');
  log('清理：node test/seed-chat-demo.cjs --reset');

  if (JSON_OUT) {
    process.stdout.write(
      JSON.stringify({
        meId,
        email: me.email,
        nickname: me.nickname,
        token,
        directId,
        groupId,
        peerIds: peerIds.map((p) => p.id),
        peerNames: PEERS.map((p) => p.nickname),
      }) + '\n',
    );
  }

  await db.end();
})().catch((err) => {
  console.error('播种失败：', err.message);
  process.exit(1);
});

/** 按外键顺序删掉一个演示账号的全部痕迹 */
async function purgeUser(db, userId) {
  await db.query(
    `DELETE FROM "ChatAttachment"
     WHERE "uploaderId"=$1 OR "messageId" IN (SELECT id FROM "ChatMessage" WHERE "senderId"=$1)`,
    [userId],
  );
  await db.query('DELETE FROM "ChatMessage" WHERE "senderId"=$1', [userId]);
  await db.query('DELETE FROM "ChatConversationMember" WHERE "userId"=$1', [userId]);
  await db.query(
    `DELETE FROM "ChatConversation"
     WHERE id NOT IN (SELECT DISTINCT "conversationId" FROM "ChatConversationMember")`,
  );
  await db.query(
    'DELETE FROM "ChatFriendship" WHERE "userId"=$1 OR "friendId"=$1',
    [userId],
  );
  await db.query('DELETE FROM "Note" WHERE "userId"=$1', [userId]);
  await db.query('DELETE FROM "Attachment" WHERE "userId"=$1', [userId]);
  await db.query('DELETE FROM "User" WHERE id=$1', [userId]);
}
