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
  id: string; // 附件主键，取流地址里也用它
  name: string; // 上传时的原始文件名，前端直接展示
  size: number; // 字节数，前端据此格式化 KB / MB
  mimeType: string; // MIME 类型；image/* 才给 previewUrl
  /**
   * 图片给出可预览地址。
   *
   * 注意这个地址**需要 Authorization 头**，前端不能直接塞给 <img src>，
   * 要先 fetch 成 Blob 再转 objectURL（笔记模块的 fetchAttachmentBlob 是同一套做法）。
   */
  previewUrl?: string;
}

export interface SharedNoteDto {
  noteId: string; // 被分享笔记（或目录）的 id
  title: string; // 分享那一刻的快照，之后笔记改名不影响卡片
  /** 分享的是单篇笔记还是一个目录 */
  kind: 'note' | 'folder';
  childCount: number; // 目录下的子笔记数；单篇笔记恒为 0
}

export interface MessageDto {
  id: string; // 消息主键
  conversationId: string; // 所属会话，前端据此归行
  senderId: string; // 发送者用户 id
  kind: MessageKindDto; // 消息类型，决定渲染成气泡 / 图片 / 文件 / 笔记卡片
  text: string | null; // 文本正文；非文本消息为 null，不做空串兜底
  attachment: AttachmentDto | null; // 附件消息的附件，其它类型为 null
  note: SharedNoteDto | null; // 笔记消息分享的内容，其它类型为 null
  createdAt: string; // 发送时间，出参是 ISO 字符串而非 Date
  /** 后端只会返回 sent / read；sending / failed 是前端本地状态 */
  status: MessageStatusDto;
}

export interface ConversationDto {
  id: string; // 会话主键
  kind: ConversationKindDto; // 单聊还是群聊，决定标题与头像的渲染方式
  title: string | null; // 群名；单聊为 null，由前端用对方昵称代替
  /** 必须包含当前用户 */
  memberIds: string[];
  lastMessage: MessageDto | null; // 列表摘要用的最后一条；空会话为 null
  unread: number; // 当前用户的未读数，按成员维度各自计算
  pinned: boolean; // 当前用户是否置顶
  muted: boolean; // 当前用户是否免打扰
  createdAt: string; // 创建时间，ISO 字符串
  updatedAt: string; // 最后活跃时间，ISO 字符串；列表按它倒序
}

export interface FriendDto {
  id: string; // 用户主键
  name: string; // 展示名：备注名优先，其次昵称，最后邮箱前缀
  handle: string; // 账号标识，展示为 @handle；老用户为空时退化成邮箱前缀
  /** 非好友时已脱敏，形如 y***@example.com */
  email: string;
  /** 无签名时是空字符串，不是 null —— 前端直接渲染 */
  bio: string;
  presence: Presence; // 在线状态，来自 Redis 在线标记
  isFriend: boolean; // false 时 email 已脱敏，前端显示「加好友」
}

export interface ShareNoteResultDto {
  conversationCount: number; // 实际送达的不同会话数（同一好友只算一次）
  messageCount: number; // 成功写入的消息条数；单人失败只跳过不中断
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
