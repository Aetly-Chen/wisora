export type AgentRole = 'user' | 'ai' | 'tool'; // 消息归属：用户 / 助手 / 工具结果

export interface AgentMessage {
  id: string; // 消息主键；流式阶段先用临时 id，落库后替换
  role: AgentRole; // 气泡类型，决定左右对齐与样式
  content: string; // 正文；工具消息这里是给人看的展示文案
  timestamp: Date; // 本地时间，气泡上显示 HH:mm
  meta?: string; // 附加说明（如模型名、耗时），有值才显示在气泡下方
  /** 思维链（DeepSeek-R1 / QwQ 等推理模型） */
  reasoning?: string;
  /** 工具调用状态，用于渲染"正在调用工具" */
  toolStatus?: 'calling' | 'done' | 'failed';
  /**
   * 工具消息对应的原始工具名（如 create_my_note）。
   *
   * 单独存一份而不是从 content 里解析：content 是给人看的展示文案，
   * 文案一改解析就失效；页面还要靠它查「工具名 → 中文动作」的映射表。
   */
  toolName?: string;
}

/**
 * 后端 SSE 事件协议（与 src/ai/types/stream-event.ts 一一对应）
 *
 * 事件名固定为 message，靠 type 字段区分；
 * `:ping` 是心跳注释行，不属于本协议，解析时跳过。
 */
export type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string } // 流开始：给出会话与消息 id，前端据此建占位气泡
  | { type: 'token'; content: string } // 增量正文，直接追加到当前气泡
  | { type: 'reasoning'; content: string } // 增量思维链，渲染在独立折叠区
  | { type: 'tool_call'; id: string; name: string; args: string } // 模型请求调用工具：args 是原始 JSON 字符串
  | {
      type: 'tool_result';
      id: string;
      name: string;
      ok: boolean; // 工具是否执行成功，失败时气泡标红
      result: string; // 工具返回的文本结果
    }
  | { type: 'error'; code: string; message: string } // 服务端错误，前端展示 message 并结束本轮
  | { type: 'done'; finishReason: string; usage?: Record<string, number> }; // 流结束：带 token 用量，用于落库与展示

export interface AgentSuggestion {
  id: string; // 唯一键，React 列表 key
  label: string; // 卡片上显示的一句话（如「总结我的笔记」）
  prompt: string; // 点击后真正发送给模型的提示词
  iconName:
    | 'FileText'
    | 'HelpCircle'
    | 'BarChart3'
    | 'Lightbulb'
    | 'MessageSquarePlus'; // 图标名；页面按它映射到具体 lucide 组件
}

/**
 * 会话列表项（GET /ai/conversations）
 *
 * 后端直接返回 Prisma 实体，Date 已被 JSON 序列化为 string。
 */
export interface ConversationSummary {
  id: string; // 会话主键
  title: string | null; // 会话标题；null 表示还没生成（首条消息后由后端补）
  model: string | null; // 该会话使用的模型名；null 表示用默认模型
  createdAt: string; // 创建时间，ISO 字符串
  updatedAt: string; // 最后活跃时间，列表按它倒序
}

/**
 * 会话历史消息（GET /ai/conversations/:id/messages）
 *
 * role 保留后端存储的原始字符串，渲染时再映射到前端 AgentRole。
 */
export interface HistoryMessage {
  id: string; // 消息主键
  role: 'system' | 'user' | 'assistant' | 'tool'; // 后端原始角色；渲染时映射成 AgentRole
  content: string; // 正文
  name?: string | null; // 工具消息的工具名（OpenAI 协议里 tool 消息带 name）
  toolCallId?: string | null; // 工具调用 id，用于把 tool 结果和对应的调用配对
  createdAt?: string; // 落库时间，ISO 字符串；早期数据可能没有
}
