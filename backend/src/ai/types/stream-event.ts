/**
 * SSE 流式事件协议（统一 JSON 信封）
 *
 * 事件名固定为 `message`，前端靠 `type` 字段区分正文 / 工具调用 / 报错；
 * 另有 `:ping` 注释行作为心跳保活，不属于本协议。
 */
export type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  /** 正文增量 */
  | { type: 'token'; content: string }
  /** 思维链（DeepSeek-R1 / QwQ 等） */
  | { type: 'reasoning'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean;
      result: string;
    }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; finishReason: string; usage?: Record<string, number> };
