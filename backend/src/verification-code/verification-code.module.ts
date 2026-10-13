import { Module } from '@nestjs/common';
import { VerificationCodeService } from './verification-code.service';
import { VerificationCodeController } from './verification-code.controller';

@Module({
  controllers: [VerificationCodeController],
  providers: [VerificationCodeService],
  exports: [VerificationCodeService]
})
export class VerificationCodeModule {}
