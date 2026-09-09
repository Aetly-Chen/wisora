import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { VerificationCodeService } from './verification-code.service';
import { CreateVerificationCodeDto } from './dto/create-verification-code.dto';
import { UpdateVerificationCodeDto } from './dto/update-verification-code.dto';

@Controller('verification-code')
export class VerificationCodeController {
  constructor(private readonly verificationCodeService: VerificationCodeService) {}


}
