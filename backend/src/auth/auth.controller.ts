import {
  Controller,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { Post, Body, Get, Req } from '@nestjs/common';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { SendRegisterCodeDto } from './dto/send-register-code.dto';
import { LoginByCodeDto } from './dto/login-by-code.dto';
import { SendLoginCodeDto } from './dto/send-login-code.dto';
import { RefreshDto } from './dto/refresh.dto';
import { SendForgotPasswordCodeDto } from './dto/send-forgot-password-code.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { JwtService } from '@nestjs/jwt';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly jwtService: JwtService,
  ) {}

  @Post('register')
  @HttpCode(HttpStatus.OK)
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }
  @Post('login')
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
  @Post('send-register-code')
  @HttpCode(HttpStatus.OK)
  async sendRegisterCode(@Body() dto: SendRegisterCodeDto) {
    return this.authService.sendRegisterCode(dto);
  }
  @Post('send-login-code')
  sendLoginCode(@Body() dto: SendLoginCodeDto) {
    return this.authService.sendLoginCode(dto);
  }

  @Post('login-code')
  loginByCode(@Body() dto: LoginByCodeDto) {
    return this.authService.loginByCode(dto);
  }
  /**
   * 刷新 AccessToken
   */
  @Post('refresh')
  async refresh(@Body() dto: RefreshDto) {
    return this.authService.refresh(dto.refreshToken);
  }
  @Get('test-token')
  @HttpCode(HttpStatus.OK)
  async testToken(@Req() req: Request) {
    const auth = req.headers['authorization'] as string;

    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('没有 Token');
    }

    try {
      const token = auth.substring(7);

      const payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });

      return {
        message: 'Token 有效',
        userId: payload.sub,
      };
    } catch {
      throw new UnauthorizedException('Token 无效或已过期');
    }
  }
  @Post('send-forgot-password-code')
async sendForgotPasswordCode(
  @Body() dto: SendForgotPasswordCodeDto,
) {
  return this.authService.sendForgotPasswordCode(dto);
}

@Post('forgot-password')
async forgotPassword(
  @Body() dto: ForgotPasswordDto,
) {
  return this.authService.forgotPassword(dto);
}
}
