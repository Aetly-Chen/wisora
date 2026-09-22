import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * 限流是横切关注点，与 PrismaModule / RedisModule 同风格标 @Global()：
 * ai（对话）与 chat（发消息、上传附件）都要用，
 * 让每个模块都 imports 一遍只是样板代码。
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
