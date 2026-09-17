import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserService } from './user.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';

@Controller('user')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  /**
   * 当前登录用户的资料。
   *
   * userId 一律取自令牌（@CurrentUser），不接受客户端传入 ——
   * 否则任何人都能查别人的资料。
   */
  @Get('profile')
  getProfile(@CurrentUser() userId: string) {
    return this.userService.getProfile(userId);
  }
}
