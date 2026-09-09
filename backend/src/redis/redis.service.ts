import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common'
import Redis from 'ioredis'

@Injectable()
export class RedisService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly redis: Redis

  constructor() {
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      password:
        process.env.REDIS_PASSWORD || undefined,
    })
  }

  async onModuleInit() {
    await this.redis.ping()

    console.log('Redis connected')
  }

  async onModuleDestroy() {
    await this.redis.quit()
  }

  getClient(): Redis {
    return this.redis
  }
}