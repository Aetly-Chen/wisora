import { Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { FriendsService } from './friends.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ShareService } from './share.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotesModule } from '../notes/notes.module';

/** 孤儿附件清理间隔：1 小时 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** 超过这个时长的「上传但没发出」附件视为垃圾 */
const ORPHAN_AGE_HOURS = 24;

/**
 * 聊天模块。
 *
 * PrismaModule / RedisModule / StorageModule / RateLimitModule 都是 @Global()，
 * 不需要在这里 imports。
 *
 * 需要 NotesModule 的原因只有一个：分享笔记时要调 NotesService.get()
 * 做归属校验并取标题快照。这是刻意的 —— 直接查 Note 表会让
 * 「笔记不存在或已删除」这类规则出现第二份实现。
 */
@Module({
  imports: [
    // JwtAuthGuard 与 ChatGateway 都要验签（非全局 Guard，逐控制器挂载）
    JwtModule.register({}),
    NotesModule,
  ],
  controllers: [ChatController],
  providers: [
    FriendsService,
    ConversationsService,
    MessagesService,
    ChatAttachmentsService,
    ShareService,
    JwtAuthGuard,
    ChatGateway,
  ],
  // 会话与消息的鉴权方法要给出去了：其它模块（例如以后在 AI 里加
  // 「读我的聊天记录」工具）会需要 assertMember
  exports: [ConversationsService, MessagesService],
})
export class ChatModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ChatModule.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly attachments: ChatAttachmentsService) {}

  /**
   * 清理孤儿附件。
   *
   * 上传与发送是两步（先 POST /chat/attachments 拿 id，再带 id 发消息），
   * 中间放弃就会留下 messageId 为 null 的记录与磁盘文件。
   *
   * 用最朴素的 setInterval，而不是引入 @nestjs/schedule ——
   * 为一个清理任务加一个运行期依赖不划算。
   */
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.attachments
        .cleanupOrphans(ORPHAN_AGE_HOURS)
        .then((count) => {
          if (count > 0) {
            this.logger.log(`已清理 ${count} 个未发送的孤儿附件`);
          }
        })
        .catch((err: Error) => {
          this.logger.warn(`清理孤儿附件失败：${err.message}`);
        });
    }, CLEANUP_INTERVAL_MS);

    // 不因这个定时器阻止进程退出（测试、CLI 场景下很关键）
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
