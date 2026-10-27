import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** 默认窗口：60 秒 */
const WINDOW_SECONDS = 60;
/** 默认窗口内允许的请求数（沿用 ai 模块原来的阈值） */
const DEFAULT_MAX_REQUESTS = 10;
/** 未指定 scope 时用的命名空间，与搬迁前保持一致，避免计数器被重置 */
const DEFAULT_SCOPE = 'ai';

export interface RateLimitOptions {
  /** 命名空间。同一个人在不同业务下的配额互相独立 */
  scope?: string;
  /** 窗口内允许的请求数 */
  max?: number;
}

export interface RateLimitResult {
  allowed: boolean; // 本次是否放行；false 时调用方应抛 429
  /** 窗口内剩余可用次数 */
  remaining: number;
  /** 距离窗口重置的剩余秒数 */
  resetSeconds: number;
}

/**
 * 按 userId 的固定窗口限流（Redis INCR + 过期时间）。
 *
 * 说明：实现简单、够用；若要更平滑可换令牌桶或 Lua 脚本。
 *
 * 从 ai 模块搬到 common：聊天模块发消息也要限流，而 AiModule 没导出它。
 * 加 scope 参数是为了让两个业务的配额互不干扰 —— 共用一个 key 的话，
 * 用户狂发 AI 消息会把聊天配额一起吃掉。
 *
 * 默认 scope 仍是 'ai'，因此 ai 模块的调用点行为与搬迁前完全一致。
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  private key(userId: string, scope: string) {
    return `${scope}:ratelimit:${userId}`;
  }

  async check(
    userId: string,
    options: RateLimitOptions = {},
  ): Promise<RateLimitResult> {
    const scope = options.scope ?? DEFAULT_SCOPE;
    const max = options.max ?? DEFAULT_MAX_REQUESTS;

    const client = this.redis.getClient();
    const key = this.key(userId, scope);

    /**
     * 三次串行的 Redis 调用打成一个整体，套 300ms 上限。
     *
     * 不套的话：Redis 断连期间 `incr` 等命令会先进离线队列、按 retryStrategy
     * 反复重连才 reject —— 实测 `POST /chat/attachments` **7.5~9 秒后返回 500**，
     * 用户看到的是「卡了很久然后失败」。
     */
    const used = await this.redis.withTimeout(
      async () => {
        const count = await client.incr(key);
        // 首次命中时设置过期时间，避免 key 永久留存
        if (count === 1) {
          await client.expire(key, WINDOW_SECONDS);
        }
        const ttl = await client.ttl(key);
        return { count, ttl };
      },
      null,
    );

    /**
     * 限流器不可用 → **fail-open**（放行）。
     *
     * 理由：限流是保护措施，不是业务前提。Redis 挂了就把整个上传/发送功能停掉，
     * 代价远大于「这一小段时间没限流」（与 redis.service 的降级策略一致）。
     */
    if (!used) {
      this.logDegraded(scope);
      return { allowed: true, remaining: max, resetSeconds: WINDOW_SECONDS };
    }

    const { count, ttl } = used;

    const allowed = count <= max;
    if (!allowed) {
      this.logger.warn(
        `user ${userId} 触发限流 [${scope}]：${count}/${max}（${ttl}s 后重置）`,
      );
    }

    return {
      allowed,
      remaining: Math.max(0, max - count),
      resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }

  /** 降级日志 5 秒节流，避免 Redis 挂掉期间每个请求刷一行 */
  private lastDegradedLogAt = 0;

  private logDegraded(scope: string) {
    const now = Date.now();
    if (now - this.lastDegradedLogAt < 5000) return;
    this.lastDegradedLogAt = now;
    this.logger.warn(`限流器不可用（Redis），本次放行 [${scope}]`);
  }
}
