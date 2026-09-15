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

@Module({
  imports: [
    AuthModule,
    UserModule,
    RedisModule,
    VerificationCodeModule,
    MailModule,
    AiModule,
    NotesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
