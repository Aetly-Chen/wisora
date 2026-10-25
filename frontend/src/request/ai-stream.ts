import request from "./index";
import { getToken } from "./storage";
import type {
  ConversationSummary,
  HistoryMessage,
  StreamEvent,
} from "../types/agent";

/**
 * AI 流式对话接口层
 *
 * 为什么不用项目的 axios 实例，而是单独用 fetch？
 * - SSE 是"长连接、边收边渲染"，axios 基于 XHR，
 *   即使 responseType:'stream' 在浏览器端也拿不到增量数据；
 * - fetch 的 ReadableStream 才能逐块读取。
 *
 * 因此：
 * - 换票 / 会话 CRUD 走 axios（可复用 token 自动刷新）
 * - 开流 走 fetch（必须流式）
 */

const BASE = import.meta.env.VITE_BASE_API ?? "";

export interface StreamChatParams {
  question: string; // 用户这一轮的问题
  conversationId?: string; // 续聊时传；不传表示新会话（后端会建）
  /** 本次使用的模型；不传则由后端回落到默认模型 */
  model?: string;
  /**
   * 本次是否允许 AI 执行写操作（保存/修改/删除笔记等）。
   *
   * 授权随一次性 ticket 一起签发（30 秒过期、取完即焚），
   * 所以它天然只作用于"这一轮"，不会长期生效。
   */
  allowWrite?: boolean;
  signal?: AbortSignal; // 用于中断流式请求（切会话 / 点停止）
  handlers: {
    onStart?: (payload: { conversationId: string; messageId: string }) => void; // 流开始：拿到本轮会话与消息 id
    onToken?: (text: string) => void; // 增量正文，直接追加到气泡
    onReasoning?: (text: string) => void; // 增量思维链，渲染进折叠区
    onToolCall?: (payload: { id: string; name: string; args: string }) => void; // 工具开始调用；args 是原始 JSON 串
    onToolResult?: (payload: {
      id: string; // 工具调用 id，用来和 onToolCall 配对
      name: string; // 工具名
      ok: boolean; // 是否执行成功
      result: string; // 工具返回的文本
    }) => void;
    onError?: (message: string) => void; // 服务端错误；前端展示后就地结束本轮
    onDone?: (payload: {
      finishReason: string; // 结束原因（stop / length / tool_calls 等）
      usage?: Record<string, number>; // token 用量（input/output/total）
    }) => void;
  };
}

/**
 * 1) 用 JWT 换取 30 秒有效的一次性 ticket。
 *
 * axios 层的响应拦截器已把 {code,msg,data} 解包成 data，
 * 所以这里直接拿到 { ticket }。
 */
export async function createChatTicket(
  allowWrite = false,
): Promise<{ ticket: string; allowWrite: boolean }> {
  return request.post<{ ticket: string; allowWrite: boolean }>(
    "/ai/chat/ticket",
    { allowWrite },
    { loading: false, cancelRepeat: false },
  );
}

/** 会话列表 */
export function listConversations() {
  return request.get<ConversationSummary[]>("/ai/conversations", {
    loading: false,
  });
}

/**
 * 可选模型列表。
 *
 * 列表与默认值都由后端环境变量决定，前端不写死任何模型名 ——
 * 换模型厂商时前端零改动。
 */
export function listModels() {
  return request.get<{ current: string; options: string[] }>("/ai/models", {
    loading: false,
  });
}

/** 软删除会话 */
export function deleteConversation(id: string) {
  return request.delete(`/ai/conversations/${id}`, { loading: false });
}

/** 会话历史消息：切换会话时用它回显 */
export function getConversationMessages(id: string) {
  return request.get<{ conversationId: string; messages: HistoryMessage[] }>(
    `/ai/conversations/${id}/messages`,
    { loading: false },
  );
}

/**
 * 2) 用 ticket 打开 SSE 流，逐块解析事件。
 *
 * 注意：
 * - 不要用 EventSource：它不能带 Authorization 头，也不支持自定义中断策略
 * - 心跳 `:ping` 要跳过，否则会被当成坏数据
 */
export async function streamChat(params: StreamChatParams): Promise<void> {
  const {
    question,
    conversationId,
    model,
    allowWrite = false,
    signal,
    handlers,
  } = params;

  let res: Response;
  try {
    const { ticket } = await createChatTicket(allowWrite);

    const qs = new URLSearchParams({ ticket, q: question });
    if (conversationId) qs.set("conversationId", conversationId);
    if (model) qs.set("model", model);

    res = await fetch(`${BASE}/ai/chat/stream?${qs.toString()}`, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        // 带上 token 便于网关/代理层识别（后端校验实际用 ticket）
        Authorization: `Bearer ${getToken() ?? ""}`,
      },
      signal,
    });
  } catch (err) {
    /*
     * fetch 自己 reject 时抛的是 TypeError("Failed to fetch")，是浏览器原文。
     * 它会一路冒到 store 的 error 上、原样显示在错误条里 ——
     * 中文用户看不出发生了什么，所以在这里换成可读说明。
     *
     * 用户主动中断（切会话 / 点停止）抛的是 AbortError，必须原样放行：
     * 调用方靠它区分「中断」和「真失败」。
     */
    if ((err as Error)?.name === "AbortError") throw err;
    throw new Error("连接中断，没能连上服务器。请检查网络后重试", {
      cause: err,
    });
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `建立流式连接失败（HTTP ${res.status}）`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行（\n\n）分隔事件帧
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");

        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;

        const raw = line.slice(5).trim();
        // 心跳注释行，忽略
        if (!raw || raw.startsWith(":")) continue;

        let ev: StreamEvent;
        try {
          ev = JSON.parse(raw) as StreamEvent;
        } catch {
          continue;
        }

        switch (ev.type) {
          case "start":
            handlers.onStart?.({
              conversationId: ev.conversationId,
              messageId: ev.messageId,
            });
            break;
          case "token":
            handlers.onToken?.(ev.content);
            break;
          case "reasoning":
            handlers.onReasoning?.(ev.content);
            break;
          case "tool_call":
            handlers.onToolCall?.({
              id: ev.id,
              name: ev.name,
              args: ev.args,
            });
            break;
          case "tool_result":
            handlers.onToolResult?.({
              id: ev.id,
              name: ev.name,
              ok: ev.ok,
              result: ev.result,
            });
            break;
          case "error":
            handlers.onError?.(ev.message);
            break;
          case "done":
            handlers.onDone?.({
              finishReason: ev.finishReason,
              usage: ev.usage,
            });
            return;
        }
      }
    }
  } finally {
    // 主动中断时把连接关干净，后端会收到断开并中止 LLM
    try {
      await reader.cancel();
    } catch {
      /* 已结束则忽略 */
    }
  }
}
