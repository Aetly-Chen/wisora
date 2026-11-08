import { Global, Module } from '@nestjs/common';
import { RealtimeService } from './realtime.service';

/**
 * 服务端推送出口。
 *
 * 标 @Global() 与 PrismaModule / StorageModule 同风格：笔记、聊天都要推，
 * 每个模块 imports 一遍只是样板代码。
 *
 * ⚠️ 它**不创建** socket server —— server 还是 `chat.gateway` 的，
 * 这里只是让业务模块能拿到那个引用（`ChatGateway.afterInit` 注册进来）。
 */
@Global()
@Module({
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
