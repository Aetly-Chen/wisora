import {
  IsEmail,
  IsString,
  MinLength,
  Length,
  Matches,
} from 'class-validator'

export class RegisterDto {
  // 邮箱
  @IsEmail({}, {
    message: '请输入正确的邮箱地址',
  })
  email: string

  // 密码
  @IsString()
  @MinLength(6, {
    message: '密码长度不能少于6位',
  })
  password: string

  // 确认密码
  @IsString()
  @MinLength(6, {
    message: '确认密码长度不能少于6位',
  })
  confirmPassword: string

  // 昵称
  @IsString()
  @Length(2, 20, {
    message: '昵称长度必须在2-20个字符之间',
  })
  nickname: string

  // 邮箱验证码
  @IsString()
  @Length(6, 6, {
    message: '邮箱验证码必须是6位',
  })
  emailCode: string
}