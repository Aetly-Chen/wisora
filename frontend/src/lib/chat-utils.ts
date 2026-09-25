/**
 * 聊天模块的纯函数工具。
 *
 * 单独成文件而不是散在组件里：时间分组、字节格式化、头像取色
 * 这几件事在列表、气泡、文件卡、分享弹窗里都要用，
 * 各写一份必然出现「同一个时间在列表显示昨天、在气泡显示 09-17」。
 */

import type { ChatAttachment, Conversation } from '@/types/chat';

/* ------------------------------ 时间 ------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0');

/** HH:mm，气泡内与列表同用时区的时钟 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 两个时间是否落在同一自然日 */
export function isSameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** 列表里的时间：今天给时刻，昨天给「昨天」，一周内给星期，更早给日期 */
export function formatListTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(iso, now.toISOString())) return formatClock(iso);

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(iso, yesterday.toISOString())) return '昨天';

  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) {
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 消息流里的日期分隔标签。
 *
 * 昨天与更早都写全日期，不写「周三」—— 聊天记录经常被翻到几周前，
 * 「周三」在那时是歧义信息，不如直接给日期。
 */
export function formatDayDivider(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (isSameDay(iso, now.toISOString())) return '今天';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(iso, yesterday.toISOString())) return '昨天';

  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
}

/* ------------------------------ 体积 ------------------------------ */

/** 文件体积。附件大小是给用户看的，统一走这个函数避免各处精度不一 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------ 头像 ------------------------------ */

/**
 * 取名字的首字作为头像文字。
 *
 * 中文取最后两字（如「周慕云」→「慕云」）比取首字更易区分；
 * 英文取首字母。都不空时兜底成问号，避免渲染出空圆。
 */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';

  if (/[\u4e00-\u9fa5]/.test(trimmed)) {
    // 中文名：优先取后两字（去掉姓氏），单字名就取该字
    const withoutSurname = trimmed.length > 2 ? trimmed.slice(1) : trimmed;
    return withoutSurname.slice(0, 2);
  }

  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * 头像底色：由 id 稳定推导，同一人每次渲染都是同一色。
 *
 * 用一组**受控的低饱和色**而不是随机 HSL ——
 * 随机色相会跑出荧光绿、亮橙这类颜色，整页立刻显脏。
 * 这里是功能性用色（帮人快速区分不同联系人），
 * 不是在给页面加第二个强调色，所以限定在 5 个都压过饱和度的色相里。
 */
const AVATAR_TONES = [
  'from-indigo-500 to-indigo-600',
  'from-teal-500 to-teal-600',
  'from-amber-500 to-amber-600',
  'from-rose-500 to-rose-600',
  'from-sky-500 to-sky-600',
] as const;

export function avatarTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) % 100_000;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/* --------------------------- Telegram 成员配色 --------------------------- */

/**
 * Telegram 的成员配色板。
 *
 * 官方按用户 id 稳定分配这 7 个色相，**头像底色与群聊里的昵称同色**。
 * 同一个人在两处必须是同一个颜色，否则这套配色就失去了
 * 「不用看名字也能分辨谁是谁」的作用。
 *
 * 与上面的 AVATAR_TONES 并存而不是替换：那套是渐变的、压过饱和度的，
 * 给全局导航栏与个人资料页用；这套是 Telegram 的纯色块，
 * 只给聊天模块用。两者的取色函数分开，互不影响。
 */
const PEER_AVATAR_CLASS = [
  'bg-[#e17076]',
  'bg-[#faa774]',
  'bg-[#a695e7]',
  'bg-[#7bc862]',
  'bg-[#6ec9cb]',
  'bg-[#65aadd]',
  'bg-[#ee7aae]',
] as const;

/**
 * 昵称文字用的加深版。
 *
 * 头像上是白字压纯色，可以直接用原色；但同一套原色当正文放到白底上，
 * #7bc862 只有 2.2:1，读不清。所以昵称取同色相的加深版：
 * 保住「谁是什么颜色」的可辨识度，同时把对比度全部拉到 4.5:1 以上。
 */
const PEER_NAME_CLASS = [
  'text-[#b3363f]',
  'text-[#a25b1c]',
  'text-[#6b52c9]',
  'text-[#457a2d]',
  'text-[#26777a]',
  'text-[#2b6ea8]',
  'text-[#b53b70]',
] as const;

/** 与 avatarTone 同一套哈希：换个函数取同一个下标，两处颜色才对得上 */
function peerIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) % 100_000;
  }
  return hash % PEER_AVATAR_CLASS.length;
}

/** 头像底色（纯色块，白字）。群聊头像也走这里，用会话 id 取色 */
export function peerAvatarClass(id: string): string {
  return PEER_AVATAR_CLASS[peerIndex(id)];
}

/** 群聊里昵称的颜色 */
export function peerNameClass(id: string): string {
  return PEER_NAME_CLASS[peerIndex(id)];
}

/**
 * 会话内取色用的下标。
 *
 * **群聊按「在 memberIds 里的下标」分配**：同一个群里成员不撞色 ——
 * 而这套配色存在的唯一意义就是「不读名字也能分辨谁是谁」。
 * 用 id 哈希的话，往 7 个槽里哈希等价于生日问题：
 * 4 人小群「四人不撞」的概率只有 7·6·5·4 / 7⁴ ≈ 35%，
 * 也就是约 65% 的四人群会出现两人同色。成员超过 7 人时仍会绕回，
 * 但那是这套 7 色板的天然上限。
 *
 * **单聊不走下标**：DM 里只有一个对方，不存在撞色问题，
 * 而按下标会让所有 DM 的对方都拿到同一个颜色。
 * 所以单聊继续用 id 哈希，保证每个人在任何 DM 视图里颜色恒定。
 *
 * 依赖 `memberIds` 的顺序稳定 —— 后端已按 joinedAt 排序返回
 * （见 `CONVERSATION_SHAPE`），否则每次请求颜色都会变。
 */
function peerIndexIn(
  conversation: Pick<Conversation, 'kind' | 'memberIds'>,
  userId: string,
): number {
  if (conversation.kind === 'group') {
    const i = conversation.memberIds.indexOf(userId);
    if (i >= 0) return i % PEER_AVATAR_CLASS.length;
  }
  return peerIndex(userId);
}

/**
 * 会话内的成员头像底色。
 *
 * 与 `peerAvatarClass` 的区别：这个在**群聊**里按会话内序号取色（不撞色），
 * 单聊退回 id 哈希。消息流里的对方头像用这个 ——
 * 只有「多个人同时出现在一屏」时撞色才是个问题。
 *
 * 列表 / 头部那两处（显示会话本身的图标）继续用 `peerAvatarClass(id)`：
 * 群聊显示的是群自己的图标，不是某个成员。
 */
export function peerAvatarClassIn(
  conversation: Pick<Conversation, 'kind' | 'memberIds'>,
  userId: string,
): string {
  return PEER_AVATAR_CLASS[peerIndexIn(conversation, userId)];
}

/** 会话内的成员昵称颜色。与 `peerAvatarClassIn` 同源，保证同一个人两处同色 */
export function peerNameClassIn(
  conversation: Pick<Conversation, 'kind' | 'memberIds'>,
  userId: string,
): string {
  return PEER_NAME_CLASS[peerIndexIn(conversation, userId)];
}

/* ------------------------------ 文件 ------------------------------ */

/**
 * 附件分类。
 *
 * 只用于选图标与文案（「图片」「PDF」「压缩包」），
 * 不做任何安全判断 —— 类型白名单是后端的事，
 * 前端按扩展名猜测的东西挡不住攻击者。
 */
export type FileKind =
  | 'image'
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'archive'
  | 'audio'
  | 'video'
  | 'code'
  | 'text'
  | 'other';

const EXT_MAP: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  csv: 'sheet',
  ppt: 'slide',
  pptx: 'slide',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  tar: 'archive',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  mp4: 'video',
  mov: 'video',
  webm: 'video',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  json: 'code',
  py: 'code',
  go: 'code',
  rs: 'code',
  java: 'code',
  css: 'code',
  html: 'code',
  md: 'text',
  txt: 'text',
};

export function fileKind(name: string, mimeType: string): FileKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';

  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_MAP[ext] ?? 'other';
}

/** 分类对应的中文标签，用于文件卡片的副标题 */
export const FILE_KIND_LABEL: Record<FileKind, string> = {
  image: '图片',
  pdf: 'PDF',
  doc: '文档',
  sheet: '表格',
  slide: '演示文稿',
  archive: '压缩包',
  audio: '音频',
  video: '视频',
  code: '代码',
  text: '文本',
  other: '文件',
};

/**
 * 单文件体积上限。
 *
 * 与后端约定保持一致（见设计文档的接口约定表），
 * 前端先拦一道是为了不在传了 30 秒之后才告诉用户超限。
 */
export const CHAT_FILE_MAX_BYTES = 50 * 1024 * 1024;

/** 判断附件是否能在气泡里直接预览成缩略图 */
export function isPreviewableImage(attachment: ChatAttachment): boolean {
  return attachment.mimeType.startsWith('image/') && !!attachment.previewUrl;
}
