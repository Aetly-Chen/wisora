/**
 * 聊天接口层。
 *
 * 这里是聊天模块**唯一**的数据出入口：组件与 store 都不直接碰 axios / socket，
 * 换传输方式（比如把实时通道从 socket.io 换成 SSE）时只改本文件。
 *
 * 两条通道分工：
 * - 会话、消息、好友、文件 → REST（走 request 实例，自带令牌注入与 401 刷新重放）
 * - 实时事件 → WebSocket（socket.io，服务端 `chat` 命名空间）
 *
 * 为什么文件收发走 REST 而事件走 WS：上传需要有真实进度与 multipart，
 * 走 WS 反而要自己切分片；而输入状态、已读回执这类是双向高频小包，REST 不合适。
 */

import io, { type Socket } from 'socket.io-client';
import request from './index';
import { getToken } from './storage';
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
import { CHAT_FILE_MAX_BYTES } from '@/lib/chat-utils';

const BASE = import.meta.env.VITE_BASE_API ?? '';

/**
 * 注入当前登录用户。
 *
 * 真实实现下是空操作：身份一律由后端从令牌解析，
 * **不接受前端传入**（否则任何人都能冒充他人发消息）。
 * 保留这个函数是为了让 store 的初始化流程不必区分两种实现。
 */
export function setCurrentUser(_userId: string): void {
  // no-op
}

/* ------------------------------ 好友 ------------------------------ */

/** GET /chat/friends */
export function listFriends(): Promise<Friend[]> {
  return request.get<Friend[]>('/chat/friends', { loading: false });
}

/**
 * GET /chat/users?keyword=xxx
 *
 * 服务端按 @handle / 昵称 / 邮箱搜，限制 20 条；
 * 非好友的邮箱会被脱敏（形如 y***@example.com）。
 * 空关键词服务端直接返回空数组，不会把用户目录抖出来。
 */
export function searchUsers(keyword: string): Promise<Friend[]> {
  return request.get<Friend[]>('/chat/users', {
    params: { keyword },
    loading: false,
  });
}

/**
 * POST /chat/friends { userId }
 *
 * 服务端幂等：已加过返回既有关系，不报 409。
 * 关系是双向的（A 加 B 会写两条），所以对方列表里也会立刻出现我。
 */
export function addFriend(friendId: string): Promise<Friend> {
  return request.post<Friend>('/chat/friends', { userId: friendId }, { loading: false });
}

/* ------------------------------ 会话 ------------------------------ */

/** GET /chat/conversations —— 已按「置顶优先 + 最后消息时间」排好序 */
export function listConversations(): Promise<Conversation[]> {
  return request.get<Conversation[]>('/chat/conversations', { loading: false });
}

/**
 * GET /chat/conversations/:id/messages
 *
 * 服务端按时间正序返回，默认 30 条（上限 100）。
 * 分页用游标（`before=<messageId>`）而不是 offset —— 实时聊天里
 * 消息在不断插入，offset 会让人翻页时看到重复或漏掉。
 * 前端暂时只加载最近一页，接「加载更早」时把 before 传进来即可。
 */
export function listMessages(
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<Message[]> {
  return request.get<Message[]>(`/chat/conversations/${conversationId}/messages`, {
    params: { before: opts.before, limit: opts.limit },
    loading: false,
  });
}

/**
 * POST /chat/conversations { kind: 'direct', friendId }
 *
 * 服务端会复用已有的单聊 —— 不然用户多点几次「发消息」，
 * 就会和同一个人建出多条会话，列表里出现一堆重复。
 */
export function createDirectConversation(friendId: string): Promise<Conversation> {
  return request.post<Conversation>(
    '/chat/conversations',
    { kind: 'direct', friendId },
    { loading: false },
  );
}

/** POST /chat/conversations { kind: 'group', title, memberIds } */
export function createGroupConversation(
  payload: CreateGroupPayload,
): Promise<Conversation> {
  return request.post<Conversation>(
    '/chat/conversations',
    { kind: 'group', title: payload.title, memberIds: payload.memberIds },
    { loading: false },
  );
}

/**
 * PATCH /chat/conversations/:id { pinned?, muted? }
 *
 * 置顶与免打扰合成一个接口：它们都只是会话级开关，
 * 没必要为每个开关开一条路由。
 * 服务端只改「我自己的成员记录」，不会影响同群的其他人。
 */
export function updateConversationFlags(
  conversationId: string,
  flags: { pinned?: boolean; muted?: boolean },
): Promise<Conversation> {
  return request.patch<Conversation>(
    `/chat/conversations/${conversationId}`,
    flags,
    { loading: false },
  );
}

/** POST /chat/conversations/:id/read —— 未读清零并把对方的消息标为已读 */
export function markConversationRead(conversationId: string): Promise<void> {
  return request.post<void>(
    `/chat/conversations/${conversationId}/read`,
    undefined,
    { loading: false },
  );
}

/* ------------------------------ 消息与附件 ------------------------------ */

/**
 * POST /chat/attachments（multipart/form-data，字段名 file）
 *
 * 先传文件拿到附件 id，再带 attachmentId 发消息 —— 拆两步是为了有真实的上传进度，
 * 也为了让「发文件」和「发文本」共用同一个发消息接口。
 *
 * 前端只做「明显不合法」的预检（体积、空文件），**真正的白名单在后端** ——
 * 按扩展名判断拦不住任何攻击者。
 */
export function uploadAttachment(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<ChatAttachment> {
  if (file.size > CHAT_FILE_MAX_BYTES) {
    return Promise.reject(
      new Error(`单个文件不能超过 ${Math.round(CHAT_FILE_MAX_BYTES / 1024 / 1024)} MB`),
    );
  }
  if (file.size === 0) {
    return Promise.reject(new Error('文件为空，无法发送'));
  }

  const form = new FormData();
  form.append('file', file);

  return request
    .post<ChatAttachment>('/chat/attachments', form, {
      loading: false,
      /*
       * 不要手写 Content-Type —— 让浏览器自己带 multipart 边界，
       * 手写会漏掉 boundary，后端解析直接失败。
       */
      onUploadProgress: (e) => {
        if (!onProgress) return;
        const total = e.total ?? file.size;
        if (!total) return;
        onProgress(Math.min(100, Math.round((e.loaded / total) * 100)));
      },
    })
    .then((attachment) => {
      /*
       * 本地图片立刻给一个 objectUrl 用于预览。
       *
       * 服务端只回 previewUrl（是需要鉴权的接口地址，<img> 带不上令牌），
       * 而这张图就是用户刚从本地选的，没必要再取一次。
       */
      if (attachment.mimeType.startsWith('image/')) {
        return { ...attachment, objectUrl: URL.createObjectURL(file) };
      }
      return attachment;
    });
}

/**
 * POST /chat/conversations/:id/messages
 *
 * body: { text?, attachmentId?, noteId? } 三者至少有一个。
 *
 * 注意这里要做**字段拍平**：store 传的是完整的 attachment / note 对象，
 * 而后端只接受 id。笔记的标题等快照由服务端自己按 noteId 查 ——
 * 让客户端传标题意味着可以伪造标题把别人的笔记发出去。
 */
export async function sendMessage(payload: SendMessagePayload): Promise<Message> {
  const body: { text?: string; attachmentId?: string; noteId?: string } = {};
  if (payload.text) body.text = payload.text;
  if (payload.attachment) body.attachmentId = payload.attachment.id;
  if (payload.note) body.noteId = payload.note.noteId;

  const saved = await request.post<Message>(
    `/chat/conversations/${payload.conversationId}/messages`,
    body,
    { loading: false },
  );

  /*
   * 把本地 objectUrl 带回去。
   *
   * 服务端返回的附件只有 previewUrl（鉴权地址），而 store 会用这条返回值
   * 替换掉乐观插入的气泡 —— 不补这一下，自己刚发的图会先黑一下再去取 Blob。
   */
  const localUrl = payload.attachment?.objectUrl;
  if (localUrl && saved.attachment) {
    return { ...saved, attachment: { ...saved.attachment, objectUrl: localUrl } };
  }
  return saved;
}

/**
 * POST /chat/notes/share { noteId, toFriendIds[], comment? }
 *
 * 服务端为每个好友复用或新建单聊，各写一条 kind=note 的消息。
 * 部分失败时照常返回成功的那部分（前端提示「N 位好友已收到」）。
 */
export function shareNote(payload: ShareNotePayload): Promise<ShareNoteResult> {
  return request.post<ShareNoteResult>(
    '/chat/notes/share',
    {
      noteId: payload.noteId,
      toFriendIds: payload.toFriendIds,
      comment: payload.comment,
    },
    { loading: false },
  );
}

/* ------------------------------ 带鉴权的文件读取 ------------------------------ */

/**
 * 取附件二进制。
 *
 * 不能把 `/chat/attachments/:id/content` 直接塞给 <img src> 或 <a href> ——
 * 该接口需要 Authorization 头，而 img / iframe / 导航跳转都带不上自定义头，
 * 结果就是 401。所以统一「先 fetch 成 Blob，再转 objectURL」。
 *
 * 与笔记模块的 fetchAttachmentBlob 是同一套做法（那边是 /attachments/:id/content）。
 */
export async function fetchChatAttachmentBlob(id: string): Promise<Blob> {
  const res = await fetch(`${BASE}/chat/attachments/${id}/content`, {
    headers: { Authorization: `Bearer ${getToken() ?? ''}` },
  });
  if (!res.ok) {
    throw new Error(`加载附件失败（HTTP ${res.status}）`);
  }
  return res.blob();
}

/** 触发浏览器下载。同上，必须带着令牌自己取流 */
export async function downloadChatAttachment(id: string, filename: string) {
  const blob = await fetchChatAttachmentBlob(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ------------------------------ 实时事件 ------------------------------ */

/**
 * 订阅服务端推送。
 *
 * 用 socket.io 连服务端的 `chat` 命名空间。
 *
 * 令牌通过握手载荷（auth）传递，**不放 query string** ——
 * query 会进访问日志与代理记录。这一点与 ai 模块当初为 SSE
 * 引入一次性 ticket 是同一个理由。
 *
 * `auth` 传函数形式：socket.io 每次重连都会重新调用它，
 * 这样访问令牌过期刷新后，重连拿到的是新令牌而不是握手时的旧值。
 *
 * 事件名固定 `event`，载荷是带 type 字段的 ChatEvent ——
 * 与服务端 chat.gateway.ts 的 EVENT_CHANNEL 对应。
 *
 * 返回取消订阅函数，组件卸载时必须调用。
 */
export function subscribeChatEvents(handler: (event: ChatEvent) => void): () => void {
  const socket: Socket = io(`${BASE}/chat`, {
    // 只用 websocket：省掉 polling 升级那一步，实时性更直接
    transports: ['websocket'],
    auth: (cb) => cb({ token: getToken() ?? '' }),
  });

  socket.on('event', (event: ChatEvent) => handler(event));

  // 断线不静默：至少让开发者能在控制台看到，否则「消息不来了」无从下手
  socket.on('connect_error', (err) => {
    console.warn('[chat] 实时连接失败：', err.message);
  });

  return () => {
    socket.off('event');
    socket.disconnect();
  };
}
