import { IsEmail, IsString, Length } from 'class-validator';

export class LoginByCodeDto {
  @IsEmail({}, {
    message: '请输入正确的邮箱地址',
  })
  email: string;

  @IsString()
  @Length(6, 6, {
    message: '邮箱验证码必须是6位',
  })
  emailCode: string;
}