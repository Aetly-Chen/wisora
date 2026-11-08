/**
 * 笔记相关的实时事件（服务端 → 客户端）。
 *
 * 走与聊天同一个通道：socket.io `event`（见 `chat.gateway` 的 EVENT_CHANNEL /
 * `RealtimeService`）。前端把两种事件放在一个 union 里按 `type` 分派。
 *
 * 用途：同一篇笔记在另一个标签页被改、或被 Agent 通过工具改掉时，
 * 正在看这篇的客户端要能立刻知道。
 */
export type NoteServerEvent =
  | { type: 'note.created'; noteId: string; updatedAt: string }
  | { type: 'note.updated'; noteId: string; updatedAt: string }
  | { type: 'note.removed'; noteId: string };
