import { Test, TestingModule } from '@nestjs/testing';
import { VerificationCodeController } from './verification-code.controller';
import { VerificationCodeService } from './verification-code.service';

describe('VerificationCodeController', () => {
  let controller: VerificationCodeController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VerificationCodeController],
      providers: [VerificationCodeService],
    }).compile();

    controller = module.get<VerificationCodeController>(VerificationCodeController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
