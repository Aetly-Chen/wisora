import {
  Injectable,
  Logger,
  ConflictException,
  InternalServerErrorException,
  BadRequestException,
  UnauthorizedException,
  NotFoundException,
} from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendRegisterCodeDto } from './dto/send-register-code.dto';
import { LoginByCodeDto } from './dto/login-by-code.dto';
import { SendLoginCodeDto } from './dto/send-login-code.dto';
import { PrismaService } from '../prisma/prisma.service';
import { VerificationCodeService } from '../verification-code/verification-code.service';
import { MailService } from '../mail/mail.service';
import { JwtService } from '@nestjs/jwt';
import { SendForgotPasswordCodeDto } from './dto/send-forgot-password-code.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly verificationCodeService: VerificationCodeService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
  ) {}
  private readonly logger = new Logger(AuthService.name);
  /**
   * 生成 JWT Token
   * @param user 用户信息
   * @returns accessToken 和 refreshToken
   */
  private async generateTokens(user: { id: string; email: string }) {
    const payload = {
      sub: user.id,
      email: user.email,
    };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_ACCESS_SECRET,
        expiresIn: '15m',
      }),

      this.jwtService.signAsync(payload, {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      }),
    ]);

    return {
      accessToken,
      refreshToken,
    };
  }
  async register(dto: RegisterDto) {
    const { email, password, confirmPassword, nickname, emailCode } = dto;

    // 1. 检查两次密码是否一致
    if (password !== confirmPassword) {
      throw new BadRequestException('两次输入的密码不一致');
    }

    // 2. 查询用户是否已经存在
    const existingUser = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (existingUser) {
      throw new ConflictException('邮箱已注册');
    }

    // 3. 验证邮箱验证码
    await this.verificationCodeService.verify('register', email, emailCode);

    // 4. 加密密码
    const hashedPassword = await bcrypt.hash(password, 10);

    // 5. 创建用户
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        nickname,
        emailVerified: true,
      },
    });

    // 6. 不返回密码
    return {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      emailVerified: user.emailVerified,
      createdAt: user.createdAt,
    };
  }

  async login(dto: LoginDto) {
    const { email, password } = dto;

    // 1. 查询用户
    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (!user) {
      throw new BadRequestException('邮箱或密码错误');
    }

    // 2. 验证密码
    const passwordValid = await bcrypt.compare(password, user.password);

    if (!passwordValid) {
      throw new BadRequestException('邮箱或密码错误');
    }

    // 3. 后面这里生成 JWT
    return this.generateTokens({
      id: user.id,
      email: user.email,
    });
  }
  async loginByCode(dto: LoginByCodeDto) {
    const { email, emailCode } = dto;

    // 1. 查询用户
    const user = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (!user) {
      throw new BadRequestException('该邮箱尚未注册');
    }

    // 2. 验证邮箱验证码
    await this.verificationCodeService.verify('login', email, emailCode);

    // 3. 后面生成 JWT
    return this.generateTokens({
      id: user.id,
      email: user.email,
    });
  }
  async forgotPassword(dto: ForgotPasswordDto) {
  const {
    email,
    emailCode,
    newPassword,
    confirmPassword,
  } = dto;

  // 1. 检查两次密码是否一致
  if (newPassword !== confirmPassword) {
    throw new BadRequestException('两次输入的密码不一致');
  }

  // 2. 查询用户
  const user = await this.prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!user) {
    throw new NotFoundException('该邮箱尚未注册');
  }

  // 3. 验证邮箱验证码
  await this.verificationCodeService.verify(
    'forgot-password',
    email,
    emailCode,
  );

  // 4. 加密新密码
  const hashedPassword = await bcrypt.hash(
    newPassword,
    10,
  );

  // 5. 更新密码
  await this.prisma.user.update({
    where: {
      email,
    },
    data: {
      password: hashedPassword,
    },
  });

  return {
    message: '密码重置成功',
  };
}
  /**
   * ========================================
   * 刷新 Token
   * ========================================
   */
  async refresh(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('RefreshToken 不存在');
    }

    try {
      // 1. 验证 RefreshToken
      const payload = await this.jwtService.verifyAsync(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET,
      });

      // 2. 查询用户
      const user = await this.prisma.user.findUnique({
        where: {
          id: payload.sub,
        },
      });

      if (!user) {
        throw new UnauthorizedException('用户不存在');
      }

      // 3. 重新生成双 Token
      return this.generateTokens({ id: user.id, email: user.email });
    } catch {
      throw new UnauthorizedException('RefreshToken 无效或已过期');
    }
  }
  async sendRegisterCode(dto: SendRegisterCodeDto) {
    const { email } = dto;

    // 1. 判断邮箱是否已经注册
    const existingUser = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (existingUser) {
      throw new ConflictException('该邮箱已注册');
    }

    // 2. 生成验证码
    const code = await this.verificationCodeService.generate('register', email);

    // 3. 发送邮件
    await this.mailService.sendRegisterCode(email, code);

    return {
      message: '验证码发送成功',
    };
  }
  async sendLoginCode(dto: SendLoginCodeDto) {
    const { email } = dto;

    // 1. 判断邮箱是否注册
    const existingUser = await this.prisma.user.findUnique({
      where: {
        email,
      },
    });

    if (!existingUser) {
      throw new NotFoundException('该邮箱尚未注册');
    }

    // 2. 生成验证码
    const code = await this.verificationCodeService.generate('login', email);

    // 3. 发送验证码
    await this.mailService.sendRegisterCode(email, code);

    return {
      message: '验证码发送成功',
    };
  }
  async sendForgotPasswordCode(dto: SendForgotPasswordCodeDto) {
  const { email } = dto;

  // 1. 判断邮箱是否注册
  const existingUser = await this.prisma.user.findUnique({
    where: {
      email,
    },
  });

  if (!existingUser) {
    throw new NotFoundException('该邮箱尚未注册');
  }

  // 2. 生成忘记密码验证码
  const code = await this.verificationCodeService.generate(
    'forgot-password',
    email,
  );

  // 3. 发送验证码
  await this.mailService.sendRegisterCode(email, code);

  return {
    message: '验证码发送成功',
  };
}
}
