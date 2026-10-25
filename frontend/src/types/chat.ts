/**
 * 聊天模块的类型定义。
 *
 * 与后端的数据形状一一对应，字段命名沿用项目既有习惯：
 * 时间一律用 ISO 字符串（后端 Prisma 的 Date 经 JSON 序列化后就是字符串），
 * 可空关系用 `| null` 而不是可选字段，避免「有字段但值是 undefined」
 * 这种前后端都容易踩的形状歧义。
 */

/* ------------------------------------------------------------------ */
/* 好友                                                                */
/* ------------------------------------------------------------------ */

/** 在线状态。离线不显示任何标记，在线才显示小圆点 */
export type Presence = 'online' | 'away' | 'offline';

export interface Friend {
  id: string; // 用户主键；加好友、建会话都用它
  /** 显示名 */
  name: string;
  /**
   * 唯一账号标识，展示为 @handle。
   * 加好友时按它精确查找，避免同名歧义。
   */
  handle: string;
  email: string; // 邮箱；搜索结果里展示，方便确认是不是同一个人
  /** 个性签名 / 职位，展示在好友资料与搜索结果里 */
  bio: string;
  presence: Presence; // 对方当前在线状态，由 socket 实时推送更新
  /** 是否已被当前用户加为好友；搜索结果为 false 时显示「添加」 */
  isFriend: boolean;
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

/**
 * 会话类型。
 *
 * direct 单聊固定 2 名成员；group 群聊 3 人及以上。
 * 用联合类型而不是 enum —— 项目的 erasableSyntaxOnly 禁用了 enum。
 */
export type ConversationKind = 'direct' | 'group';

export interface Conversation {
  id: string; // 会话主键；消息、已读回执都以它为维度
  kind: ConversationKind; // 单聊 / 群聊，决定标题与头像的推导方式
  /** 群聊的群名。单聊为空，标题由对方名字推导 */
  title: string | null;
  /** 参与者 id（包含自己）。单聊为 2 个，群聊为 3 个及以上 */
  memberIds: string[];
  /** 最后一条消息，列表用它渲染摘要 */
  lastMessage: Message | null;
  unread: number; // 未读数；免打扰时不显示红点但仍累计
  /** 置顶，列表排序时优先 */
  pinned: boolean;
  /** 免打扰：仍然累计未读，但不显示计数红点 */
  muted: boolean;
  /** 群聊头像用的取色种子，避免每次渲染颜色抖动 */
  createdAt: string; // 会话创建时间，ISO 字符串
  updatedAt: string; // 最后活跃时间；列表按它倒序，新消息到达时由后端刷新
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

/**
 * 消息种类。
 *
 * - text  纯文本
 * - image 图片（附件带了预览地址，气泡内直接显示缩略图）
 * - file  普通文件（气泡内是文件卡片）
 * - note  分享的笔记 / 目录（气泡内是笔记卡片，点击可跳回笔记页）
 */
export type MessageKind = 'text' | 'image' | 'file' | 'note';

/**
 * 发送状态。
 *
 * sending 显示转圈，failed 显示重试入口。
 * read 只用于「自己发出的最后一条」，对方的读取回执。
 */
export type MessageStatus = 'sending' | 'sent' | 'read' | 'failed';

/** 附件元数据。与笔记模块的 AttachmentMeta 保持一致的字段命名 */
export interface ChatAttachment {
  id: string; // 附件主键；消息气泡按它拉取签名直链
  /** 原始文件名 */
  name: string;
  /** 字节数 */
  size: number;
  mimeType: string; // MIME 类型，决定用图片预览还是文件卡片
  /** 图片消息的预览地址 */
  previewUrl?: string;
  /** 本地已取到的对象地址（前端预览用） */
  objectUrl?: string;
}

/**
 * 分享笔记时附在消息上的卡片数据。
 *
 * 只存快照（标题 + 类型 + 子页面数），不存笔记正文 ——
 * 聊天记录里塞整篇 Markdown 会让消息表迅速膨胀，
 * 点开卡片时再按 noteId 去笔记模块拉取。
 */
export interface SharedNotePayload {
  noteId: string; // 被分享的笔记 id；点卡片时据此跳回笔记页
  title: string; // 分享当时的标题快照（对方后续改名不影响历史消息）
  /** 分享的是单篇笔记还是一个目录 */
  kind: 'note' | 'folder';
  /** 目录分享时带上子页面数量，卡片上显示「含 N 个子页面」 */
  childCount: number;
}

export interface Message {
  id: string; // 消息主键；本地乐观插入时先给临时 id，收到回执后替换
  conversationId: string; // 所属会话
  /** 发送者 id。等于当前用户 id 时渲染成右侧气泡 */
  senderId: string;
  kind: MessageKind; // 文本 / 图片 / 文件 / 笔记卡片
  text: string | null; // 文本内容；非 text 类型时为 null
  attachment: ChatAttachment | null; // 附件消息的附件元数据
  note: SharedNotePayload | null; // 笔记分享消息的卡片数据
  /** 上传进度 0-100，仅发送中的附件消息有值 */
  uploadProgress?: number;
  createdAt: string; // 发送时间，ISO 字符串；气泡按它分组显示时间
  status: MessageStatus; // 本地发送状态，仅在客户端维护
}

/* ------------------------------------------------------------------ */
/* 实时事件（订阅钩子用）                                                */
/* ------------------------------------------------------------------ */

/**
 * 服务端推送事件。
 *
 * 与 chat.gateway.ts 的 EVENT_CHANNEL 载荷一一对应。
 * 抽成联合类型而不是让 store 直接读 socket 回调，是为了让传输方式
 * 可替换（socket.io / SSE 都行）而 store 侧一行都不用改。
 */
export type ChatEvent =
  | { type: 'message'; message: Message } // 新消息（自己也走这条，保证多端一致）
  | { type: 'typing'; conversationId: string; userId: string; typing: boolean } // 对方正在输入
  | { type: 'read'; conversationId: string; userId: string } // 对方已读，用于更新自己消息的回执
  | { type: 'presence'; userId: string; presence: Presence }; // 好友上下线

/* ------------------------------------------------------------------ */
/* 请求载荷                                                            */
/* ------------------------------------------------------------------ */

/** 发送消息的请求体；text / attachment / note 三者按 kind 取其一 */
export interface SendMessagePayload {
  conversationId: string; // 发到哪个会话
  text?: string; // 文本内容（text 消息必填）
  attachment?: ChatAttachment; // 已上传的附件（image / file 消息用）
  note?: SharedNotePayload; // 分享的笔记卡片（note 消息用）
}

export interface ShareNotePayload {
  noteId: string; // 要分享的笔记
  title: string; // 分享时展示的标题
  kind: 'note' | 'folder'; // 单篇还是整个目录
  childCount: number; // 目录分享时的子页面数（单篇为 0）
  /** 要分享给哪些好友；每人生成（或复用）一个单聊会话 */
  toFriendIds: string[];
  /** 附加的一句说明 */
  comment?: string;
}

export interface ShareNoteResult {
  /** 实际送达的会话数 */
  conversationCount: number;
  /** 实际生成的消息数 */
  messageCount: number;
}

/** 创建群聊的请求体 */
export interface CreateGroupPayload {
  title: string; // 群名；不允许为空
  memberIds: string[]; // 成员 id 列表（含自己），至少 2 人才能成群
}
