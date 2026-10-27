/**
 * 聊天状态。
 *
 * 与 useAgentStore / useNotesStore 保持同一套路：
 * 组件只管渲染与交互，数据与副作用收在这一层。
 *
 * 两个刻意的设计：
 *
 * 1. **消息按会话分桶存**（messagesByConversation），而不是只存
 *    「当前会话的消息」。因为实时推送会往非当前会话里追加消息
 *    （未读计数、列表摘要都靠它），只存一份就必须回头重新拉。
 *
 * 2. **草稿按会话保存**。切走再切回来草稿还在，是聊天类产品的基本预期；
 *    只用一个 draft 字段会让用户在切换会话时丢掉正在写的话。
 */

import { create } from 'zustand';
import type {
  Conversation,
  Friend,
  Message,
  ShareNotePayload,
} from '@/types/chat';
import {
  addFriend as apiAddFriend,
  createDirectConversation,
  createGroupConversation,
  listConversations,
  listFriends,
  listMessages,
  markConversationRead,
  searchUsers,
  sendMessage,
  setCurrentUser,
  shareNote as apiShareNote,
  subscribeChatEvents,
  updateConversationFlags,
  uploadAttachment,
} from '@/request/chat';
import { apiErrorMessage } from '@/lib/api-error';

/* ------------------------------ 派生工具 ------------------------------ */

/**
 * 会话标题。
 *
 * 单聊没有 title，标题取对方的名字 —— 这一步必须在渲染时才做，
 * 因为「对方是谁」依赖成员列表与好友表，存进会话里会有一致性风险
 * （改了好友昵称，会话标题还是旧的）。
 */
export function conversationTitle(
  conversation: Conversation,
  friends: Friend[],
  meId: string,
): string {
  if (conversation.kind === 'group') return conversation.title ?? '未命名群聊';

  const peerId = conversation.memberIds.find((id) => id !== meId);
  const peer = friends.find((f) => f.id === peerId);
  return peer?.name ?? '未知联系人';
}

/** 单聊的对方；群聊返回 undefined（头像改用群名首字） */
export function conversationPeer(
  conversation: Conversation,
  friends: Friend[],
  meId: string,
): Friend | undefined {
  const peerId = conversation.memberIds.find((id) => id !== meId);
  return friends.find((f) => f.id === peerId);
}

/** 列表过滤 + 排序：置顶优先，其余按最后消息时间倒序 */
export function visibleConversations(
  conversations: Conversation[],
  keyword: string,
  friends: Friend[],
  meId: string,
): Conversation[] {
  const q = keyword.trim().toLowerCase();

  const matched = q
    ? conversations.filter((c) => {
        if (conversationTitle(c, friends, meId).toLowerCase().includes(q)) return true;
        return (c.lastMessage?.text ?? '').toLowerCase().includes(q);
      })
    : conversations;

  return [...matched].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/* ------------------------------ Store ------------------------------ */

interface UploadState {
  name: string; // 正在上传的文件名，显示在进度条旁边
  percent: number; // 上传进度 0-100
}

interface ChatState {
  meId: string; // 当前用户 id；判断气泡左右、区分「我发的」全靠它

  friends: Friend[]; // 好友列表
  conversations: Conversation[]; // 会话列表（单聊 + 群聊），已按置顶/活跃度排好
  /** 会话 id → 消息列表。按会话分桶是为了让非当前会话也能收到推送 */
  messagesByConversation: Record<string, Message[]>;

  activeId?: string; // 当前打开的会话 id；undefined 表示还没选
  keyword: string; // 会话搜索关键词（本地过滤，不打接口）
  listLoading: boolean; // 会话列表加载中
  messagesLoading: boolean; // 当前会话的历史消息加载中，用于渲染骨架
  /** 附件上传进度；非空时输入区显示进度条 */
  upload?: UploadState;
  /** 正在输入的人：会话 id → 用户 id 列表 */
  typing: Record<string, string[]>;
  /** 草稿：会话 id → 文本 */
  drafts: Record<string, string>;

  error?: string; // 错误提示文案
  notice?: string; // 一次性成功提示（如「已添加好友」）

  /**
   * 拉好友与会话、订阅实时事件。
   *
   * `autoSelect` 由**调用方**决定：冷启动要不要自动进第一个会话，
   * 取决于当前是桌面还是移动端布局，而只有页面知道这件事（见 `pages/chat`）。
   */
  init: (currentUserId: string, options: { autoSelect: boolean }) => Promise<void>;
  dispose: () => void; // 断开实时连接（组件卸载时调，不清数据）
  /**
   * 断开实时连接并清空全部状态。
   *
   * 退出登录时必须调：好友、会话、消息都留在内存里，
   * 换个账号登录就会看到上一个人的聊天记录（并且 WS 还会带着
   * 已失效的令牌不断重连）。
   */
  reset: () => void;
  setKeyword: (keyword: string) => void; // 写搜索词，列表在本地过滤
  setDraft: (conversationId: string, text: string) => void; // 存草稿，切会话后回来还在

  openConversation: (id: string) => Promise<void>; // 打开会话：加载消息 + 清未读
  send: (payload: { text?: string; note?: Message['note'] }) => Promise<void>; // 发文本 / 笔记卡片
  attachAndSend: (file: File) => Promise<void>; // 上传附件并作为消息发出
  retryMessage: (messageId: string) => Promise<void>; // 重发失败的消息

  startDirect: (friendId: string) => Promise<void>; // 与某好友开启（或复用）单聊
  startGroup: (payload: { title: string; memberIds: string[] }) => Promise<void>; // 建群聊

  fetchFriends: () => Promise<void>; // 拉好友列表
  findUsers: (keyword: string) => Promise<Friend[]>; // 按邮箱 / handle 搜人（加好友用）
  addFriend: (userId: string) => Promise<void>; // 加好友

  togglePin: (conversationId: string) => Promise<void>; // 会话置顶 / 取消
  toggleMute: (conversationId: string) => Promise<void>; // 免打扰开关
  shareNote: (payload: ShareNotePayload) => Promise<number>; // 分享笔记到若干好友，返回送达的会话数

  clearError: () => void; // 关掉错误提示
  clearNotice: () => void; // 关掉成功提示
}

/** 订阅句柄。放在模块作用域而不是 state 里：它不该触发重渲染 */
let unsubscribe: (() => void) | null = null;

/** 临时 id 计数，用于乐观插入的消息 */
let tempCounter = 0;

/**
 * 用服务端返回的消息替换掉乐观插入的那条。
 *
 * 除了替换 temp，还必须**清掉同 id 的其它条目** —— 这里有个真实的竞态：
 *
 *   1. 乐观插入 temp_X
 *   2. POST 发出
 *   3. 服务端落库后先推了一条 WebSocket 事件（真实 id 为 N）
 *      → 事件处理里按 id 去重，列表里没有 N，于是追加了一条 N
 *   4. POST 响应回来，把 temp_X 替换成 N
 *      → 列表里就出现了两条 N
 *
 * 症状是 React 报 "Encountered two children with the same key"，
 * 界面上还可能重影。只在发送方出现，因为只有发送方同时收到
 * 「REST 响应」和「自己那条 WS 推送」。
 */
function reconcileMessage(
  saved: Message,
  tempId: string,
  list: Message[],
): Message[] {
  const replaced = list.map((m) => (m.id === tempId ? saved : m));
  let kept = false;
  return replaced.filter((m) => {
    if (m.id !== saved.id) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

export const useChatStore = create<ChatState>((set, get) => ({
  meId: '',
  friends: [],
  conversations: [],
  messagesByConversation: {},
  activeId: undefined,
  keyword: '',
  listLoading: false,
  messagesLoading: false,
  upload: undefined,
  typing: {},
  drafts: {},
  error: undefined,
  notice: undefined,

  init: async (currentUserId, { autoSelect }) => {
    setCurrentUser(currentUserId);
    set({ meId: currentUserId, listLoading: true, error: undefined });

    try {
      const [friends, conversations] = await Promise.all([
        listFriends(),
        listConversations(),
      ]);
      /*
       * 冷启动默认选中第一个会话，避免右侧一片空白 —— 但**只在桌面**这么做。
       *
       * 移动端布局是「消息区是底层、会话列表是抽屉」，一选中就直接进了某个
       * 会话、抽屉还是关着的，用户看不到列表（Telegram 是先给列表）。
       * 而且自动选中的是列表里第一个（置顶/最近活跃），
       * 排在下面的未读会话在移动端就完全看不到了。
       *
       * 这里不自己判断断点：store 拿不到布局语义，而且窗口 resize 时会飘。
       */
      const activeId =
        get().activeId ?? (autoSelect ? conversations[0]?.id : undefined);
      set({ friends, conversations, activeId, listLoading: false });

      if (activeId) await get().openConversation(activeId);
    } catch (err) {
      set({ listLoading: false, error: apiErrorMessage(err, '加载会话失败') });
    }

    /*
     * 订阅实时事件。
     * StrictMode 下 effect 会跑两次，所以这里先解掉旧的再订阅，
     * 否则一次推送会被处理两遍（表现为消息重复一条）。
     */
    unsubscribe?.();
    unsubscribe = subscribeChatEvents((event) => {
      const { activeId, meId } = get();

      switch (event.type) {
        case 'message': {
          const message = event.message;
          set((state) => {
            const bucket = state.messagesByConversation[message.conversationId] ?? [];
            // 去重：自己发的消息在乐观插入后又会收到一次推送
            if (bucket.some((m) => m.id === message.id)) return {};

            const isActive = state.activeId === message.conversationId;
            const mine = message.senderId === state.meId;

            return {
              messagesByConversation: {
                ...state.messagesByConversation,
                [message.conversationId]: [...bucket, message],
              },
              conversations: state.conversations.map((c) =>
                c.id === message.conversationId
                  ? {
                      ...c,
                      lastMessage: message,
                      updatedAt: message.createdAt,
                      // 只有「不在当前会话」且「不是我发的」才计未读
                      unread:
                        isActive || mine ? c.unread : c.unread + 1,
                    }
                  : c,
              ),
            };
          });

          // 正在看的会话收到新消息，立刻回执已读
          if (activeId === message.conversationId && message.senderId !== meId) {
            void markConversationRead(message.conversationId);
          }
          break;
        }

        case 'typing': {
          set((state) => {
            const current = state.typing[event.conversationId] ?? [];
            const next = event.typing
              ? [...new Set([...current, event.userId])]
              : current.filter((id) => id !== event.userId);

            return {
              typing: { ...state.typing, [event.conversationId]: next },
            };
          });
          break;
        }

        case 'read': {
          // 对方已读：把我发出的消息标记为已读
          set((state) => ({
            messagesByConversation: Object.fromEntries(
              Object.entries(state.messagesByConversation).map(([id, list]) => [
                id,
                id === event.conversationId && event.userId !== meId
                  ? list.map((m) =>
                      m.senderId === meId && m.status === 'sent'
                        ? { ...m, status: 'read' as const }
                        : m,
                    )
                  : list,
              ]),
            ),
          }));
          break;
        }

        case 'presence': {
          set((state) => ({
            friends: state.friends.map((f) =>
              f.id === event.userId ? { ...f, presence: event.presence } : f,
            ),
          }));
          break;
        }
      }
    });
  },

  dispose: () => {
    unsubscribe?.();
    unsubscribe = null;
  },

  reset: () => {
    unsubscribe?.();
    unsubscribe = null;
    set({
      meId: '',
      friends: [],
      conversations: [],
      messagesByConversation: {},
      activeId: undefined,
      keyword: '',
      listLoading: false,
      messagesLoading: false,
      upload: undefined,
      typing: {},
      drafts: {},
      error: undefined,
      notice: undefined,
    });
  },

  setKeyword: (keyword) => set({ keyword }),

  setDraft: (conversationId, text) =>
    set((state) => ({ drafts: { ...state.drafts, [conversationId]: text } })),

  openConversation: async (id) => {
    set({ activeId: id, messagesLoading: true, error: undefined });

    // 本地已有消息就不重复拉，直接清未读即可（切回上一个会话的常见路径）
    const cached = get().messagesByConversation[id];
    if (cached) {
      set({ messagesLoading: false });
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, unread: 0 } : c,
        ),
      }));
      void markConversationRead(id);
      return;
    }

    try {
      const messages = await listMessages(id);
      set((state) => ({
        messagesByConversation: { ...state.messagesByConversation, [id]: messages },
        messagesLoading: false,
        conversations: state.conversations.map((c) =>
          c.id === id ? { ...c, unread: 0 } : c,
        ),
      }));
      void markConversationRead(id);
    } catch (err) {
      set({ messagesLoading: false, error: apiErrorMessage(err, '加载消息失败') });
    }
  },

  send: async ({ text, note }) => {
    const { activeId, meId } = get();
    if (!activeId) return;

    const conversationId = activeId;
    const trimmed = text?.trim() ?? '';
    if (!trimmed && !note) return;

    /*
     * 乐观插入：先按「发送中」把气泡画出来，再等接口返回替换。
     * 不这么做的话，点击发送到气泡出现之间会有 200ms+ 的空白，
     * 用户会以为没点上而重复点。
     */
    const tempId = `temp_${++tempCounter}`;
    const optimistic: Message = {
      id: tempId,
      conversationId,
      senderId: meId,
      kind: note ? 'note' : 'text',
      text: trimmed || null,
      attachment: null,
      note: note ?? null,
      createdAt: new Date().toISOString(),
      status: 'sending',
    };

    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [conversationId]: [...(state.messagesByConversation[conversationId] ?? []), optimistic],
      },
      drafts: { ...state.drafts, [conversationId]: '' },
      error: undefined,
    }));

    try {
      const saved = await sendMessage({ conversationId, text: trimmed, note: note ?? undefined });
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: reconcileMessage(
            saved,
            tempId,
            state.messagesByConversation[conversationId] ?? [],
          ),
        },
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: saved, updatedAt: saved.createdAt }
            : c,
        ),
      }));
    } catch {
      // 失败不清空气泡，改成标记失败并留重试入口：
      // 直接删掉的话用户写的内容就没了。
      // 文案交给请求层 toast（后端 msg），这里不再往横幅塞一份 ——
      // 一次失败只提示一处。
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
            m.id === tempId ? { ...m, status: 'failed' } : m,
          ),
        },
      }));
    }
  },

  attachAndSend: async (file) => {
    const { activeId, meId } = get();
    if (!activeId) return;

    const conversationId = activeId;
    set({ upload: { name: file.name, percent: 0 }, error: undefined });

    try {
      const attachment = await uploadAttachment(file, (percent) =>
        set({ upload: { name: file.name, percent } }),
      );

      // 上传完成后再插入气泡：附件还没有 id 时画出来也没有意义
      const tempId = `temp_${++tempCounter}`;
      const kind: Message['kind'] = attachment.mimeType.startsWith('image/')
        ? 'image'
        : 'file';
      const optimistic: Message = {
        id: tempId,
        conversationId,
        senderId: meId,
        kind,
        text: null,
        attachment,
        note: null,
        createdAt: new Date().toISOString(),
        status: 'sending',
      };

      set((state) => ({
        upload: undefined,
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: [
            ...(state.messagesByConversation[conversationId] ?? []),
            optimistic,
          ],
        },
      }));

      const saved = await sendMessage({ conversationId, attachment });
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: reconcileMessage(
            saved,
            tempId,
            state.messagesByConversation[conversationId] ?? [],
          ),
        },
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: saved, updatedAt: saved.createdAt }
            : c,
        ),
      }));
    } catch {
      // 进度条收起；错误文案由请求层 toast 负责
      set({ upload: undefined });
    }
  },

  retryMessage: async (messageId) => {
    const { activeId, messagesByConversation } = get();
    if (!activeId) return;

    const target = (messagesByConversation[activeId] ?? []).find((m) => m.id === messageId);
    if (!target) return;

    // 先把失败的那条摘掉，再走一次正常发送，避免出现两条重复气泡
    set((state) => ({
      messagesByConversation: {
        ...state.messagesByConversation,
        [activeId]: (state.messagesByConversation[activeId] ?? []).filter(
          (m) => m.id !== messageId,
        ),
      },
    }));

    await get().send({ text: target.text ?? undefined, note: target.note ?? undefined });
  },

  startDirect: async (friendId) => {
    try {
      const conversation = await createDirectConversation(friendId);
      set((state) => {
        const exists = state.conversations.some((c) => c.id === conversation.id);
        return {
          conversations: exists
            ? state.conversations.map((c) =>
                c.id === conversation.id ? conversation : c,
              )
            : [conversation, ...state.conversations],
          activeId: conversation.id,
          error: undefined,
        };
      });
      await get().openConversation(conversation.id);
    } catch {
      // 建会话失败：只走 toast。横幅是「页面加载不出来」专用的位置
    }
  },

  startGroup: async ({ title, memberIds }) => {
    try {
      const conversation = await createGroupConversation({ title, memberIds });
      set((state) => ({
        conversations: [conversation, ...state.conversations],
        activeId: conversation.id,
        error: undefined,
      }));
      await get().openConversation(conversation.id);
    } catch {
      // 同上：建群失败只走 toast
    }
  },

  fetchFriends: async () => {
    try {
      set({ friends: await listFriends() });
    } catch (err) {
      set({ error: apiErrorMessage(err, '加载好友失败') });
    }
  },

  findUsers: (keyword) => searchUsers(keyword),

  addFriend: async (userId) => {
    try {
      const friend = await apiAddFriend(userId);
      set((state) => ({
        friends: state.friends.some((f) => f.id === friend.id)
          ? state.friends.map((f) => (f.id === friend.id ? friend : f))
          : [...state.friends, friend],
        notice: `已添加 ${friend.name} 为好友`,
      }));
    } catch {
      // 加好友失败只走 toast
    }
  },

  togglePin: async (conversationId) => {
    const current = get().conversations.find((c) => c.id === conversationId);
    if (!current) return;
    const pinned = !current.pinned;

    // 置顶是高频轻量操作，先改本地再发请求，失败回滚
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, pinned } : c,
      ),
    }));

    try {
      await updateConversationFlags(conversationId, { pinned });
    } catch {
      // 回滚本地置顶状态；错误文案由 toast 负责，不再占横幅
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, pinned: !pinned } : c,
        ),
      }));
    }
  },

  toggleMute: async (conversationId) => {
    const current = get().conversations.find((c) => c.id === conversationId);
    if (!current) return;
    const muted = !current.muted;

    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, muted } : c,
      ),
    }));

    try {
      await updateConversationFlags(conversationId, { muted });
    } catch {
      // 回滚本地免打扰状态；错误文案由 toast 负责
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, muted: !muted } : c,
        ),
      }));
    }
  },

  shareNote: async (payload) => {
    try {
      const result = await apiShareNote(payload);

      // 分享等于给每位好友发了一条消息：把新会话与消息并进本地状态，
      // 否则切到聊天页看不到刚分享的内容，用户会以为没发出去
      const conversations = await listConversations();
      set({ conversations, notice: `已分享给 ${result.conversationCount} 位好友` });
      return result.conversationCount;
    } catch {
      // 返回值表示「发给了几个会话」，失败即 0；文案由 toast 负责
      return 0;
    }
  },

  clearError: () => set({ error: undefined }),
  clearNotice: () => set({ notice: undefined }),
}));
