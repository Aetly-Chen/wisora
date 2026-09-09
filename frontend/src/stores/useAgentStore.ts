import { create } from 'zustand';
import type {
  AgentMessage,
  ConversationSummary,
  StreamEvent,
} from '../types/agent';
import {
  deleteConversation,
  getConversationMessages,
  listConversations,
  streamChat,
} from '../request/ai-stream';

/**
 * Agent 对话状态
 *
 * 设计要点：
 * - 流式 token 只更新"最后一条助手消息"，避免整列重渲染
 * - stop() 通过 AbortController 中断 fetch，
 *   后端收到连接断开会 abort 掉 LLM 请求，真正停止计费
 * - conversationId 由服务端的 start 事件下发，
 *   下一轮提问时带上它才能接续上下文
 */

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const WELCOME_CONTENT =
  '你好，我是 Wisora AI。我可以帮你解答问题、分析数据、撰写内容或搜索信息。';

/** 空状态 / 新会话的初始消息 */
function welcomeMessage(): AgentMessage {
  return {
    id: 'welcome',
    role: 'ai',
    content: WELCOME_CONTENT,
    timestamp: new Date(),
  };
}

interface AgentState {
  messages: AgentMessage[];
  conversationId?: string;
  isStreaming: boolean;
  error?: string;

  /** 侧边栏会话列表 */
  conversations: ConversationSummary[];
  /** 正在拉取某个会话的历史消息 */
  loadingHistory: boolean;

  send: (question: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  clearError: () => void;

  loadConversations: () => Promise<void>;
  openConversation: (id: string) => Promise<void>;
  removeConversation: (id: string) => Promise<void>;
}

let controller: AbortController | null = null;

export const useAgentStore = create<AgentState>((set, get) => ({
  messages: [welcomeMessage()],
  conversationId: undefined,
  isStreaming: false,
  error: undefined,
  conversations: [],
  loadingHistory: false,

  send: async (question: string) => {
    const text = question.trim();
    if (!text || get().isStreaming) return;

    controller = new AbortController();

    // 本轮之前还没有 conversationId → 服务端会新建会话，
    // 结束后需要刷新侧边栏列表（标题由问题前 30 字生成）
    const isNewConversation = !get().conversationId;

    const userMessage: AgentMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    // 助手占位消息，后续 token 往这里累加
    const assistantId = generateId();

    set((state) => ({
      messages: [
        // 首次提问时移除欢迎语
        ...(state.messages[0]?.id === 'welcome' &&
        state.messages.length === 1
          ? []
          : state.messages),
        userMessage,
        {
          id: assistantId,
          role: 'ai',
          content: '',
          timestamp: new Date(),
        },
      ],
      isStreaming: true,
      error: undefined,
    }));

    /** 往最后一条助手消息追加内容 */
    const appendToAssistant = (
      updater: (msg: AgentMessage) => Partial<AgentMessage>,
    ) => {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === assistantId ? { ...m, ...updater(m) } : m,
        ),
      }));
    };

    try {
      await streamChat({
        question: text,
        conversationId: get().conversationId,
        signal: controller.signal,
        handlers: {
          onStart: ({ conversationId }) => set({ conversationId }),

          onToken: (chunk) =>
            appendToAssistant((m) => ({ content: m.content + chunk })),

          onReasoning: (chunk) =>
            appendToAssistant((m) => ({
              reasoning: (m.reasoning ?? '') + chunk,
            })),

          onToolCall: ({ id, name, args }) =>
            set((state) => ({
              messages: [
                ...state.messages,
                {
                  id: `tool-${id}`,
                  role: 'tool',
                  content: `调用工具：${name}\n参数：${args}`,
                  timestamp: new Date(),
                  toolStatus: 'calling',
                },
              ],
            })),

          onToolResult: ({ id, ok, result }) =>
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === `tool-${id}`
                  ? {
                      ...m,
                      content: `${m.content}\n结果：${result}`,
                      toolStatus: ok ? 'done' : 'failed',
                    }
                  : m,
              ),
            })),

          onError: (message) => set({ error: message }),

          onDone: ({ usage }) => {
            // usage 可用于成本核算展示
            if (usage?.total_tokens) {
              appendToAssistant(() => ({
                meta: `消耗 token：${usage.total_tokens}`,
              }));
            }
            set({ isStreaming: false });

            // 新会话已由服务端创建，刷新侧边栏让它出现在列表里
            if (isNewConversation) void get().loadConversations();
          },
        },
      });
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      set({
        isStreaming: false,
        error: aborted ? undefined : (err as Error)?.message || '生成失败',
      });
      if (aborted) {
        // 中断时把已生成的部分保留下来，并标注
        appendToAssistant((m) =>
          m.content ? { meta: '（已停止生成）' } : { content: '（已停止生成）' },
        );
      }
    } finally {
      controller = null;
      set({ isStreaming: false });
    }
  },

  stop: () => {
    controller?.abort();
    controller = null;
    set({ isStreaming: false });
  },

  reset: () => {
    controller?.abort();
    controller = null;
    set({
      messages: [welcomeMessage()],
      conversationId: undefined,
      isStreaming: false,
      error: undefined,
    });
  },

  clearError: () => set({ error: undefined }),

  loadConversations: async () => {
    try {
      const list = await listConversations();
      // 列表加载失败不该打断正在进行的操作，这里静默兜底
      set({ conversations: Array.isArray(list) ? list : [] });
    } catch {
      set({ conversations: [] });
    }
  },

  /**
   * 切换到某个历史会话并回显消息。
   *
   * 注意：切换前必须先中断正在进行的生成，否则旧流会继续往
   * 已替换的 messages 里追加 token，造成串台。
   */
  openConversation: async (id: string) => {
    if (get().conversationId === id && get().messages.length > 1) return;

    controller?.abort();
    controller = null;

    set({
      conversationId: id,
      isStreaming: false,
      error: undefined,
      loadingHistory: true,
      messages: [],
    });

    try {
      const { messages } = await getConversationMessages(id);

      // system 不展示；其余（user/assistant/tool）按原顺序回显。
      // 用类型谓词过滤，让 TS 把 'system' 从联合类型里排除掉。
      const mapped: AgentMessage[] = messages
        .filter(
          (m): m is typeof m & { role: 'user' | 'assistant' | 'tool' } =>
            m.role !== 'system',
        )
        .map((m) => ({
          id: m.id,
          role: m.role === 'assistant' ? ('ai' as const) : m.role,
          content: m.content,
          timestamp: m.createdAt ? new Date(m.createdAt) : new Date(),
          // 历史里的工具轮次都是已完成的
          ...(m.role === 'tool' ? { toolStatus: 'done' as const } : {}),
        }));

      set({ messages: mapped.length > 0 ? mapped : [welcomeMessage()] });
    } catch (err) {
      set({
        messages: [welcomeMessage()],
        error: (err as Error)?.message || '加载会话失败',
      });
    } finally {
      set({ loadingHistory: false });
    }
  },

  removeConversation: async (id: string) => {
    const wasActive = get().conversationId === id;

    // 先本地移除，交互立刻响应；失败再回滚
    const previous = get().conversations;
    set({ conversations: previous.filter((c) => c.id !== id) });

    try {
      await deleteConversation(id);
      // 删掉的正好是当前会话 → 回到空状态，避免继续往已删除的会话发消息
      if (wasActive) {
        controller?.abort();
        controller = null;
        set({
          messages: [welcomeMessage()],
          conversationId: undefined,
          isStreaming: false,
        });
      }
    } catch (err) {
      set({
        conversations: previous,
        error: (err as Error)?.message || '删除会话失败',
      });
    }
  },
}));

export type { StreamEvent };
