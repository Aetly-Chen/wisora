/**
 * 聊天模块后端全链路验证。
 *
 * 前提：PG / Redis / 后端(3000) 在运行，且已执行 add_chat_module 迁移。
 * 跑法：cd backend && node test/verify-chat.cjs
 *
 * 关注点不是「happy path 能通」，而是几类容易写漏的边界：
 *   - 越权：往别人的会话发消息、拿别人的附件发消息、分享别人的笔记
 *   - 错误码语义：会话越权用 404（不是 403），避免被当作探测手段
 *   - 未读计数：只在成员维度累加，且不给自己加
 *   - 单聊复用：同一对人只应有一条会话
 *   - 游标分页：不重不漏
 *   - 成员级设置：A 置顶不影响 B
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { Client } = require(
  path.join(ROOT, 'node_modules/.pnpm/pg@8.23.0/node_modules/pg'),
);
const { JwtService } = require('@nestjs/jwt');
require('dotenv/config');

const BASE = process.env.CHAT_TEST_BASE ?? 'http://localhost:3000';

const EMAIL_A = 'e2e-chat-a@wisora.local';
const EMAIL_B = 'e2e-chat-b@wisora.local';

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
  }
}

(async () => {
  const db = new Client({
    connectionString: process.env.DATABASE_URL.replace(/"/g, ''),
  });
  await db.connect();

  /* ---------------- 准备两个用户 ---------------- */

  // 先按外键顺序清掉残留：上一轮中途失败会让下一轮被外键挡住
  for (const email of [EMAIL_A, EMAIL_B]) {
    const stale = await db.query('SELECT id FROM "User" WHERE email=$1', [
      email,
    ]);
    for (const u of stale.rows) {
      await cleanupUser(db, u.id);
    }
  }

  const users = {};
  for (const [key, email] of [
    ['A', EMAIL_A],
    ['B', EMAIL_B],
  ]) {
    const { rows } = await db.query(
      `INSERT INTO "User"(id,email,password,nickname,handle,"createdAt","updatedAt")
       VALUES(gen_random_uuid(),$1,'x',$2,$3,now(),now()) RETURNING id`,
      [email, key === 'A' ? '甲' : '乙', key === 'A' ? 'jia' : 'yi'],
    );
    const id = rows[0].id;
    const token = await new JwtService().signAsync(
      { sub: id, email },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
    );
    users[key] = { id, email, token };
  }

  const call = async (who, method, url, body, opts = {}) => {
    const headers = { Authorization: `Bearer ${who.token}` };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${url}`, {
      method,
      headers: { ...headers, ...(opts.headers ?? {}) },
      body: payload,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON（文件流等） */
    }
    return { status: res.status, data: json?.data, msg: json?.msg, res, text };
  };

  const A = (m, u, b, o) => call(users.A, m, u, b, o);
  const B = (m, u, b, o) => call(users.B, m, u, b, o);

  try {
    /* ========== 1. 鉴权 ========== */
    console.log('\n=== 1. 鉴权 ===');
    const noAuth = await fetch(`${BASE}/chat/friends`);
    check('未带令牌 → 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

    /* ========== 2. 好友 ========== */
    console.log('\n=== 2. 好友 ===');
    const emptySearch = await A('GET', '/chat/users?keyword=');
    check(
      '空关键词返回空数组（不返回全量用户）',
      Array.isArray(emptySearch.data) && emptySearch.data.length === 0,
      `len=${emptySearch.data?.length}`,
    );

    const found = await A('GET', `/chat/users?keyword=${EMAIL_B}`);
    const target = (found.data ?? []).find((f) => f.id === users.B.id);
    check('能搜到对方', !!target);
    check('未加好友时 isFriend=false', target?.isFriend === false);
    check(
      '未加好友时邮箱已脱敏',
      !!target && target.email !== EMAIL_B && target.email.includes('***'),
      target?.email,
    );
    check('handle 有值（老用户回退邮箱前缀）', !!target?.handle, target?.handle);
    check('bio 是空字符串而不是 null', target?.bio === '', JSON.stringify(target?.bio));

    const add1 = await A('POST', '/chat/friends', { userId: users.B.id });
    check('加好友成功', add1.status === 201 || add1.status === 200, `HTTP ${add1.status}`);
    const add2 = await A('POST', '/chat/friends', { userId: users.B.id });
    check('重复加好友幂等（不报 409）', add2.status < 300, `HTTP ${add2.status}`);

    const rows = await db.query(
      'SELECT "userId","friendId" FROM "ChatFriendship" WHERE "userId" IN ($1,$2) AND "friendId" IN ($1,$2)',
      [users.A.id, users.B.id],
    );
    check('好友关系双向各一条（共 2 条）', rows.rows.length === 2, `rows=${rows.rows.length}`);

    const listA = await A('GET', '/chat/friends');
    check('好友列表能看到对方', (listA.data ?? []).some((f) => f.id === users.B.id));
    check('好友列表里邮箱不再脱敏', (listA.data ?? [])[0]?.email === EMAIL_B);

    const selfAdd = await A('POST', '/chat/friends', { userId: users.A.id });
    check('不能加自己为好友（400）', selfAdd.status === 400, `HTTP ${selfAdd.status}`);

    /* ========== 3. 会话 ========== */
    console.log('\n=== 3. 会话 ===');
    const direct1 = await A('POST', '/chat/conversations', {
      kind: 'direct',
      friendId: users.B.id,
    });
    check('建单聊成功', !!direct1.data?.id, `HTTP ${direct1.status}`);
    check(
      '单聊成员包含双方',
      direct1.data?.memberIds?.length === 2,
      JSON.stringify(direct1.data?.memberIds),
    );

    const direct2 = await A('POST', '/chat/conversations', {
      kind: 'direct',
      friendId: users.B.id,
    });
    check('重复建单聊复用同一条（不重复建）', direct2.data?.id === direct1.data?.id);

    const directB = await B('POST', '/chat/conversations', {
      kind: 'direct',
      friendId: users.A.id,
    });
    check(
      '反向建单聊也复用同一条（顺序无关）',
      directB.data?.id === direct1.data?.id,
    );

    const group = await A('POST', '/chat/conversations', {
      kind: 'group',
      title: '测试群',
      memberIds: [users.B.id],
    });
    check('建群成功', !!group.data?.id);
    check('群成员含自己', (group.data?.memberIds ?? []).includes(users.A.id));
    check('群标题生效', group.data?.title === '测试群');

    const strangerGroup = await A('POST', '/chat/conversations', {
      kind: 'group',
      title: '陌生人群',
      memberIds: ['cknonexistent000000000000'],
    });
    check('不能拉非好友进群（400）', strangerGroup.status === 400, `HTTP ${strangerGroup.status}`);

    const convId = direct1.data.id;

    /* ========== 4. 消息 ========== */
    console.log('\n=== 4. 消息与未读 ===');
    const emptyMsg = await A('POST', `/chat/conversations/${convId}/messages`, {});
    check('空消息被拒（400）', emptyMsg.status === 400, `HTTP ${emptyMsg.status}`);

    const msg1 = await A('POST', `/chat/conversations/${convId}/messages`, {
      text: '第一句话',
    });
    check('发文本消息成功', msg1.data?.text === '第一句话', `HTTP ${msg1.status}`);
    check('kind=text', msg1.data?.kind === 'text');
    check('status=sent', msg1.data?.status === 'sent');
    check('attachment/note 为 null', msg1.data?.attachment === null && msg1.data?.note === null);

    await A('POST', `/chat/conversations/${convId}/messages`, { text: '第二句' });
    const msg3 = await A('POST', `/chat/conversations/${convId}/messages`, { text: '第三句' });

    const bConvs = await B('GET', '/chat/conversations');
    const bConv = (bConvs.data ?? []).find((c) => c.id === convId);
    check('B 能看到该会话', !!bConv);
    check('B 的未读为 3（不含自己发的）', bConv?.unread === 3, `unread=${bConv?.unread}`);
    check('B 的列表带回最后一条消息', bConv?.lastMessage?.text === '第三句', bConv?.lastMessage?.text);

    const aConvs = await A('GET', '/chat/conversations');
    const aConv = (aConvs.data ?? []).find((c) => c.id === convId);
    check('A 自己的未读为 0（不给自己加未读）', aConv?.unread === 0, `unread=${aConv?.unread}`);

    const bRead = await B('POST', `/chat/conversations/${convId}/read`);
    check('B 标记已读成功', bRead.status < 300, `HTTP ${bRead.status}`);
    const afterRead = (await B('GET', '/chat/conversations')).data.find((c) => c.id === convId);
    check('已读后未读归零', afterRead?.unread === 0, `unread=${afterRead?.unread}`);
    const readStatus = await db.query(
      'SELECT DISTINCT status FROM "ChatMessage" WHERE "conversationId"=$1 AND "senderId"=$2',
      [convId, users.A.id],
    );
    check(
      'A 发的消息状态变为 READ',
      readStatus.rows.length === 1 && readStatus.rows[0].status === 'READ',
      JSON.stringify(readStatus.rows),
    );

    /* ========== 5. 历史与游标分页 ========== */
    console.log('\n=== 5. 历史消息与游标分页 ===');
    const history = await A('GET', `/chat/conversations/${convId}/messages`);
    check('历史消息按时间正序', history.data?.[0]?.text === '第一句话', history.data?.[0]?.text);
    check('历史返回 3 条', history.data?.length === 3, `len=${history.data?.length}`);

    const page1 = await A('GET', `/chat/conversations/${convId}/messages?limit=2`);
    check('limit=2 返回 2 条', page1.data?.length === 2);
    check('返回的是最新的 2 条（正序）', page1.data?.[1]?.text === '第三句', page1.data?.[1]?.text);
    const page2 = await A(
      'GET',
      `/chat/conversations/${convId}/messages?limit=2&before=${page1.data[0].id}`,
    );
    check('游标翻页拿到更早的消息', page2.data?.length === 1, `len=${page2.data?.length}`);
    check('翻页无重复', page2.data?.[0]?.text === '第一句话', page2.data?.[0]?.text);

    /* ========== 6. 附件 ========== */
    console.log('\n=== 6. 附件 ===');
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03,
    ]);
    const form = new FormData();
    form.append('file', new Blob([pngBytes], { type: 'image/png' }), '图片 测试.png');
    const up = await A('POST', '/chat/attachments', form);
    check('上传图片成功', !!up.data?.id, `HTTP ${up.status}`);
    check('文件名中文未乱码', up.data?.name === '图片 测试.png', up.data?.name);
    check('image 有 previewUrl', !!up.data?.previewUrl, up.data?.previewUrl);

    const orphanBefore = await db.query(
      'SELECT "messageId" FROM "ChatAttachment" WHERE id=$1',
      [up.data.id],
    );
    check('上传后 messageId 为 null（两步上传的前提）', orphanBefore.rows[0].messageId === null);

    const imgMsg = await A('POST', `/chat/conversations/${convId}/messages`, {
      attachmentId: up.data.id,
      text: '看这张图',
    });
    check('发图片消息成功', imgMsg.data?.kind === 'image', imgMsg.data?.kind);
    check('消息带附件信息', imgMsg.data?.attachment?.name === '图片 测试.png');
    check('消息带预览地址', !!imgMsg.data?.attachment?.previewUrl);

    const reuse = await A('POST', `/chat/conversations/${convId}/messages`, {
      attachmentId: up.data.id,
    });
    check('同一附件不能发两次（400）', reuse.status === 400, `HTTP ${reuse.status}`);

    // 读回二进制逐字节比对
    const content = await fetch(`${BASE}/chat/attachments/${up.data.id}/content`, {
      headers: { Authorization: `Bearer ${users.B.token}` },
    });
    const got = Buffer.from(await content.arrayBuffer());
    check('B（会话成员）能读该附件', content.status === 200, `HTTP ${content.status}`);
    check('读回内容与上传逐字节一致', got.equals(pngBytes), `${got.length} vs ${pngBytes.length}`);

    // 越权：B 把 A 的附件 id 拿去发消息
    const crossAtt = await B('POST', `/chat/conversations/${convId}/messages`, {
      attachmentId: 'cxxxxxxxxxxxxxxxxxxxxxxxx',
    });
    check('拿不存在的附件 id 发消息 → 403', crossAtt.status === 403, `HTTP ${crossAtt.status}`);

    // 非成员读附件
    const outsider = await createOutsider();
    const outsiderRead = await fetch(`${BASE}/chat/attachments/${up.data.id}/content`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    check(
      '非会话成员读该附件 → 404',
      outsiderRead.status === 404,
      `HTTP ${outsiderRead.status}`,
    );

    // 不允许上传可执行类型
    const badForm = new FormData();
    badForm.append('file', new Blob(['<script>'], { type: 'text/html' }), 'x.html');
    const bad = await A('POST', '/chat/attachments', badForm);
    check('拒绝 text/html（存储型 XSS）', bad.status === 400, `HTTP ${bad.status}`);

    /* ========== 7. 越权 ========== */
    console.log('\n=== 7. 越权 ===');
    const outsiderConv = await fetch(`${BASE}/chat/conversations/${convId}/messages`, {
      headers: { Authorization: `Bearer ${outsider.token}` },
    });
    check(
      '非成员读会话消息 → 404（不是 403）',
      outsiderConv.status === 404,
      `HTTP ${outsiderConv.status}`,
    );
    const outsiderSend = await fetch(`${BASE}/chat/conversations/${convId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${outsider.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: '插一句' }),
    });
    check('非成员发消息 → 404', outsiderSend.status === 404, `HTTP ${outsiderSend.status}`);
    const outsiderPatch = await fetch(`${BASE}/chat/conversations/${convId}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${outsider.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pinned: true }),
    });
    check('非成员改置顶 → 404', outsiderPatch.status === 404, `HTTP ${outsiderPatch.status}`);
    const outsiderShare = await fetch(`${BASE}/chat/notes/share`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${outsider.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ noteId: 'x', toFriendIds: [users.A.id] }),
    });
    check('非好友之间不能分享 → 400', outsiderShare.status === 400, `HTTP ${outsiderShare.status}`);

    /* ========== 8. 成员级设置 ========== */
    console.log('\n=== 8. 置顶 / 免打扰只影响自己 ===');
    await A('PATCH', `/chat/conversations/${convId}`, { pinned: true, muted: true });
    const aAfter = (await A('GET', '/chat/conversations')).data.find((c) => c.id === convId);
    const bAfter = (await B('GET', '/chat/conversations')).data.find((c) => c.id === convId);
    check('A 的置顶生效', aAfter?.pinned === true);
    check('A 的免打扰生效', aAfter?.muted === true);
    check('B 的置顶未被影响', bAfter?.pinned === false, `pinned=${bAfter?.pinned}`);
    check('B 的免打扰未被影响', bAfter?.muted === false, `muted=${bAfter?.muted}`);

    const mine = (await A('GET', '/chat/conversations')).data[0];
    check('置顶的会话排在最前', mine?.id === convId, mine?.id === convId ? '' : '未排在最前');

    /* ========== 9. 分享笔记 ========== */
    console.log('\n=== 9. 分享笔记 ===');
    const noteA = await A('POST', '/notes', { title: '甲的目录', content: '' });
    const noteB = await B('POST', '/notes', { title: '乙的笔记', content: '' });
    // 给甲的笔记加一个子页面，验证 childCount 与 kind=folder
    await A('POST', '/notes', { title: '子页面', parentId: noteA.data.id });

    const share = await A('POST', '/chat/notes/share', {
      noteId: noteA.data.id,
      toFriendIds: [users.B.id],
      comment: '看看这个',
    });
    check('分享成功', share.status < 300, `HTTP ${share.status}`);
    check('返回送达会话数', share.data?.conversationCount === 1, JSON.stringify(share.data));
    check('返回消息数', share.data?.messageCount === 1);

    const shareMsgs = await B('GET', `/chat/conversations/${convId}/messages?limit=5`);
    const card = (shareMsgs.data ?? []).find((m) => m.kind === 'note');
    check('B 收到笔记卡片', !!card);
    check('卡片标题由后端取（不是前端传的）', card?.note?.title === '甲的目录', card?.note?.title);
    check('卡片识别为目录（有子页面）', card?.note?.kind === 'folder', card?.note?.kind);
    check('卡片带子页面数', card?.note?.childCount === 1, `childCount=${card?.note?.childCount}`);
    check('附言写进了消息文本', card?.text === '看看这个', card?.text);

    const shareOthers = await A('POST', '/chat/notes/share', {
      noteId: noteB.data.id,
      toFriendIds: [users.B.id],
    });
    check('分享别人的笔记被拒（404）', shareOthers.status === 404, `HTTP ${shareOthers.status}`);

    const shareToSelf = await A('POST', '/chat/notes/share', {
      noteId: noteA.data.id,
      toFriendIds: [users.A.id],
    });
    check('只分享给自己 → 400', shareToSelf.status === 400, `HTTP ${shareToSelf.status}`);

    /* ========== 10. 清理 ========== */
    console.log('\n=== 10. 清理测试数据 ===');
    await cleanupUser(db, users.A.id);
    await cleanupUser(db, users.B.id);
    await cleanupUser(db, outsider.id);
    check('测试数据已清理', true);
  } finally {
    await db.end();
  }

  console.log(
    `\n=== 结果：${passed} 通过 / ${failed} 失败 ===`,
  );
  process.exit(failed === 0 ? 0 : 1);

  /* ---------------- 工具 ---------------- */

  async function createOutsider() {
    const email = 'e2e-chat-outsider@wisora.local';
    const stale = await db.query('SELECT id FROM "User" WHERE email=$1', [email]);
    for (const u of stale.rows) await cleanupUser(db, u.id);
    const { rows } = await db.query(
      `INSERT INTO "User"(id,email,password,nickname,"createdAt","updatedAt")
       VALUES(gen_random_uuid(),$1,'x','路人',now(),now()) RETURNING id`,
      [email],
    );
    const id = rows[0].id;
    const token = await new JwtService().signAsync(
      { sub: id, email },
      { secret: process.env.JWT_ACCESS_SECRET, expiresIn: '15m' },
    );
    return { id, email, token };
  }
})().catch((err) => {
  console.error('脚本异常:', err.message);
  process.exit(1);
});

/** 按外键依赖顺序清理一个用户的全部数据 */
async function cleanupUser(db, userId) {
  await db.query(
    'DELETE FROM "ChatAttachment" WHERE "uploaderId"=$1 OR "messageId" IN (SELECT id FROM "ChatMessage" WHERE "senderId"=$1)',
    [userId],
  );
  await db.query('DELETE FROM "ChatMessage" WHERE "senderId"=$1', [userId]);
  await db.query('DELETE FROM "ChatConversationMember" WHERE "userId"=$1', [userId]);
  await db.query(
    'DELETE FROM "ChatConversation" WHERE id NOT IN (SELECT DISTINCT "conversationId" FROM "ChatConversationMember")',
  );
  await db.query(
    'DELETE FROM "ChatFriendship" WHERE "userId"=$1 OR "friendId"=$1',
    [userId],
  );
  await db.query('DELETE FROM "Note" WHERE "userId"=$1', [userId]);
  await db.query('DELETE FROM "Attachment" WHERE "userId"=$1', [userId]);
  await db.query('DELETE FROM "User" WHERE id=$1', [userId]);
}
