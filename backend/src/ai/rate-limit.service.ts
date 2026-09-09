import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

/** 限流窗口：60 秒 */
const WINDOW_SECONDS = 60;
/** 窗口内允许的请求数 */
const MAX_REQUESTS = 10;

export interface RateLimitResult {
  allowed: boolean;
  /** 窗口内剩余可用次数 */
  remaining: number;
  /** 距离窗口重置的剩余秒数 */
  resetSeconds: number;
}

/**
 * 按 userId 的滑动窗口限流（Redis INCR + 过期时间）。
 *
 * 说明：这是"固定窗口计数"，实现简单、够用；
 * 若要更平滑可换令牌桶或 Lua 脚本。
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  private key(userId: string) {
    return `ai:ratelimit:${userId}`;
  }

  async check(userId: string): Promise<RateLimitResult> {
    const client = this.redis.getClient();
    const key = this.key(userId);

    const count = await client.incr(key);
    // 首次命中时设置过期时间，避免 key 永久留存
    if (count === 1) {
      await client.expire(key, WINDOW_SECONDS);
    }
    const ttl = await client.ttl(key);

    const allowed = count <= MAX_REQUESTS;
    if (!allowed) {
      this.logger.warn(
        `user ${userId} 触发限流：${count}/${MAX_REQUESTS}（${ttl}s 后重置）`,
      );
    }

    return {
      allowed,
      remaining: Math.max(0, MAX_REQUESTS - count),
      resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }
}
