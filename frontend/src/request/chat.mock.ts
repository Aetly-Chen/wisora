/**
 * 聊天模块的内存 mock 数据。
 *
 * 这个文件的存在只为了一件事：后端就绪前，页面能真实跑起来。
 * 它模拟的是**数据与实时事件**，不是页面逻辑 ——
 * 所以 UI 上的加载态、未读、发送中、失败分支都是真的被走通了，
 * 而不是静态摆设。
 *
 * 后端接好之后，删掉本文件与 `chat.ts` 里的 mock 分支即可，
 * 页面与 store 的代码一行都不用动。
 */

import type {
  ChatEvent,
  Conversation,
  Friend,
  Message,
  MessageKind,
} from '@/types/chat';

/* ------------------------------ 内部状态 ------------------------------ */

let meId = '';
let seeded = false;

const friends: Friend[] = [];
const conversations: Conversation[] = [];
const messages: Message[] = [];

/** 实时事件订阅者。后端就绪后换成 WebSocket / SSE 的连接管理 */
const subscribers = new Set<(event: ChatEvent) => void>();

/** 自动回复的轮转游标，让 mock 的回复不至于每次都一样 */
const replyCursor = new Map<string, number>();

let idCounter = 0;
export const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${++idCounter}`;

const now = () => new Date();
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const daysAgo = (d: number, hour = 10, minute = 24) => {
  const t = new Date(Date.now() - d * 86_400_000);
  t.setHours(hour, minute, 0, 0);
  return t.toISOString();
};

export function subscribe(handler: (event: ChatEvent) => void): () => void {
  subscribers.add(handler);
  return () => {
    subscribers.delete(handler);
  };
}

export function emit(event: ChatEvent): void {
  for (const handler of subscribers) handler(event);
}

/* ------------------------------ 种子数据 ------------------------------ */

interface SeedFriend {
  name: string;
  handle: string;
  bio: string;
  presence: Friend['presence'];
}

const SEED_FRIENDS: SeedFriend[] = [
  { name: '陈亦航', handle: 'yihang.chen', bio: '后端 · NestJS / PostgreSQL', presence: 'online' },
  { name: '余知微', handle: 'zhiwei.yu', bio: '设计 · 交互与视觉', presence: 'online' },
  { name: '苏砚', handle: 'yan.su', bio: '前端 · React / 可视化', presence: 'away' },
  { name: '黎青禾', handle: 'qinghe.li', bio: '产品 · Wisora 工作台', presence: 'offline' },
  { name: '郑修远', handle: 'xiuyuan.zheng', bio: '算法 · LLM 应用', presence: 'online' },
  { name: '何澈', handle: 'che.he', bio: '测试 · 自动化与回归', presence: 'offline' },
];

/** 可被搜索到但尚未加好友的人，用于验证「添加好友」流程 */
const SEED_STRANGERS: SeedFriend[] = [
  { name: '沈砚舟', handle: 'yanzhou.shen', bio: '运维 · K8s / 监控', presence: 'offline' },
  { name: '孟秋池', handle: 'qiuchi.meng', bio: '前端 · 性能优化', presence: 'online' },
];

function push(
  conversationId: string,
  senderId: string,
  kind: MessageKind,
  payload: Partial<Message>,
  createdAt: string,
): Message {
  const message: Message = {
    id: nextId('msg'),
    conversationId,
    senderId,
    kind,
    text: null,
    attachment: null,
    note: null,
    createdAt,
    status: 'read',
    ...payload,
  };
  messages.push(message);
  return message;
}

/** 按 userId 找展示名，群聊回复里带上称呼更像真人 */
function nameOf(userId: string): string {
  return friends.find((f) => f.id === userId)?.name ?? '对方';
}

/**
 * 初始化种子数据。
 *
 * 必须在拿到真实登录用户 id 之后调用：mock 的 senderId 存的是真实用户 id，
 * 这样「判断是不是我发的」在前端只需要一次 id 比较，
 * 不需要为 mock 再写一套「'me' 等于我」的特例逻辑。
 */
export function ensureSeeded(currentUserId: string): void {
  if (seeded && meId === currentUserId) return;

  meId = currentUserId;
  seeded = true;
  friends.length = 0;
  conversations.length = 0;
  messages.length = 0;

  for (const f of [...SEED_FRIENDS, ...SEED_STRANGERS]) {
    friends.push({
      id: nextId('usr'),
      name: f.name,
      handle: f.handle,
      email: `${f.handle}@wisora.dev`,
      bio: f.bio,
      presence: f.presence,
      isFriend: SEED_FRIENDS.includes(f),
    });
  }

  const [yiHang, zhiWei, yanSu, qingHe, xiuYuan, heChe] = friends;

  /* ---------- 1) 单聊：陈亦航（有昨天与今天的消息） ---------- */
  const c1: Conversation = {
    id: nextId('cnv'),
    kind: 'direct',
    title: null,
    memberIds: [meId, yiHang.id],
    lastMessage: null,
    unread: 0,
    pinned: true,
    muted: false,
    createdAt: daysAgo(9, 9, 12),
    updatedAt: minutesAgo(4),
  };
  conversations.push(c1);
  push(c1.id, meId, 'text', { text: '票据的有效期我想从 60 秒收到 30 秒，安全上更稳一点。' }, daysAgo(1, 10, 12));
  push(
    c1.id,
    yiHang.id,
    'text',
    { text: '同意。我把 Redis 的 setex 一起改了，另外过期时间抽成了常量，免得散在好几处。' },
    daysAgo(1, 10, 15),
  );
  push(c1.id, meId, 'text', { text: '顺手把换票接口也加上限流，防止有人刷票。' }, daysAgo(1, 10, 21));
  push(
    c1.id,
    yiHang.id,
    'file',
    {
      attachment: {
        id: nextId('att'),
        name: '票据鉴权时序图.pdf',
        size: 486_912,
        mimeType: 'application/pdf',
      },
    },
    daysAgo(1, 11, 2),
  );
  push(
    c1.id,
    yiHang.id,
    'text',
    { text: '时序图放这儿了，评审的时候对着看会清楚一些。' },
    minutesAgo(6),
  );

  /* ---------- 2) 群聊：Wisora 前端组 ---------- */
  const c2: Conversation = {
    id: nextId('cnv'),
    kind: 'group',
    title: 'Wisora 前端组',
    memberIds: [meId, yanSu.id, zhiWei.id, qingHe.id],
    lastMessage: null,
    unread: 3,
    pinned: false,
    muted: false,
    createdAt: daysAgo(20, 9, 0),
    updatedAt: minutesAgo(38),
  };
  conversations.push(c2);
  push(
    c2.id,
    qingHe.id,
    'text',
    { text: '这周的进度我想在周五过一遍，主要看聊天模块和笔记分享这一块。' },
    hoursAgo(3),
  );
  push(
    c2.id,
    zhiWei.id,
    'image',
    {
      text: '消息气泡的间距我调了两版，第二版把同一个人连续发的几条收紧了。',
      attachment: {
        id: nextId('att'),
        name: '气泡间距对比.png',
        size: 262_144,
        mimeType: 'image/png',
        previewUrl: 'https://picsum.photos/seed/wisora-chat-bubble/720/460',
      },
    },
    hoursAgo(2),
  );
  push(
    c2.id,
    zhiWei.id,
    'text',
    { text: '另外日期分隔那条我按 Telegram 的做法做成了胶囊，你们看看要不要。' },
    hoursAgo(2),
  );
  push(
    c2.id,
    yanSu.id,
    'text',
    { text: '要。长会话翻起来靠它定位。' },
    minutesAgo(38),
  );

  /* ---------- 3) 单聊：苏砚（未读 2） ---------- */
  const c3: Conversation = {
    id: nextId('cnv'),
    kind: 'direct',
    title: null,
    memberIds: [meId, yanSu.id],
    lastMessage: null,
    unread: 2,
    pinned: false,
    muted: false,
    createdAt: daysAgo(6, 14, 0),
    updatedAt: hoursAgo(5),
  };
  conversations.push(c3);
  push(
    c3.id,
    yanSu.id,
    'note',
    {
      text: '上次那份性能优化记录我分享给你了，里面有长任务的测量方法。',
      note: {
        noteId: 'seed-note-perf',
        title: '导入性能优化记录',
        kind: 'note',
        childCount: 0,
      },
    },
    hoursAgo(5),
  );
  push(
    c3.id,
    yanSu.id,
    'text',
    { text: '你要是也遇到打开大文档卡的情况，可以先看 longtask 那一段。' },
    hoursAgo(5),
  );

  /* ---------- 4) 单聊：郑修远（最后一条是文件） ---------- */
  const c4: Conversation = {
    id: nextId('cnv'),
    kind: 'direct',
    title: null,
    memberIds: [meId, xiuYuan.id],
    lastMessage: null,
    unread: 1,
    pinned: false,
    muted: false,
    createdAt: daysAgo(11, 16, 30),
    updatedAt: daysAgo(1, 17, 40),
  };
  conversations.push(c4);
  push(c4.id, meId, 'text', { text: '提示词那一版我跑完了，编造理由的情况基本没有了。' }, daysAgo(1, 17, 12));
  push(
    c4.id,
    xiuYuan.id,
    'file',
    {
      text: '这是评测集和结果，你对着看差异。',
      attachment: {
        id: nextId('att'),
        name: '提示词评测结果.xlsx',
        size: 1_248_576,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    },
    daysAgo(1, 17, 40),
  );

  /* ---------- 5) 群聊：上线前联调 ---------- */
  const c5: Conversation = {
    id: nextId('cnv'),
    kind: 'group',
    title: '上线前联调',
    memberIds: [meId, heChe.id, yiHang.id],
    lastMessage: null,
    unread: 0,
    pinned: false,
    muted: true,
    createdAt: daysAgo(4, 9, 30),
    updatedAt: daysAgo(2, 15, 8),
  };
  conversations.push(c5);
  push(
    c5.id,
    heChe.id,
    'text',
    { text: '回归用例补完了，附件上传那块的越权和类型拒绝都在里面。' },
    daysAgo(2, 15, 8),
  );

  // 会话的最后一条消息回填，列表才能渲染摘要
  for (const c of conversations) {
    const own = messages.filter((m) => m.conversationId === c.id);
    c.lastMessage = own.length > 0 ? own[own.length - 1] : null;
  }
}

/* ------------------------------ 访问器 ------------------------------ */

export const mockDb = {
  get meId() {
    return meId;
  },
  friends,
  conversations,
  messages,

  findFriend(id: string) {
    return friends.find((f) => f.id === id);
  },

  conversationMessages(conversationId: string) {
    return messages
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  },

  touchConversation(conversationId: string, lastMessage: Message) {
    const c = conversations.find((x) => x.id === conversationId);
    if (!c) return;
    c.lastMessage = lastMessage;
    c.updatedAt = lastMessage.createdAt;
  },

  /** 单聊会话已存在则复用，避免给同一个好友建出好几条会话 */
  findDirectWith(friendId: string) {
    return conversations.find(
      (c) => c.kind === 'direct' && c.memberIds.includes(friendId),
    );
  },
};

/* ------------------------------ 自动回复模拟 ------------------------------ */

/**
 * 让 mock 有「对方在输入」与「收到回复」的真实感。
 *
 * 后端就绪后删掉它，由 WebSocket 推送真事件；
 * store 侧的订阅处理逻辑不变。
 */
export function scheduleAutoReply(conversationId: string): void {
  const conversation = conversations.find((c) => c.id === conversationId);
  if (!conversation) return;

  const peerId = conversation.memberIds.find((id) => id !== meId);
  if (!peerId) return;

  const isGroup = conversation.kind === 'group';
  const pool = isGroup
    ? ['收到，我这边也过一遍。', '这个我看下，稍后回你。', '记下了，周五一起过。']
    : [
        '好，我这边同步改一下。',
        '收到。我跑一遍看看结果。',
        '明白，我先把这版记下来。',
        '行，那按这个来。',
      ];

  const index = (replyCursor.get(conversationId) ?? 0) % pool.length;
  replyCursor.set(conversationId, index + 1);
  const body = isGroup ? `${nameOf(peerId)}：${pool[index]}` : pool[index];

  // 先推「正在输入」，再推消息，顺序与真实服务端一致
  setTimeout(() => emit({ type: 'typing', conversationId, userId: peerId, typing: true }), 600);
  setTimeout(() => {
    emit({ type: 'typing', conversationId, userId: peerId, typing: false });

    const reply: Message = {
      id: nextId('msg'),
      conversationId,
      senderId: peerId,
      kind: 'text',
      text: body,
      attachment: null,
      note: null,
      createdAt: now().toISOString(),
      status: 'read',
    };
    messages.push(reply);
    mockDb.touchConversation(conversationId, reply);
    emit({ type: 'message', message: reply });
  }, 1900);
}
