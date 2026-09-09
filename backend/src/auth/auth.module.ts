import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { MailModule } from '../mail/mail.module';
import { JwtModule } from '@nestjs/jwt';
import { VerificationCodeModule } from '../verification-code/verification-code.module';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service'

@Module({
  imports: [PrismaModule, RedisModule, MailModule, VerificationCodeModule,JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService,MailService,PrismaService],
  exports: [AuthService]
})
export class AuthModule {}
