import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  USER_SHAPE,
  displayNameOf,
  maskEmail,
  toFriend,
} from './chat.mapper';
import type { FriendDto, Presence } from './types/chat-events';

/**
 * 在线状态的 Redis key。
 *
 * 导出给网关用 —— 写入方（gateway）与读取方（friends.service）必须是同一个
 * 约定，把字符串散在两处早晚会写错一个字母，而那种 bug 表现为
 * 「在线状态永远显示离线」，很难查。
 */
export const onlineKey = (userId: string) => `chat:online:${userId}`;

/** 搜索返回条数上限 */
const SEARCH_LIMIT = 20;

type UserRow = {
  id: string;
  email: string;
  nickname: string | null;
  handle: string | null;
  bio: string | null;
};

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /* ------------------------------ 在线状态 ------------------------------ */

  /**
   * 在线状态来自 Redis，由网关在连接时写入、断开时删除。
   *
   * 网关还没接上（或用户纯 REST 访问）时永远返回 offline ——
   * 前端离线不画任何标记，所以不会显示异常。
   */
  private async presenceOf(userId: string): Promise<Presence> {
    const online = await this.redis.withTimeout(
      () => this.redis.getClient().exists(onlineKey(userId)),
      0,
    );
    return online === 1 ? 'online' : 'offline';
  }

  private async presenceOfMany(ids: string[]): Promise<Map<string, Presence>> {
    const map = new Map<string, Presence>();
    if (ids.length === 0) return map;

    // 一次 pipeline 拿完：列表页动辄几十个好友，逐个 await 就是几十次往返
    const results = await this.redis.withTimeout(
      () =>
        this.redis
          .getClient()
          .pipeline(ids.map((id) => ['exists', onlineKey(id)]))
          .exec(),
      null,
    );

    ids.forEach((id, index) => {
      const value = results?.[index]?.[1];
      map.set(id, value === 1 ? 'online' : 'offline');
    });
    return map;
  }

  /* ------------------------------ 好友 ------------------------------ */

  /** 我的好友列表 */
  async list(userId: string): Promise<FriendDto[]> {
    const rows = await this.prisma.chatFriendship.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { alias: true, friend: { select: USER_SHAPE } },
    });
    if (rows.length === 0) return [];

    const presence = await this.presenceOfMany(rows.map((r) => r.friend.id));
    return rows.map((r) =>
      toFriend(r.friend as UserRow, {
        isFriend: true,
        presence: presence.get(r.friend.id) ?? 'offline',
        alias: r.alias,
      }),
    );
  }

  /**
   * 搜索用户（按 handle / 昵称 / 邮箱）。
   *
   * 空关键词返回空数组 —— **不要返回全量用户**，
   * 那等于把用户目录公开出去了。
   */
  async search(userId: string, keyword: string): Promise<FriendDto[]> {
    const q = keyword.trim();
    if (!q) return [];

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        id: { not: userId },
        OR: [
          { handle: { contains: q, mode: 'insensitive' } },
          { nickname: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: SEARCH_LIMIT,
      orderBy: { createdAt: 'desc' },
      select: USER_SHAPE,
    });
    if (users.length === 0) return [];

    const ids = users.map((u) => u.id);
    const [friendRows, presence] = await Promise.all([
      this.prisma.chatFriendship.findMany({
        where: { userId, friendId: { in: ids } },
        select: { friendId: true },
      }),
      this.presenceOfMany(ids),
    ]);
    const friendIds = new Set(friendRows.map((r) => r.friendId));

    return users.map((u) =>
      toFriend(u as UserRow, {
        isFriend: friendIds.has(u.id),
        presence: presence.get(u.id) ?? 'offline',
      }),
    );
  }

  /**
   * 加好友。
   *
   * **双向写两条**（A→B 与 B→A）：单向的话，A 加了 B 之后 B 的列表里
   * 没有 A，B 收到消息时找不到会话入口。表结构仍是「每人一行」，
   * 只是加好友这个动作写两行 —— 主流 IM 都是这个做法。
   * 想改成单向申请制，去掉第二条 upsert 即可。
   *
   * 幂等：已加过返回既有关系，**不报 409**。
   * 前端「添加」按钮点两次很常见（网络慢、用户不确定点中没有），
   * 报错只会让人以为失败了。
   */
  async add(userId: string, friendId: string): Promise<FriendDto> {
    if (!friendId) throw new BadRequestException('缺少 userId');
    if (friendId === userId) {
      throw new BadRequestException('不能添加自己为好友');
    }

    const target = await this.prisma.user.findFirst({
      where: { id: friendId, deletedAt: null },
      select: USER_SHAPE,
    });
    if (!target) throw new NotFoundException('用户不存在');

    await this.prisma.$transaction([
      this.prisma.chatFriendship.upsert({
        where: { userId_friendId: { userId, friendId } },
        create: { userId, friendId },
        update: {},
      }),
      this.prisma.chatFriendship.upsert({
        where: { userId_friendId: { userId: friendId, friendId: userId } },
        create: { userId: friendId, friendId: userId },
        update: {},
      }),
    ]);

    return toFriend(target as UserRow, {
      isFriend: true,
      presence: await this.presenceOf(friendId),
    });
  }

  /** 删好友：两个方向一起删，否则对方列表里还留着我 */
  async remove(userId: string, friendId: string) {
    await this.prisma.chatFriendship.deleteMany({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });
    return { deleted: true };
  }

  /**
   * 断言两人是好友。
   *
   * 群聊建群、分享笔记、建单聊都要过这一关 ——
   * 不校验就等于拿到了「给任意 userId 发消息」的通道。
   */
  async assertFriends(userId: string, friendIds: string[]): Promise<void> {
    const ids = [...new Set(friendIds.filter((id) => id && id !== userId))];
    if (ids.length === 0) return;

    const count = await this.prisma.chatFriendship.count({
      where: { userId, friendId: { in: ids } },
    });
    if (count !== ids.length) {
      throw new BadRequestException('只能与好友互动，部分成员不在你的好友列表中');
    }
  }

  /** 给网关推事件时显示用的名字 */
  async nameOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, nickname: true },
    });
    return user ? displayNameOf(user) : '某位用户';
  }

  /** 供其它处复用（避免各自再写一份脱敏逻辑） */
  static maskEmail = maskEmail;
}
