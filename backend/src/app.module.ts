import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { RedisModule } from './redis/redis.module';
import { VerificationCodeModule } from './verification-code/verification-code.module';
import { MailModule } from './mail/mail.module';
import { AiModule } from './ai/ai.module';
import { NotesModule } from './notes/notes.module';
import { ChatModule } from './chat/chat.module';
import { StorageModule } from './common/storage/storage.module';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { RagModule } from './rag/rag.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    /*
     * 基础设施模块 —— 五个都是 @Global()，且必须在根模块挂一次：
     * @Global() 只免除「其它模块重复 imports」这一步，模块本身仍要被注册进依赖图。
     *
     * 集中挂在这里而不是散落在业务模块中，是为了消除隐性耦合：改前 PrismaModule
     * 是靠 AuthModule / AiModule / RagModule 顺带带进图的，RedisModule 靠
     * AuthModule / VerificationCodeModule —— 谁被摘掉都会连累别人启动即报
     * Nest can't resolve dependencies。
     */
    PrismaModule,
    RedisModule,
    StorageModule,
    RateLimitModule,
    RagModule,

    // 业务模块：基础设施由上面的全局注册提供，各自不需要再 imports
    AuthModule,
    UserModule,
    VerificationCodeModule,
    MailModule,
    AiModule,
    NotesModule,
    ChatModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
