import request from './index';
import { getToken } from './storage';
import type {
  ConversationSummary,
  HistoryMessage,
  StreamEvent,
} from '../types/agent';

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

const BASE = import.meta.env.VITE_BASE_API ?? '';

export interface StreamChatParams {
  question: string;
  conversationId?: string;
  /** 本次使用的模型；不传则由后端回落到默认模型 */
  model?: string;
  signal?: AbortSignal;
  handlers: {
    onStart?: (payload: { conversationId: string; messageId: string }) => void;
    onToken?: (text: string) => void;
    onReasoning?: (text: string) => void;
    onToolCall?: (payload: { id: string; name: string; args: string }) => void;
    onToolResult?: (payload: {
      id: string;
      name: string;
      ok: boolean;
      result: string;
    }) => void;
    onError?: (message: string) => void;
    onDone?: (payload: {
      finishReason: string;
      usage?: Record<string, number>;
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
    '/ai/chat/ticket',
    { allowWrite },
    { loading: false, cancelRepeat: false },
  );
}

/** 会话列表 */
export function listConversations() {
  return request.get<ConversationSummary[]>('/ai/conversations', {
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
  return request.get<{ current: string; options: string[] }>('/ai/models', {
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
  const { question, conversationId, model, signal, handlers } = params;

  const { ticket } = await createChatTicket();

  const qs = new URLSearchParams({ ticket, q: question });
  if (conversationId) qs.set('conversationId', conversationId);
  if (model) qs.set('model', model);

  const res = await fetch(`${BASE}/ai/chat/stream?${qs.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      // 带上 token 便于网关/代理层识别（后端校验实际用 ticket）
      Authorization: `Bearer ${getToken() ?? ''}`,
    },
    signal,
  });

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(
      text || `建立流式连接失败（HTTP ${res.status}）`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 以空行（\n\n）分隔事件帧
      let idx = buffer.indexOf('\n\n');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf('\n\n');

        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;

        const raw = line.slice(5).trim();
        // 心跳注释行，忽略
        if (!raw || raw.startsWith(':')) continue;

        let ev: StreamEvent;
        try {
          ev = JSON.parse(raw) as StreamEvent;
        } catch {
          continue;
        }

        switch (ev.type) {
          case 'start':
            handlers.onStart?.({
              conversationId: ev.conversationId,
              messageId: ev.messageId,
            });
            break;
          case 'token':
            handlers.onToken?.(ev.content);
            break;
          case 'reasoning':
            handlers.onReasoning?.(ev.content);
            break;
          case 'tool_call':
            handlers.onToolCall?.({
              id: ev.id,
              name: ev.name,
              args: ev.args,
            });
            break;
          case 'tool_result':
            handlers.onToolResult?.({
              id: ev.id,
              name: ev.name,
              ok: ev.ok,
              result: ev.result,
            });
            break;
          case 'error':
            handlers.onError?.(ev.message);
            break;
          case 'done':
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
