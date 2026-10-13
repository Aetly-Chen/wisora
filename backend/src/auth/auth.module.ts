import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { MailModule } from '../mail/mail.module';
import { JwtModule } from '@nestjs/jwt';
import { VerificationCodeModule } from '../verification-code/verification-code.module';

@Module({
  imports: [MailModule, VerificationCodeModule,JwtModule.register({})],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService]
})
export class AuthModule {}
