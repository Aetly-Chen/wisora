/**
 * 聊天接口层。
 *
 * ⚠️ 当前是**内存 mock 实现**，后端就绪后**只改本文件**：
 * 每个函数上方都标注了它对应的后端接口（方法 + 路径），
 * 把函数体换成 `request.xxx(...)` 即可，页面与 store 零改动。
 * 配套的假数据在 `chat.mock.ts`，届时一并删除。
 *
 * 之所以不让组件直接摸 mock：接口边界一旦被绕过，
 * 后端接进来时就得回头改一堆组件，改动量与风险都不可控。
 *
 * 密钥与身份说明：真实实现里 userId 由 JWT 决定（沿用 AuthModule 的
 * JwtAuthGuard），**不接受前端传入**，否则任何人都能冒充他人发消息。
 * mock 阶段由 store 调用 setCurrentUser 注入，仅用于区分「我」和「别人」。
 */

import type {
  ChatAttachment,
  ChatEvent,
  Conversation,
  CreateGroupPayload,
  Friend,
  Message,
  SendMessagePayload,
  ShareNotePayload,
  ShareNoteResult,
} from '@/types/chat';
import { ensureSeeded, mockDb, nextId, scheduleAutoReply, subscribe } from './chat.mock';
import { CHAT_FILE_MAX_BYTES } from '@/lib/chat-utils';

/*
 * 后端就绪后这里会引入 axios 实例：
 *   import request from './index';
 * 现在不引是因为 mock 阶段用不到，留着会变成"声明了却没用的导入"。
 */

/** 模拟网络往返，让骨架屏与加载态真的被走到 */
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 注入当前登录用户。
 *
 * 真实实现是空操作：身份一律从令牌解析。
 * 保留这个函数是为了让 store 的初始化流程在两种实现下完全一致。
 */
export function setCurrentUser(userId: string): void {
  ensureSeeded(userId);
}

/* ------------------------------ 好友 ------------------------------ */

/** GET /chat/friends */
export async function listFriends(): Promise<Friend[]> {
  await delay(220);
  return mockDb.friends.filter((f) => f.isFriend).map((f) => ({ ...f }));
}

/**
 * GET /chat/users?keyword=xxx
 *
 * 按 @handle 或昵称搜索。后端应限制返回条数（这里取 20），
 * 并对邮箱等敏感字段做脱敏：不是好友就不该看到对方的完整邮箱。
 */
export async function searchUsers(keyword: string): Promise<Friend[]> {
  await delay(260);
  const q = keyword.trim().toLowerCase();
  if (!q) return [];
  return mockDb.friends
    .filter(
      (f) => f.handle.toLowerCase().includes(q) || f.name.includes(keyword.trim()),
    )
    .slice(0, 20)
    .map((f) => ({ ...f }));
}

/**
 * POST /chat/friends { userId }
 *
 * 加好友是双向还是单向由后端定；前端只按「已加/未加」渲染，
 * 不做「对方是否同意」的中间态，避免前端先假定一套审批流程。
 */
export async function addFriend(friendId: string): Promise<Friend> {
  await delay(320);
  const friend = mockDb.findFriend(friendId);
  if (!friend) throw new Error('用户不存在');
  friend.isFriend = true;
  return { ...friend };
}

/* ------------------------------ 会话 ------------------------------ */

/** GET /chat/conversations */
export async function listConversations(): Promise<Conversation[]> {
  await delay(280);
  return mockDb.conversations.map((c) => ({ ...c }));
}

/** GET /chat/conversations/:id/messages?before=&limit= */
export async function listMessages(conversationId: string): Promise<Message[]> {
  await delay(240);
  return mockDb.conversationMessages(conversationId).map((m) => ({ ...m }));
}

/**
 * POST /chat/conversations { kind: 'direct', friendId }
 *
 * 已存在与同一好友的单聊时，后端应返回**已有会话**而不是新建，
 * 否则会话列表里会出现多条与同一个人的单聊。
 */
export async function createDirectConversation(friendId: string): Promise<Conversation> {
  await delay(240);

  const existing = mockDb.findDirectWith(friendId);
  if (existing) {
    // 顺便把未读清掉：用户主动点开联系人，等同于读了
    existing.unread = 0;
    return { ...existing };
  }

  const conversation: Conversation = {
    id: nextId('cnv'),
    kind: 'direct',
    title: null,
    memberIds: [mockDb.meId, friendId],
    lastMessage: null,
    unread: 0,
    pinned: false,
    muted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockDb.conversations.push(conversation);
  return { ...conversation };
}

/** POST /chat/conversations { kind: 'group', title, memberIds } */
export async function createGroupConversation(
  payload: CreateGroupPayload,
): Promise<Conversation> {
  await delay(320);
  if (payload.memberIds.length === 0) {
    throw new Error('群聊至少要有一位成员');
  }

  const conversation: Conversation = {
    id: nextId('cnv'),
    kind: 'group',
    title: payload.title.trim() || '未命名群聊',
    // 成员列表里必须包含自己，否则「我」会看不到自己的消息
    memberIds: [mockDb.meId, ...payload.memberIds],
    lastMessage: null,
    unread: 0,
    pinned: false,
    muted: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  mockDb.conversations.push(conversation);
  return { ...conversation };
}

/**
 * PATCH /chat/conversations/:id { pinned?, muted? }
 *
 * 置顶与免打扰合成一个接口：它们都只是会话级开关，
 * 没必要为每个开关开一条路由。
 */
export async function updateConversationFlags(
  conversationId: string,
  flags: { pinned?: boolean; muted?: boolean },
): Promise<Conversation> {
  await delay(160);
  const conversation = mockDb.conversations.find((c) => c.id === conversationId);
  if (!conversation) throw new Error('会话不存在或无权访问');
  if (flags.pinned !== undefined) conversation.pinned = flags.pinned;
  if (flags.muted !== undefined) conversation.muted = flags.muted;
  return { ...conversation };
}

/** POST /chat/conversations/:id/read */
export async function markConversationRead(conversationId: string): Promise<void> {
  await delay(120);
  const conversation = mockDb.conversations.find((c) => c.id === conversationId);
  if (conversation) conversation.unread = 0;
}

/* ------------------------------ 消息与附件 ------------------------------ */

/**
 * POST /chat/attachments（multipart/form-data）
 *
 * 先传文件拿到附件 id，再带 id 发消息 —— 拆两步是为了有真实的上传进度，
 * 也为了让「发文件」和「发文本」共用同一个发消息接口。
 *
 * 校验放在前端只为提前拦住明显不合法的文件；**真正的白名单必须在后端**，
 * 前端按扩展名判断拦不住任何攻击者。
 */
export async function uploadAttachment(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<ChatAttachment> {
  if (file.size > CHAT_FILE_MAX_BYTES) {
    throw new Error(`单个文件不能超过 ${Math.round(CHAT_FILE_MAX_BYTES / 1024 / 1024)} MB`);
  }
  if (file.size === 0) {
    throw new Error('文件为空，无法发送');
  }

  // 模拟分片上传的进度回调
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await delay(45);
    onProgress?.(Math.round((i / steps) * 100));
  }

  const attachment: ChatAttachment = {
    id: nextId('att'),
    name: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
  };

  // 图片消息在气泡里直接显示缩略图；对象地址由调用方在卸载时释放
  if (attachment.mimeType.startsWith('image/')) {
    attachment.objectUrl = URL.createObjectURL(file);
    attachment.previewUrl = attachment.objectUrl;
  }

  return attachment;
}

/**
 * POST /chat/conversations/:id/messages
 *
 * body: { text?, attachmentId?, note? } 三者至少有一个。
 * 后端应校验发送者属于该会话，且附件归属当前用户（防止拿别人的附件 id 转发）。
 */
export async function sendMessage(payload: SendMessagePayload): Promise<Message> {
  await delay(260);

  const conversation = mockDb.conversations.find((c) => c.id === payload.conversationId);
  if (!conversation) throw new Error('会话不存在或无权访问');
  if (!conversation.memberIds.includes(mockDb.meId)) {
    throw new Error('你不在该会话中');
  }

  const text = payload.text?.trim() ?? '';
  const kind = payload.note ? 'note' : payload.attachment ? deriveKind(payload) : 'text';
  if (kind === 'text' && !text) throw new Error('消息内容不能为空');

  const message: Message = {
    id: nextId('msg'),
    conversationId: payload.conversationId,
    senderId: mockDb.meId,
    kind,
    text: text || null,
    attachment: payload.attachment ?? null,
    note: payload.note ?? null,
    createdAt: new Date().toISOString(),
    status: 'sent',
  };

  mockDb.messages.push(message);
  mockDb.touchConversation(payload.conversationId, message);

  // mock 专属：模拟对方读回执 + 自动回复。真实实现里这两件事都来自服务端推送
  scheduleAutoReply(payload.conversationId);

  return { ...message };
}

function deriveKind(payload: SendMessagePayload): 'image' | 'file' {
  return payload.attachment?.mimeType.startsWith('image/') ? 'image' : 'file';
}

/**
 * POST /chat/notes/share { noteId, toFriendIds[], comment? }
 *
 * 分享笔记 / 目录给好友。后端要为每个好友找到（或新建）单聊，
 * 再写入一条 kind=note 的消息。返回实际送达数用于提示，
 * 部分失败时也照常返回成功的那部分（前端提示"N 位好友已收到"）。
 */
export async function shareNote(payload: ShareNotePayload): Promise<ShareNoteResult> {
  await delay(340);

  if (payload.toFriendIds.length === 0) throw new Error('请至少选择一位好友');

  let messageCount = 0;
  const conversationIds: string[] = [];

  for (const friendId of payload.toFriendIds) {
    const conversation = await createDirectConversation(friendId);

    const message: Message = {
      id: nextId('msg'),
      conversationId: conversation.id,
      senderId: mockDb.meId,
      kind: 'note',
      text: payload.comment?.trim() || null,
      attachment: null,
      note: {
        noteId: payload.noteId,
        title: payload.title,
        kind: payload.kind,
        childCount: payload.childCount,
      },
      createdAt: new Date().toISOString(),
      status: 'sent',
    };

    mockDb.messages.push(message);
    mockDb.touchConversation(conversation.id, message);
    conversationIds.push(conversation.id);
    messageCount += 1;
  }

  return { conversationCount: conversationIds.length, messageCount };
}

/* ------------------------------ 实时事件 ------------------------------ */

/**
 * 订阅服务端推送。
 *
 * mock 阶段由 `chat.mock.ts` 用定时器伪造；后端就绪后换成
 * WebSocket（推荐，双向且便于后续加输入状态）或 SSE。
 *
 * **store 侧不需要任何改动** —— 把实时能力收敛成这一个钩子，
 * 就是为了让协议替换不波及业务代码。
 *
 * 返回取消订阅函数，组件卸载时必须调用，否则会重复订阅。
 */
export function subscribeChatEvents(handler: (event: ChatEvent) => void): () => void {
  return subscribe(handler);
}
