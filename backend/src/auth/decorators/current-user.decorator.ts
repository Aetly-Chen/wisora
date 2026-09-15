import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from '../guards/jwt-auth.guard';

/**
 * 取出当前登录用户的 userId。
 *
 * 用法：`@CurrentUser() userId: string`
 * 仅在配合 JwtAuthGuard 使用时有效（守卫负责把 userId 挂到 request）。
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.userId as string;
  },
);
