import io, { type Socket } from 'socket.io-client';
import { getToken } from './storage';
import type { ChatEvent } from '@/types/chat';

const BASE = import.meta.env.VITE_BASE_API ?? '';

/**
 * 笔记侧的实时事件（与服务端 `notes/types/note-events.ts` 对应）。
 *
 * 和聊天事件共用一个通道、一个连接 —— 前端只挂一次 `socket.on('event')`，
 * 按载荷里的 `type` 分派。
 */
export type NoteEvent =
  | { type: 'note.created'; noteId: string; updatedAt: string }
  | { type: 'note.updated'; noteId: string; updatedAt: string }
  | { type: 'note.removed'; noteId: string };

export type RealtimeEvent = ChatEvent | NoteEvent;

/**
 * 订阅服务端推送（聊天 + 笔记共用）。
 *
 * 令牌通过握手载荷（auth）传递，**不放 query string** —— query 会进访问日志
 * 与代理记录。这一点与 ai 模块当初为 SSE 引入一次性 ticket 是同一个理由。
 *
 * `auth` 传函数形式：socket.io 每次重连都会重新调用它，
 * 这样访问令牌过期刷新后，重连拿到的是新令牌而不是握手时的旧值。
 *
 * 事件名固定 `event`，载荷带 `type` 字段 —— 与服务端 `chat.gateway` 的
 * `EVENT_CHANNEL` / `RealtimeService.REALTIME_EVENT` 对应。
 *
 * 返回取消订阅函数，组件卸载时必须调用。
 */
export function subscribeRealtimeEvents(
  handler: (event: RealtimeEvent) => void,
): () => void {
  const socket: Socket = io(`${BASE}/chat`, {
    // 只用 websocket：省掉 polling 升级那一步，实时性更直接
    transports: ['websocket'],
    auth: (cb) => cb({ token: getToken() ?? '' }),
  });

  socket.on('event', (event: RealtimeEvent) => handler(event));

  // 断线不静默：至少让开发者能在控制台看到，否则「消息不来了」无从下手
  socket.on('connect_error', (err) => {
    console.warn('[realtime] 实时连接失败：', err.message);
  });

  return () => {
    socket.off('event');
    socket.disconnect();
  };
}
