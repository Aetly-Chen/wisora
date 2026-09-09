import { PartialType } from '@nestjs/mapped-types';
import { CreateVerificationCodeDto } from './create-verification-code.dto';

export class UpdateVerificationCodeDto extends PartialType(CreateVerificationCodeDto) {}
