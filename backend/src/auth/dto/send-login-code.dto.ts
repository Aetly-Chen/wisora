import { IsEmail } from 'class-validator';

export class SendLoginCodeDto {
  @IsEmail({}, {
    message: '请输入正确的邮箱地址',
  })
  email: string;
}