import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import Redis from 'ioredis'

/**
 * 全局 Redis 客户端。
 *
 * ⚠️ Redis 在本项目里是**可降级依赖**：限流、在线状态、AI 对话热缓存都用到它，
 * 但它的存在与否不该决定「后端能不能活」。这一点之前是踩过的：
 *
 *   Redis 容器一停 → `onModuleInit` 的 `await ping()` 抛错 → Nest 启动失败；
 *   即使是运行中断连，也会因为没人监听 `error` 事件 + 命令队列集中 reject，
 *   冒出一个未捕获异常把**整个 node 进程**带走（`MaxRetriesPerRequestError`）。
 *
 * 所以这里做三件事：接住 `error` 事件（节流）、配置退避重连、启动探测失败只告警。
 */
@Injectable()
export class RedisService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedisService.name)

  private readonly redis: Redis

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password:
        process.env.REDIS_PASSWORD || undefined,

      /**
       * 断线重连：指数退避，封顶 3 秒。
       *
       * 默认策略是「立即重试、无限次」，Redis 不在时会在几十毫秒内
       * 刷出成百上千条 ECONNREFUSED。封顶之后既保留自愈能力，又不刷屏。
       */
      retryStrategy: (times) => Math.min(times * 200, 3000),

      /**
       * 单条命令的重试上限。
       *
       * 默认 20：Redis 挂着时每条命令要重试 20 轮才 reject，请求全挂在那儿，
       * 最后集中爆出来（就是那次进程退出的直接来源）。降到 2 让调用方**尽快**
       * 拿到失败，由业务决定怎么办，而不是攒着一起炸。
       */
      maxRetriesPerRequest: 2,
    })

    /**
     * ⚠️ 必须自己监听 `error`。
     *
     * ioredis 在没有任何 error 监听时会把错误直接抛到 EventEmitter 上
     * （日志里的 `[ioredis] Unhandled error event`），断连期间每次重连都来一条。
     * 这里做 5 秒节流，避免一条断连把日志淹了。
     */
    let lastLoggedAt = 0
    this.redis.on('error', (err: Error & { code?: string }) => {
      const now = Date.now()
      if (now - lastLoggedAt < 5000) return
      lastLoggedAt = now
      /**
       * 断连时 ioredis 抛的是 `AggregateError`，它的 `message` 是**空串** ——
       * 直接打 `err.message` 会得到一句「Redis 连接异常：」什么线索都没有。
       * 退到 `code`（ECONNREFUSED / ETIMEDOUT）才看得懂。
       */
      this.logger.warn(
        `Redis 连接异常：${err.message || err.code || err.name || 'unknown'}`,
      )
    })

    /**
     * 重连成功要有日志，否则「恢复了吗」只能靠猜。
     * `ready` 在首次连接和每次重连后都会触发。
     */
    this.redis.on('ready', () => {
      this.logger.log('Redis 已连接（ready）')
    })
  }

  async onModuleInit() {
    try {
      await this.redis.ping()
      this.logger.log('Redis connected')
    } catch (err) {
      /**
       * ⚠️ 这里**不能抛**。
       *
       * Redis 晚起几秒就整个后端起不来，代价远大于收益 ——
       * 降级（限流失效、热缓存失效）比「服务完全不可用」好。
       * 连接恢复后 ioredis 会自动重连，无需人工干预。
       */
      this.logger.warn(
        `Redis 暂不可用，以降级模式启动（恢复后会自动重连）：${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  async onModuleDestroy() {
    /**
     * 未连接时 `quit()` 会抛（"Connection is closed"），
     * 退出路径上再抛一个错只会盖住真正的原因，这里直接吞掉。
     */
    try {
      await this.redis.quit()
    } catch {
      this.redis.disconnect()
    }
  }

  getClient(): Redis {
    return this.redis
  }
}
