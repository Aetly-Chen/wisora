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

@Module({
  imports: [
    AuthModule,
    UserModule,
    RedisModule,
    VerificationCodeModule,
    MailModule,
    AiModule,
    NotesModule,
    ChatModule,
    /*
     * 两个 @Global() 模块也要在根模块挂一次 —— @Global() 只影响
     * 「其它模块不必重复 imports」，模块本身仍需被注册进图里。
     */
    StorageModule,
    RateLimitModule,
    RagModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
