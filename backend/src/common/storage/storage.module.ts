import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * 附件实体存储。
 *
 * 标 @Global() 与 PrismaModule / RedisModule 保持同一风格：
 * 它是基础设施，多个业务模块（notes / chat）都要用，
 * 让每个模块都 imports 一遍只是样板代码。
 *
 * 从 notes 模块搬到这里，是因为 chat 也要用它 ——
 * 留在 notes 里会让 chat 反向依赖 notes 模块。
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
