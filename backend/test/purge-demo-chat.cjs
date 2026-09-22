#!/usr/bin/env node
/**
 * 清掉聊天模块的演示 / 测试残留数据。
 *
 * 默认只预演（列出会删什么），加 --apply 才真正执行。
 *
 * 存在的原因：`seed-chat-demo.cjs` 是给浏览器端到端测试造夹具的，
 * 它建的账号（demo-chat-*）不在测试的清理范围内，于是每跑一次测试
 * 就会在库里多留一批假联系人；如果再用 `--me <真实邮箱>` 播给真实
 * 账号，这些假联系人就会出现在对方的聊天列表里 —— 这是实际发生过的
 * 事故，所以专门留一个可复用的清理工具，而不是每次手写 SQL。
 *
 * 判定「假数据」的规则：
 *   1. 邮箱前缀是 `demo-chat-` 或 `e2e-` 的账号，及其全部关联数据
 *   2. 成员少于 2 人的会话 —— 谁都打不开，纯粹是清理不彻底的残留
 *   3. 标题含「演示」的群聊
 *
 * 不会碰的：普通账号（含邮箱里恰好带数字的）、真实好友关系、笔记、AI 会话。
 */

const path = require('node:path');
const { Client } = require(
  path.join(__dirname, '../node_modules/.pnpm/pg@8.23.0/node_modules/pg'),
);
require('dotenv/config');

const APPLY = process.argv.includes('--apply');

(async () => {
  const db = new Client({ connectionString: process.env.DATABASE_URL.replace(/"/g, '') });
  await db.connect();

  const head = APPLY ? '【执行模式】' : '【预演模式】';
  console.log(`${head} 数据库：${process.env.DATABASE_URL.replace(/\/\/[^@]+@/, '//***@')}\n`);

  const fakeUsers = (
    await db.query(
      `SELECT id, email, nickname FROM "User"
       WHERE email LIKE 'demo-chat-%' OR email LIKE 'e2e-%'
       ORDER BY email`,
    )
  ).rows;

  const orphans = (
    await db.query(
      `SELECT c.id, c.kind, c.title FROM "ChatConversation" c
       WHERE (SELECT count(*) FROM "ChatConversationMember" m
              WHERE m."conversationId" = c.id) < 2`,
    )
  ).rows;

  const demoGroups = (
    await db.query(
      `SELECT id, title FROM "ChatConversation"
       WHERE kind = 'GROUP' AND title LIKE '%演示%'`,
    )
  ).rows;

  console.log(`演示 / 测试账号：${fakeUsers.length} 个`);
  fakeUsers.forEach((u) => console.log(`    ${u.email.padEnd(36)}${u.nickname ?? ''}`));

  console.log(`\n孤儿会话（成员不足 2 人）：${orphans.length} 个`);
  orphans.forEach((c) => console.log(`    ${c.id.slice(0, 10)} ${c.kind} ${c.title ?? '(单聊)'}`));

  console.log(`\n标题含「演示」的群聊：${demoGroups.length} 个`);
  demoGroups.forEach((c) => console.log(`    ${c.id.slice(0, 10)} ${c.title}`));

  if (!APPLY) {
    console.log('\n预演结束，未改动任何数据。确认无误后加 --apply 执行。');
    await db.end();
    return;
  }

  console.log('\n--- 开始清理 ---');
  const conversationIds = [
    ...new Set([...orphans, ...demoGroups].map((c) => c.id)),
  ];

  // 会话先清：附件按 messageId 挂在消息上，所以要走在消息前面
  for (const cid of conversationIds) {
    await db.query(
      `DELETE FROM "ChatAttachment"
       WHERE "messageId" IN (SELECT id FROM "ChatMessage" WHERE "conversationId" = $1)`,
      [cid],
    );
    await db.query('DELETE FROM "ChatMessage" WHERE "conversationId" = $1', [cid]);
    await db.query('DELETE FROM "ChatConversationMember" WHERE "conversationId" = $1', [cid]);
    await db.query('DELETE FROM "ChatConversation" WHERE id = $1', [cid]);
  }
  console.log(`  已删除会话：${conversationIds.length} 个（含其消息与附件）`);

  for (const u of fakeUsers) {
    await db.query('DELETE FROM "ChatAttachment" WHERE "uploaderId" = $1', [u.id]);
    await db.query('DELETE FROM "ChatMessage" WHERE "senderId" = $1', [u.id]);
    await db.query('DELETE FROM "ChatConversationMember" WHERE "userId" = $1', [u.id]);
    await db.query(
      'DELETE FROM "ChatFriendship" WHERE "userId" = $1 OR "friendId" = $1',
      [u.id],
    );
    // AI 助手那张表也叫 Conversation / Message，与本模块无关但同属测试残留
    await db.query(
      'DELETE FROM "Message" WHERE "conversationId" IN (SELECT id FROM "Conversation" WHERE "userId" = $1)',
      [u.id],
    );
    await db.query('DELETE FROM "Conversation" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "Note" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "Attachment" WHERE "userId" = $1', [u.id]);
    await db.query('DELETE FROM "User" WHERE id = $1', [u.id]);
  }
  console.log(`  已删除账号：${fakeUsers.length} 个`);

  // 删完账号还要回头扫一遍：真实账号与假账号之间的会话，
  // 成员行随账号一起没了，会变成新的孤儿
  const swept = await db.query(
    `DELETE FROM "ChatConversation" c
     WHERE (SELECT count(*) FROM "ChatConversationMember" m
            WHERE m."conversationId" = c.id) < 2
     RETURNING id`,
  );
  if (swept.rowCount > 0) console.log(`  连带清理的空会话：${swept.rowCount} 个`);

  console.log('\n--- 清理完成 ---');
  console.log(`剩余账号：${
    (await db.query('SELECT count(*)::int AS n FROM "User"')).rows[0].n
  } 个，会话：${
    (await db.query('SELECT count(*)::int AS n FROM "ChatConversation"')).rows[0].n
  } 个`);

  await db.end();
})().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
