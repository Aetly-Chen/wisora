import { create } from "zustand";
import type {
  AgentMessage,
  ConversationSummary,
  StreamEvent,
} from "../types/agent";
import {
  deleteConversation,
  getConversationMessages,
  listConversations,
  listModels,
  streamChat,
} from "../request/ai-stream";
import { useNotesStore } from "./useNotesStore";

/**
 * 会改动笔记数据的工具。
 *
 * AI 在对话框里改了笔记后，笔记页的列表还是旧的（两个模块各有自己的
 * store，互不知情）。执行成功后主动让笔记页重拉一次，
 * 否则用户切过去会以为"AI 说保存了但没看到"。
 */
const NOTE_WRITE_TOOLS = new Set([
  "create_my_note",
  "write_my_note",
  "update_my_note",
  "delete_my_note",
]);

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
  "你好，我是 Wisora AI。我可以帮你解答问题、分析数据、撰写内容或搜索信息。";

/** 空状态 / 新会话的初始消息 */
function welcomeMessage(): AgentMessage {
  return {
    id: "welcome",
    role: "ai",
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

  /** 当前选中的模型 */
  model: string;
  /** 后端给出的可选模型列表 */
  models: string[];

  /**
   * 是否允许 AI 执行写操作（保存/修改/删除笔记）。
   *
   * 声明为必填而不是可选：它由界面上的开关驱动，始终有值。
   * 写成可选会让 `get().allowWrite` 变成 boolean | undefined，
   * 于是每处使用都得再兜一次底 —— 而漏兜一次就是"授权悄悄失效"。
   *
   * 刻意不做持久化：每次进入页面都从"关闭"开始。
   * 写权限被记住的话，用户下次无意识地说一句"帮我清理一下笔记"
   * 就可能真的删掉东西。
   */
  allowWrite: boolean;
  setAllowWrite: (allow: boolean) => void;

  send: (question: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
  clearError: () => void;

  loadConversations: () => Promise<void>;
  loadModels: () => Promise<void>;
  setModel: (model: string) => void;
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
  model: "",
  models: [],
  allowWrite: false,

  send: async (question: string) => {
    const text = question.trim();
    if (!text || get().isStreaming) return;

    /*
     * 本轮自己的 controller。留一份本地引用用于判断「这一轮还算不算数」：
     * 切会话 / 新建会话 / 点停止 都会 abort 掉 controller，
     * 之后仍在路上的回调不能再往界面写东西，否则会写进别的会话里。
     */
    const myController = new AbortController();
    controller = myController;

    // 本轮之前还没有 conversationId → 服务端会新建会话，
    // 结束后需要刷新侧边栏列表（标题由问题前 30 字生成）
    const isNewConversation = !get().conversationId;

    const userMessage: AgentMessage = {
      id: generateId(),
      role: "user",
      content: text,
      timestamp: new Date(),
    };
    /*
     * 助手占位气泡，后续 token 往这里累加。
     *
     * 用 let 而不是 const：工具调用会把助手输出切成两段（工具执行前的话、
     * 工具执行后的答案），两段必须落在工具卡片的两侧，所以调完工具要换气泡。
     */
    let currentAssistantId = generateId();
    /*
     * 工具调用后置为 true。新气泡**延后到真有内容时才建** ——
     * 模型调完工具就直接收尾的情况不少，那样会留下一个空气泡。
     */
    let needNewAssistant = false;

    set((state) => ({
      messages: [
        // 首次提问时移除欢迎语
        ...(state.messages[0]?.id === "welcome" && state.messages.length === 1
          ? []
          : state.messages),
        userMessage,
        {
          id: currentAssistantId,
          role: "ai",
          content: "",
          timestamp: new Date(),
        },
      ],
      isStreaming: true,
      error: undefined,
    }));

    /**
     * 往「当前」助手气泡追加内容。
     *
     * 工具调用之后当前气泡已经换成新的了，新气泡按需在这里创建 ——
     * 延后到真有内容时才建，避免模型「调完工具就收尾」时留下一个空气泡。
     *
     * 已经 abort 的轮次直接丢弃：此时会话可能已经被切走，
     * 继续写就会把上一轮的内容灌进新会话，甚至凭空多出一个气泡。
     */
    const appendToAssistant = (
      updater: (msg: AgentMessage) => Partial<AgentMessage>,
    ) => {
      if (myController.signal.aborted) return;
      if (needNewAssistant) {
        const id = generateId();
        currentAssistantId = id;
        needNewAssistant = false;
        set((state) => ({
          messages: [
            ...state.messages,
            { id, role: "ai", content: "", timestamp: new Date() },
          ],
        }));
      }
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === currentAssistantId ? { ...m, ...updater(m) } : m,
        ),
      }));
    };

    try {
      await streamChat({
        question: text,
        conversationId: get().conversationId,
        // 带上当前选中的模型；空串表示交给后端用默认模型
        model: get().model || undefined,
        allowWrite: get().allowWrite,  
        signal: controller.signal,
        handlers: {
          onStart: ({ conversationId }) => set({ conversationId }),

          onToken: (chunk) =>
            appendToAssistant((m) => ({ content: m.content + chunk })),

          onReasoning: (chunk) =>
            appendToAssistant((m) => ({
              reasoning: (m.reasoning ?? "") + chunk,
            })),

          onToolCall: ({ id, name, args }) =>
            set((state) => {
              /*
               * 工具调用把助手输出切成两段：工具执行前说的话、工具执行后的答案。
               * 真实先后是「话 → 工具 → 答案」，所以工具卡片必须夹在两段之间。
               *
               * 原先的做法是把工具消息直接 append 到数组末尾。而助手气泡是
               * 发送时就建好的、位置在工具之前，后续 token 又继续灌进同一个气泡，
               * 于是最终呈现成「答案在工具上面」，和真实先后正好相反 ——
               * 看起来像回答先出现、然后才去调工具。
               */
              const current = state.messages.find(
                (m) => m.id === currentAssistantId,
              );
              /*
               * 判空只看 content，不看 reasoning —— reasoning 目前只被
               * 采集、页面并不渲染（见 pages/agent/index.tsx 里没有引用）。
               * 把它算作「有内容」的话，模型先输出思考再调工具时，
               * 工具卡片上方会留下一个什么都看不见的空壳气泡。
               */
              const stillEmpty = !current || !current.content.trim();
              // 模型先调工具、还没开口：删掉那个空占位，别在工具上方留个空气泡
              const base = stillEmpty
                ? state.messages.filter((m) => m.id !== currentAssistantId)
                : state.messages;
              // 后续内容另起一个气泡，落在工具卡片之后
              needNewAssistant = true;
              return {
                messages: [
                  ...base,
                  {
                    id: `tool-${id}`,
                    role: "tool",
                    // 不再把工具名拼进 content：它单独放在 toolName 里，
                    // 由页面查「工具名 → 中文动作」映射后渲染。
                    // 拼进文案的话，改文案就会连带影响显示逻辑。
                    content: args ? `参数：${args}` : "",
                    timestamp: new Date(),
                    toolStatus: "calling",
                    toolName: name,
                  },
                ],
              };
            }),

          onToolResult: ({ id, ok, name, result }) => {
            set((state) => ({
              messages: state.messages.map((m) =>
                m.id === `tool-${id}`
                  ? {
                      ...m,
                      content: `${m.content}\n结果：${result}`,
                      toolStatus: ok ? "done" : "failed",
                    }
                  : m,
              ),
            }));

            // AI 改动了笔记数据 → 让笔记页重拉列表，避免切过去看到旧数据。
            // 用 getState() 而非订阅，两个 store 之间不建立响应式依赖。
            if (ok && NOTE_WRITE_TOOLS.has(name)) {
              void useNotesStore.getState().loadNotes();
            }
          },

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
      const aborted = (err as Error)?.name === "AbortError";
      set({
        isStreaming: false,
        error: aborted ? undefined : (err as Error)?.message || "生成失败",
      });
      if (aborted) {
        /*
         * 中断时把已生成的部分保留下来并标注。
         *
         * 这里**不走 appendToAssistant**：那个 helper 会按需新建气泡，
         * 而中断的常见原因恰恰是「切到别的会话 / 点了新聊天」——
         * 那种情况下本次气泡已经不在列表里了，新建就会在新会话里
         * 凭空多出一个只写着「已停止生成」的气泡。
         * 所以这里只改「本来就在列表里的那一个」，找不到就什么都不做。
         */
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === currentAssistantId
              ? m.content
                ? { ...m, meta: "（已停止生成）" }
                : { ...m, content: "（已停止生成）" }
              : m,
          ),
        }));
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

  /**
   * 拉取可选模型。
   *
   * 只在用户还没选过模型时套用后端默认值 —— 否则会因为一次刷新
   * 把用户当前的临时选择覆盖掉。
   */
  loadModels: async () => {
    try {
      const { current, options } = await listModels();
      set((state) => ({
        models: Array.isArray(options) ? options : [],
        model: state.model || current || "",
      }));
    } catch {
      // 拿不到列表不影响对话：留空即走后端默认模型
      set({ models: [] });
    }
  },

  setAllowWrite: (allow) => set({ allowWrite: allow }),
  setModel: (model) => set({ model }),

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

    // 切换会话时把模型切回该会话上次用的那个。
    // 消息接口不返回模型，所以从列表里查（列表项带 model 字段）。
    const summary = get().conversations.find((c) => c.id === id);
    const conversationModel = summary?.model?.trim() || get().model;

    set({
      conversationId: id,
      isStreaming: false,
      error: undefined,
      loadingHistory: true,
      messages: [],
      model: conversationModel,
    });

    try {
      const { messages } = await getConversationMessages(id);

      // system 不展示；其余（user/assistant/tool）按原顺序回显。
      // 用类型谓词过滤，让 TS 把 'system' 从联合类型里排除掉。
      const mapped: AgentMessage[] = messages
        .filter(
          (m): m is typeof m & { role: "user" | "assistant" | "tool" } =>
            m.role !== "system",
        )
        .map((m) => ({
          id: m.id,
          role: m.role === "assistant" ? ("ai" as const) : m.role,
          /*
           * 工具轮次落库时，调用那条的 content 是「工具名 + 参数」。
           * 工具名已经从 m.name 取出来单独渲染了，这里把前缀去掉，
           * 否则历史回显会出现「查看笔记目录 / create_my_notes {...}」的重复。
           */
          content:
            m.role === "tool" && m.name && m.content.startsWith(m.name)
              ? m.content.slice(m.name.length).trim()
              : m.content,
          timestamp: m.createdAt ? new Date(m.createdAt) : new Date(),
          // 历史里的工具轮次都是已完成的
          ...(m.role === "tool"
            ? { toolStatus: "done" as const, toolName: m.name ?? undefined }
            : {}),
        }));

      set({ messages: mapped.length > 0 ? mapped : [welcomeMessage()] });
    } catch (err) {
      set({
        messages: [welcomeMessage()],
        error: (err as Error)?.message || "加载会话失败",
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
        error: (err as Error)?.message || "删除会话失败",
      });
    }
  },
}));

export type { StreamEvent };
