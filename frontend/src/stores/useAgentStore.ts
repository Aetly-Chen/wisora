import { create } from "zustand";
import type {
  AgentMessage,
  ConversationSummary,
  HistoryMessage,
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

/**
 * 把落库的消息序列还原成界面消息。
 *
 * ## 工具轮次要按 toolCallId 合并成一张卡片
 *
 * 库里一次工具调用是**两行**（见 backend/src/ai/ai.controller.ts 的 chatStream：
 * `tool_call` 行存「工具名 + 参数」，`tool_result` 行存结果），
 * 而流式过程中界面上只有**一张卡片**（onToolResult 更新的是同一个 id）。
 * 不合并的话，历史里一次调用会显示成两张卡片，
 * 而且第二张会把"结果"当成参数糊在卡片体里 —— 与刚刚流式看过的样子对不上。
 *
 * 合并放在前端而不是改库：那两行本身是合理的审计记录（参数与结果都有用），
 * 且**已经存下来的历史**也只有在前端合并才能正确回显，
 * 否则要配一次数据迁移。
 *
 * ## 不依赖"哪一行先到"
 *
 * 两行是 `void appendMessage` 并发写的，同一毫秒内落库很常见，
 * 排序即便稳定也可能出现结果行排在调用行前面。所以这里**不看顺序**，
 * 而是按内容的形状认身份：调用行的 content 是 `${工具名} ${参数}`，
 * 必定以工具名开头；结果行不会（结果是模型工具返回的自然语言）。
 * 两个部件哪个先到就填哪个，卡片文案始终是「参数 → 结果」。
 *
 * ## 顺序
 *
 * 其余消息保持后端给的顺序（后端按 `createdAt, id` 排序，
 * 在真实写入路径下 id 与写入顺序一致，实测 46/46 相符）；
 * 结果行并进调用行所在的位置，不另起一张，
 * 这样「模型说的话 → 工具卡片 → 模型后面的话」的先后才不会乱。
 */
function mapHistoryMessages(messages: HistoryMessage[]): AgentMessage[] {
  const out: AgentMessage[] = [];
  /** toolCallId → 卡片在 out 里的下标 + 已经拿到的两个部件 */
  const cards = new Map<string, { index: number; args?: string; result?: string }>();

  /** 与流式路径 onToolCall / onToolResult 的文案保持一致 */
  const renderCard = (c: { args?: string; result?: string }) =>
    [c.args ? `参数：${c.args}` : "", c.result ? `结果：${c.result}` : ""]
      .filter(Boolean)
      .join("\n");

  for (const m of messages) {
    if (m.role === "system") continue; // system 提示词不展示

    const timestamp = m.createdAt ? new Date(m.createdAt) : new Date();

    if (m.role === "tool") {
      const callId = m.toolCallId ?? undefined;

      // 认身份：content 以工具名开头的才是"调用"那一行
      const toolName = m.name ?? "";
      const isCall = toolName !== "" && m.content.startsWith(toolName);
      const value = isCall ? m.content.slice(toolName.length).trim() : m.content;

      const existing = callId ? cards.get(callId) : undefined;
      if (existing) {
        // 第二行：补上还缺的那个部件
        if (isCall) existing.args = value;
        else existing.result = value;
        out[existing.index] = {
          ...out[existing.index],
          content: renderCard(existing),
        };
        continue;
      }

      const card: { index: number; args?: string; result?: string } = {
        index: out.length,
        ...(isCall ? { args: value } : { result: value }),
      };
      if (callId) cards.set(callId, card);
      out.push({
        id: m.id,
        role: "tool",
        content: renderCard(card),
        timestamp,
        // 历史里的工具轮次都已经结束了
        toolStatus: "done",
        toolName: m.name ?? undefined,
      });
      continue;
    }

    out.push({
      id: m.id,
      role: m.role === "assistant" ? "ai" : "user",
      content: m.content,
      timestamp,
    });
  }

  return out;
}

interface AgentState {
  messages: AgentMessage[]; // 当前会话的消息列表（含工具气泡与思维链）
  conversationId?: string; // 当前会话 id；新会话在首条消息发出前是 undefined
  isStreaming: boolean; // 是否正在流式接收，用于禁用发送 / 显示「停止」
  error?: string; // 本轮错误文案，展示在消息区顶部

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
  setAllowWrite: (allow: boolean) => void; // 切换写权限；随 ticket 一起签给后端，只作用于下一轮

  send: (question: string) => Promise<void>; // 发一条消息并消费 SSE 流
  stop: () => void; // 中断当前流（abort）；已收到的内容保留
  reset: () => void;
  clearError: () => void; // 关掉错误提示

  loadConversations: () => Promise<void>; // 拉侧边栏会话列表
  loadModels: () => Promise<void>; // 拉可选模型列表；失败则回落到默认模型
  setModel: (model: string) => void; // 切模型，只影响下一轮对话
  openConversation: (id: string) => Promise<void>; // 切到历史会话并加载其消息
  removeConversation: (id: string) => Promise<void>; // 删会话；删的若是当前会话则回到新会话
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

            /*
             * 每轮结束都刷一次侧边栏，不只是新会话那一次。
             * 会话列表按 updatedAt 倒序，刚聊过的那个应该升到最上面 ——
             * 只在新建时刷新的话，列表顺序会一直停在进入页面那一刻。
             */
            void get().loadConversations();
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
      const mapped = mapHistoryMessages(messages);
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
