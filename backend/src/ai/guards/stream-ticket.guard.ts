import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** ticket 里携带的会话级授权信息 */
export interface TicketPayload {
  userId: string; // 换票时通过 JWT 校验出的用户 id，后续据此校验会话归属
  /** 是否允许 AI 执行写操作工具 */
  allowWrite: boolean;
}

/** 请求被守卫处理后附加的字段 */
export interface AiStreamRequest {
  url: string; // 原始请求地址，ticket 从它的 query 里取
  userId?: string; // 守卫解析 ticket 后写入；未经守卫时是 undefined
  allowWrite?: boolean; // 同上，缺省按 false 处理，写工具会被拦
}

/**
 * SSE 一次性票据鉴权。
 *
 * EventSource 不支持 Authorization 头，因此先通过 POST /ai/chat/ticket
 * 用 JWT 换取 30 秒有效的一次性 ticket，再拿 ticket 打开 SSE 流。
 * ticket 取完即焚，避免 JWT 泄露在 URL 中被重放。
 *
 * ticket 的值现在是一个 JSON（TicketPayload），除了 userId 还携带
 * 本次会话的授权范围（是否允许写操作工具）。
 */
@Injectable()
export class StreamTicketGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AiStreamRequest>();
    const url = new URL(req.url, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    if (!ticket) throw new UnauthorizedException('缺少 ticket');

    /**
     * 读票据限时 300ms。
     *
     * Redis 断连时 `get` 会卡在重连队列里（实测数秒）然后抛错，
     * 守卫里抛错等于整个 SSE 连接 500。用 `undefined` 当「服务不可用」的哨兵，
     * 与「ticket 不存在」（`null`）区分开 —— 这两种情况给用户的提示不一样。
     */
    const raw = await this.redis.withTimeout<
      string | null | undefined
    >(
      () => this.redis.getClient().get(`ai:ticket:${ticket}`),
      undefined,
    );

    if (raw === undefined) {
      throw new UnauthorizedException('ticket 校验服务暂不可用，请重试');
    }
    if (!raw) throw new UnauthorizedException('ticket 无效或已过期');

    // ticket 一次性，取完即焚（失败也不阻塞，票据本身有 30 秒 TTL 兜底）
    await this.redis.withTimeout(
      () => this.redis.getClient().del(`ai:ticket:${ticket}`),
      0,
    );

    // 兼容早期只存 userId 的纯字符串 ticket
    let payload: TicketPayload;
    if (raw.startsWith('{')) {
      payload = JSON.parse(raw) as TicketPayload;
    } else {
      payload = { userId: raw, allowWrite: false };
    }

    req.userId = payload.userId;
    req.allowWrite = payload.allowWrite === true;
    return true;
  }
}
