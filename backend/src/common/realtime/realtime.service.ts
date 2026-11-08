import { Injectable, Logger } from '@nestjs/common';
import type { Server } from 'socket.io';

/**
 * 推送通道名。
 *
 * ⚠️ 必须与 `chat.gateway` 的 `EVENT_CHANNEL` 一致：前端只挂了一个
 * `socket.on('event')`，两种事件（聊天 / 笔记）共用一个通道，按载荷里的
 * `type` 分派。
 */
export const REALTIME_EVENT = 'event';

/**
 * 服务端「推给某个用户」的唯一出口。
 *
 * 为什么需要这一层：socket server 归 `chat.gateway` 所有，而**笔记模块也要推送**。
 * 直接让 `NotesModule` imports `ChatModule` 会成环 —— `ChatModule` 已经 imports
 * `NotesModule`（分享笔记时要调 `NotesService.get()` 做归属校验）。
 *
 * 所以反过来：网关在 `afterInit` 里把 server 注册进来，业务模块只依赖这个服务。
 * 它按既定的房间约定推给 `userId` 房间（每个连接握手成功后都会 join 自己的
 * userId，见 `chat.gateway`）。没连过 socket 的用户自然收不到，也不会报错。
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private server: Server | null = null;

  /** 由 `ChatGateway.afterInit` 调用一次 */
  attach(server: Server): void {
    this.server = server;
  }

  /**
   * 推给某个用户的所有在线端。
   *
   * 失败只记日志：推送是「锦上添花」，不能因为它让写接口 500 ——
   * 库里已经写成功了，客户端下次 focus 也会自己对齐。
   */
  emitToUser(userId: string, eventName: string, payload: unknown): void {
    if (!this.server) return;
    try {
      this.server.to(userId).emit(eventName, payload);
    } catch (err) {
      this.logger.warn(
        `推送失败 userId=${userId}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
