import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** 返回给前端的用户资料（不含密码等敏感字段） */
export interface UserProfile {
  id: string;
  email: string;
  nickname: string | null;
  createdAt: Date;
}

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
      select: { id: true, email: true, nickname: true, createdAt: true },
    });
    if (!user) {
      throw new NotFoundException('用户不存在');
    }
    return user;
  }
}
