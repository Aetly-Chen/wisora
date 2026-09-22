import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  toPublicUser,
  USER_PUBLIC_SELECT,
  type PublicUser,
} from '../common/user-shape';

/**
 * 返回给前端的用户资料。
 *
 * 直接复用 common 的 PublicUser，而不是在这里再声明一份 ——
 * 这个接口与登录响应返回的是同一个东西，两份类型必然会漂移。
 */
export type UserProfile = PublicUser;

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 取当前登录用户的资料。
   *
   * 为什么需要这个接口：登录响应里虽然已经带了 user，但页面刷新后
   * 前端只剩本地持久化的旧数据；用令牌里的 userId 回查一次，
   * 才能保证显示的是最新昵称（也顺便兼容本次改动之前登录、
   * 本地仍存着默认值的用户）。
   */
  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: USER_PUBLIC_SELECT,
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return toPublicUser(user);
  }
}
