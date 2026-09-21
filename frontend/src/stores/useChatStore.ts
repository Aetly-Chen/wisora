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
  name: string;
  percent: number;
}

interface ChatState {
  meId: string;

  friends: Friend[];
  conversations: Conversation[];
  /** 会话 id → 消息列表。按会话分桶是为了让非当前会话也能收到推送 */
  messagesByConversation: Record<string, Message[]>;

  activeId?: string;
  keyword: string;
  listLoading: boolean;
  messagesLoading: boolean;
  /** 附件上传进度；非空时输入区显示进度条 */
  upload?: UploadState;
  /** 正在输入的人：会话 id → 用户 id 列表 */
  typing: Record<string, string[]>;
  /** 草稿：会话 id → 文本 */
  drafts: Record<string, string>;

  error?: string;
  notice?: string;

  init: (currentUserId: string) => Promise<void>;
  dispose: () => void;
  setKeyword: (keyword: string) => void;
  setDraft: (conversationId: string, text: string) => void;

  openConversation: (id: string) => Promise<void>;
  send: (payload: { text?: string; note?: Message['note'] }) => Promise<void>;
  attachAndSend: (file: File) => Promise<void>;
  retryMessage: (messageId: string) => Promise<void>;

  startDirect: (friendId: string) => Promise<void>;
  startGroup: (payload: { title: string; memberIds: string[] }) => Promise<void>;

  fetchFriends: () => Promise<void>;
  findUsers: (keyword: string) => Promise<Friend[]>;
  addFriend: (userId: string) => Promise<void>;

  togglePin: (conversationId: string) => Promise<void>;
  toggleMute: (conversationId: string) => Promise<void>;
  shareNote: (payload: ShareNotePayload) => Promise<number>;

  clearError: () => void;
  clearNotice: () => void;
}

/** 订阅句柄。放在模块作用域而不是 state 里：它不该触发重渲染 */
let unsubscribe: (() => void) | null = null;

/** 临时 id 计数，用于乐观插入的消息 */
let tempCounter = 0;

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

  init: async (currentUserId) => {
    setCurrentUser(currentUserId);
    set({ meId: currentUserId, listLoading: true, error: undefined });

    try {
      const [friends, conversations] = await Promise.all([
        listFriends(),
        listConversations(),
      ]);
      // 首次进入默认选中第一个会话，避免右侧一片空白
      const activeId = get().activeId ?? conversations[0]?.id;
      set({ friends, conversations, activeId, listLoading: false });

      if (activeId) await get().openConversation(activeId);
    } catch (err) {
      set({ listLoading: false, error: (err as Error).message || '加载会话失败' });
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
      set({ messagesLoading: false, error: (err as Error).message || '加载消息失败' });
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
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
            m.id === tempId ? saved : m,
          ),
        },
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: saved, updatedAt: saved.createdAt }
            : c,
        ),
      }));
    } catch (err) {
      // 失败不清空气泡，改成标记失败并留重试入口：
      // 直接删掉的话用户写的内容就没了
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map((m) =>
            m.id === tempId ? { ...m, status: 'failed' } : m,
          ),
        },
        error: (err as Error).message || '发送失败',
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
          [conversationId]: (state.messagesByConversation[conversationId] ?? []).map(
            (m) => (m.id === tempId ? saved : m),
          ),
        },
        conversations: state.conversations.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: saved, updatedAt: saved.createdAt }
            : c,
        ),
      }));
    } catch (err) {
      set({ upload: undefined, error: (err as Error).message || '文件发送失败' });
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
    } catch (err) {
      set({ error: (err as Error).message || '创建会话失败' });
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
    } catch (err) {
      set({ error: (err as Error).message || '创建群聊失败' });
    }
  },

  fetchFriends: async () => {
    try {
      set({ friends: await listFriends() });
    } catch (err) {
      set({ error: (err as Error).message || '加载好友失败' });
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
    } catch (err) {
      set({ error: (err as Error).message || '添加好友失败' });
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
    } catch (err) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, pinned: !pinned } : c,
        ),
        error: (err as Error).message || '操作失败',
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
    } catch (err) {
      set((state) => ({
        conversations: state.conversations.map((c) =>
          c.id === conversationId ? { ...c, muted: !muted } : c,
        ),
        error: (err as Error).message || '操作失败',
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
    } catch (err) {
      set({ error: (err as Error).message || '分享失败' });
      return 0;
    }
  },

  clearError: () => set({ error: undefined }),
  clearNotice: () => set({ notice: undefined }),
}));
