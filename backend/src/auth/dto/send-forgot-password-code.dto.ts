import { IsEmail } from 'class-validator';

export class SendForgotPasswordCodeDto {
  @IsEmail({}, { message: '请输入正确的邮箱' })
  email: string;
}