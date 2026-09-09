import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** ticket 里携带的会话级授权信息 */
export interface TicketPayload {
  userId: string;
  /** 是否允许 AI 执行写操作工具 */
  allowWrite: boolean;
}

/** 请求被守卫处理后附加的字段 */
export interface AiStreamRequest {
  url: string;
  userId?: string;
  allowWrite?: boolean;
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

    const raw = await this.redis.getClient().get(`ai:ticket:${ticket}`);
    if (!raw) throw new UnauthorizedException('ticket 无效或已过期');

    // ticket 一次性，取完即焚
    await this.redis.getClient().del(`ai:ticket:${ticket}`);

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
