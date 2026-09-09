import { Module } from '@nestjs/common';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeController } from './verification-code.controller';
import { RedisModule } from '../redis/redis.module'

@Module({
  imports: [RedisModule],
  controllers: [VerificationCodeController],
  providers: [VerificationCodeService],
  exports: [VerificationCodeService]
})
export class VerificationCodeModule {}
