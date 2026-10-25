import type {
  AttachmentDto,
  ConversationDto,
  FriendDto,
  MessageDto,
  Presence,
} from './types/chat-events';

/*
 * 这个文件是「数据库行 → 接口出参」的唯一转换点。
 *
 * 为什么不散在各个 service 里：Message 这个形状在 4 个地方都要拼
 * （会话列表的最后一条、历史消息、发送返回、分享写入）。
 * 散着写的话前端字段一变就得改 4 处 —— 笔记模块当初
 * 「create 接口漏返回 attachments」就是这么来的。
 */

/* ------------------------------ Prisma select ------------------------------ */

export const USER_SHAPE = {
  id: true,
  email: true,
  nickname: true,
  handle: true,
  bio: true,
} as const;

export const ATTACHMENT_SHAPE = {
  id: true,
  filename: true,
  mimeType: true,
  size: true,
} as const;

export const MESSAGE_SHAPE = {
  id: true,
  conversationId: true,
  senderId: true,
  kind: true,
  text: true,
  noteId: true,
  noteTitle: true,
  noteKind: true,
  noteChildCount: true,
  status: true,
  createdAt: true,
  attachment: { select: ATTACHMENT_SHAPE },
} as const;

export const CONVERSATION_SHAPE = {
  id: true,
  kind: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  /*
   * 成员 id：与列表一起返回，否则前端渲染每行都要再发一次请求。
   *
   * 必须显式按 joinedAt 排序：前端要拿这个数组的**下标**给群成员分配颜色
   * （这样同一个群里成员不撞色）。SQL 不保证无 ORDER BY 的顺序，
   * 顺序一飘，颜色就跟着飘。
   */
  members: {
    where: { leftAt: null },
    orderBy: { joinedAt: 'asc' },
    select: { userId: true },
  },
  // 最后一条消息：列表用它渲染摘要
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: MESSAGE_SHAPE,
  },
} as const;

/* ------------------------------ 行类型 ------------------------------ */
/*
 * 手写结构类型而不是从 Prisma 推导（Prisma.ChatMessageGetPayload<...>）：
 * 后者会把 select 的 readonly 修饰一起带进来，与这里的参数类型互相打架。
 * 结构上够用即可，字段对不上编译期就能发现。
 */

interface AttachmentRow {
  id: string; // 附件主键
  filename: string; // DB 列名；DTO 里叫 name（映射时改名）
  mimeType: string; // MIME 类型，决定气泡渲染方式
  size: number; // 字节数
}

interface MessageRow {
  id: string; // 消息主键
  conversationId: string; // 所属会话
  senderId: string; // 发送者用户 id
  kind: string; // DB 枚举 ChatMessageKind，值是大写 TEXT/IMAGE/FILE/NOTE
  text: string | null; // 文本内容；非 text 类型为 null
  noteId: string | null; // —— 以下四个是「分享笔记」时的快照 ——
  noteTitle: string | null; // 分享当时的标题
  noteKind: string | null; // note（单篇）/ folder（目录）
  noteChildCount: number; // 目录分享时的子页面数（单篇为 0）
  status: string; // 消息状态（sent/read 等），DB 里是字符串
  createdAt: Date; // 落库时间；映射成 DTO 时转 ISO 字符串
  attachment: AttachmentRow | null; // 附件消息的附件行；其它类型为 null
}

interface ConversationRow {
  id: string; // 会话主键
  kind: string; // direct / group
  title: string | null; // 群名；单聊为 null（标题由对方名字推导）
  createdAt: Date; // 创建时间
  updatedAt: Date; // 最后活跃时间，列表排序依据
  members: Array<{ userId: string }>; // 参与者 id（这里只需要 userId）
  messages: MessageRow[]; // 只取最近一条，用于列表摘要
}

/** 当前用户在该会话里的成员级状态（来自 ChatConversationMember） */
interface MemberFlags {
  pinned: boolean; // 是否置顶（每人各自独立）
  muted: boolean; // 是否免打扰
  unread: number; // 未读数
}

interface UserRow {
  id: string; // 用户主键
  email: string; // 邮箱（搜索结果里用来确认身份）
  nickname: string | null; // 昵称，可能为空
  handle: string | null; // @handle，加好友按它精确查找
  bio: string | null; // 个性签名 / 职位
}

/* ------------------------------ 映射 ------------------------------ */

export function toAttachment(row: AttachmentRow): AttachmentDto {
  const dto: AttachmentDto = {
    id: row.id,
    name: row.filename,
    size: row.size,
    mimeType: row.mimeType,
  };
  // 只有图片给预览地址；其它类型前端渲染成文件卡片，不需要取流
  if (row.mimeType.startsWith('image/')) {
    dto.previewUrl = `/chat/attachments/${row.id}/content`;
  }
  return dto;
}

export function toMessage(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    kind: row.kind.toLowerCase() as MessageDto['kind'],
    text: row.text,
    attachment: row.attachment ? toAttachment(row.attachment) : null,
    note: row.noteId
      ? {
          noteId: row.noteId,
          title: row.noteTitle ?? '笔记',
          kind: (row.noteKind as 'note' | 'folder' | null) ?? 'note',
          childCount: row.noteChildCount,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    status: row.status.toLowerCase() as MessageDto['status'],
  };
}

export function toConversation(
  row: ConversationRow,
  member: MemberFlags,
): ConversationDto {
  return {
    id: row.id,
    kind: row.kind.toLowerCase() as ConversationDto['kind'],
    title: row.title,
    memberIds: row.members.map((m) => m.userId),
    lastMessage: row.messages[0] ? toMessage(row.messages[0]) : null,
    unread: member.unread,
    pinned: member.pinned,
    muted: member.muted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * handle：老用户为空，回退到邮箱前缀。
 *
 * 这是权宜之计 —— 邮箱前缀可能重复（a@x.com 与 a@y.com），
 * 搜索时按它匹配会给出多个候选。等 handle 补全后应把回退去掉。
 */
export function handleOf(user: {
  id: string;
  handle: string | null;
  email: string;
}): string {
  return user.handle?.trim() || user.email.split('@')[0] || user.id.slice(0, 8);
}

export function displayNameOf(user: {
  nickname: string | null;
  email: string;
}): string {
  return user.nickname?.trim() || user.email.split('@')[0];
}

/**
 * 非好友时脱敏邮箱。
 *
 * 搜索接口会把陌生人也返回出来，直接给完整邮箱等于把用户邮箱
 * 变成了可枚举的资源（按 handle 逐个试探即可批量收集）。
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}

export function toFriend(
  user: UserRow,
  opts: { isFriend: boolean; presence: Presence; alias?: string | null },
): FriendDto {
  return {
    id: user.id,
    // 备注名优先于昵称
    name: opts.alias?.trim() || displayNameOf(user),
    handle: handleOf(user),
    email: opts.isFriend ? user.email : maskEmail(user.email),
    // 空字符串而不是 null：前端直接渲染，不做空值判断
    bio: user.bio ?? '',
    presence: opts.presence,
    isFriend: opts.isFriend,
  };
}
