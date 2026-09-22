/**
 * 后端出参形状与实时事件。
 *
 * 与前端 `frontend/src/types/chat.ts` 一一对应 —— 字段名或空值语义一旦改动，
 * 两处必须同时改。前端刻意用 `| null` 而不是可选字段，后端这边也保持一致：
 * 可空关系一律给 null，不给 undefined。
 *
 * 原因：JSON.stringify 会把值为 undefined 的键整个丢掉，前端读到的就是
 * 「字段不存在」，与「字段为 null」在类型上不等价 —— 前端按 `foo === null`
 * 判断的地方会全部走错分支。
 */

export type Presence = 'online' | 'away' | 'offline';
export type ConversationKindDto = 'direct' | 'group';
export type MessageKindDto = 'text' | 'image' | 'file' | 'note';
export type MessageStatusDto = 'sent' | 'read';

export interface AttachmentDto {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /**
   * 图片给出可预览地址。
   *
   * 注意这个地址**需要 Authorization 头**，前端不能直接塞给 <img src>，
   * 要先 fetch 成 Blob 再转 objectURL（笔记模块的 fetchAttachmentBlob 是同一套做法）。
   */
  previewUrl?: string;
}

export interface SharedNoteDto {
  noteId: string;
  title: string;
  /** 分享的是单篇笔记还是一个目录 */
  kind: 'note' | 'folder';
  childCount: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKindDto;
  text: string | null;
  attachment: AttachmentDto | null;
  note: SharedNoteDto | null;
  createdAt: string;
  /** 后端只会返回 sent / read；sending / failed 是前端本地状态 */
  status: MessageStatusDto;
}

export interface ConversationDto {
  id: string;
  kind: ConversationKindDto;
  title: string | null;
  /** 必须包含当前用户 */
  memberIds: string[];
  lastMessage: MessageDto | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FriendDto {
  id: string;
  name: string;
  handle: string;
  /** 非好友时已脱敏，形如 y***@example.com */
  email: string;
  /** 无签名时是空字符串，不是 null —— 前端直接渲染 */
  bio: string;
  presence: Presence;
  isFriend: boolean;
}

export interface ShareNoteResultDto {
  conversationCount: number;
  messageCount: number;
}

/* ------------------------------ 实时事件 ------------------------------ */

/** 服务端 → 客户端 */
export type ChatServerEvent =
  | { type: 'message'; message: MessageDto }
  | { type: 'typing'; conversationId: string; userId: string; typing: boolean }
  | { type: 'read'; conversationId: string; userId: string }
  | { type: 'presence'; userId: string; presence: Presence };

/** 客户端 → 服务端 */
export type ChatClientEvent =
  | { type: 'typing'; conversationId: string; typing: boolean }
  | { type: 'read'; conversationId: string };
