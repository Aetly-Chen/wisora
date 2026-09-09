import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
} from 'class-validator';

export class ForgotPasswordDto {
  @IsEmail({}, { message: '请输入正确的邮箱' })
  email: string;

  @IsString()
  @IsNotEmpty({ message: '验证码不能为空' })
  emailCode: string;

  @IsString()
  @MinLength(6, { message: '新密码至少 6 位' })
  newPassword: string;

  @IsString()
  @IsNotEmpty({ message: '确认密码不能为空' })
  confirmPassword: string;
}