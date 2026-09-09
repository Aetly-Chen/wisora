export type AgentRole = 'user' | 'ai' | 'tool';

export interface AgentMessage {
  id: string;
  role: AgentRole;
  content: string;
  timestamp: Date;
  meta?: string;
  /** 思维链（DeepSeek-R1 / QwQ 等推理模型） */
  reasoning?: string;
  /** 工具调用状态，用于渲染"正在调用工具" */
  toolStatus?: 'calling' | 'done' | 'failed';
}

/**
 * 后端 SSE 事件协议（与 src/ai/types/stream-event.ts 一一对应）
 *
 * 事件名固定为 message，靠 type 字段区分；
 * `:ping` 是心跳注释行，不属于本协议，解析时跳过。
 */
export type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'token'; content: string }
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

export interface AgentSuggestion {
  id: string;
  label: string;
  prompt: string;
  iconName:
    | 'FileText'
    | 'HelpCircle'
    | 'BarChart3'
    | 'Lightbulb'
    | 'MessageSquarePlus';
}

/**
 * 会话列表项（GET /ai/conversations）
 *
 * 后端直接返回 Prisma 实体，Date 已被 JSON 序列化为 string。
 */
export interface ConversationSummary {
  id: string;
  title: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 会话历史消息（GET /ai/conversations/:id/messages）
 *
 * role 保留后端存储的原始字符串，渲染时再映射到前端 AgentRole。
 */
export interface HistoryMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string | null;
  toolCallId?: string | null;
  createdAt?: string;
}
