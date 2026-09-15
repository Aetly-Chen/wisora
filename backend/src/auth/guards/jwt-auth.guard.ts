import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

/** 守卫放行后挂在请求上的用户信息 */
export interface AuthedRequest extends Request {
  userId?: string;
  userEmail?: string;
}

/**
 * JWT 鉴权守卫（通用）。
 *
 * 从 `Authorization: Bearer <token>` 解析并校验访问令牌，
 * 通过后把 userId / userEmail 挂到 request 上，供 @CurrentUser() 取用。
 *
 * 为什么单独抽出来：原先 ai.controller 里有一份内联实现，
 * 新模块若再抄一份就变成三处重复，密钥来源与错误文案一旦不一致很难排查。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.headers.authorization;

    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少访问令牌');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        email?: string;
      }>(auth.slice('Bearer '.length), {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      req.userId = payload.sub;
      req.userEmail = payload.email;
      return true;
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
  }
}
