import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CONVERSATION_SHAPE, toConversation } from './chat.mapper';
import { FriendsService } from './friends.service';
import type { ConversationDto } from './types/chat-events';
import type {
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';

/** 单聊去重键：两个 id 排序后连接，与传入顺序无关 */
function directKeyOf(a: string, b: string): string {
  return [a, b].sort().join(':');
}

/** 列表排序用的活跃时间：优先最后一条消息，其次会话本身 */
function lastActivityAt(c: ConversationDto): number {
  const iso = c.lastMessage?.createdAt ?? c.updatedAt;
  return new Date(iso).getTime();
}

/** 群名称上限。与 CreateConversationDto 的 @MaxLength(60) 对齐 */
const GROUP_TITLE_MAX_LENGTH = 60;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friends: FriendsService,
  ) {}

  /* ------------------------------ 鉴权 ------------------------------ */

  /**
   * 必须是会话成员，否则 404。
   *
   * 用 404 而不是 403：403 会告诉调用方「这个会话存在但你不在里面」，
   * 可以被用来枚举他人会话 id。这与 ai 模块的 assertOwned 是同一策略 ——
   * 「不存在」与「无权访问」返回同一文案。
   */
  async assertMember(userId: string, conversationId: string) {
    const member = await this.prisma.chatConversationMember.findFirst({
      where: { conversationId, userId, leftAt: null },
      select: { id: true, pinned: true, muted: true, unread: true },
    });
    if (!member) throw new NotFoundException('会话不存在或无权访问');
    return member;
  }

  /** 会话内仍在群的成员 id，供网关决定推给谁 */
  async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** 我参与的会话 id，网关连接时用它一次性 join 全部房间 */
  async myConversationIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { userId, leftAt: null },
      select: { conversationId: true },
    });
    return rows.map((r) => r.conversationId);
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 单个会话（带当前用户自己的置顶 / 未读等状态） */
  async getOne(
    userId: string,
    conversationId: string,
  ): Promise<ConversationDto> {
    const member = await this.assertMember(userId, conversationId);
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_SHAPE,
    });
    if (!row) throw new NotFoundException('会话不存在或无权访问');
    return toConversation(row, member);
  }

  /**
   * 我的会话列表。
   *
   * 排序：置顶优先，其次按最后一条消息的时间（没有消息就用会话的 updatedAt）。
   * **由后端排序** —— 前端只在本地做展示性重排。
   */
  async list(userId: string): Promise<ConversationDto[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { userId, leftAt: null },
      select: {
        pinned: true,
        muted: true,
        unread: true,
        conversation: { select: CONVERSATION_SHAPE },
      },
    });

    return rows
      .map((r) => toConversation(r.conversation, r))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
        return lastActivityAt(b) - lastActivityAt(a);
      });
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 按 kind 分流。跨字段校验放在这里（DTO 装饰器表达不了，且全局没有 ValidationPipe） */
  async create(
    userId: string,
    dto: CreateConversationDto,
  ): Promise<ConversationDto> {
    if (dto.kind !== 'direct' && dto.kind !== 'group') {
      throw new BadRequestException('kind 只能是 direct 或 group');
    }

    if (dto.kind === 'direct') {
      if (!dto.friendId) {
        throw new BadRequestException('单聊需要提供 friendId');
      }
      return this.createDirect(userId, dto.friendId);
    }

    if (!dto.memberIds || dto.memberIds.length === 0) {
      throw new BadRequestException('群聊至少要有一位成员');
    }
    if ((dto.title?.length ?? 0) > GROUP_TITLE_MAX_LENGTH) {
      throw new BadRequestException(`群名称最长 ${GROUP_TITLE_MAX_LENGTH} 字`);
    }
    return this.createGroup(userId, dto.title ?? '', dto.memberIds);
  }

  /**
   * 单聊：**必须复用**已有会话。
   *
   * 不复用的话，用户多点几次「发消息」就会和同一个人建出多条单聊，
   * 列表里出现一堆重复。去重靠 directKey 唯一索引，而不是「查一遍再建」——
   * 后者在并发下有窗口，两个人同时点会建出两条。
   */
  async createDirect(
    userId: string,
    friendId: string,
  ): Promise<ConversationDto> {
    if (!friendId) throw new BadRequestException('缺少 friendId');
    if (friendId === userId) {
      throw new BadRequestException('不能和自己创建会话');
    }
    await this.friends.assertFriends(userId, [friendId]);

    const directKey = directKeyOf(userId, friendId);
    const existing = await this.prisma.chatConversation.findUnique({
      where: { directKey },
      select: { id: true },
    });

    if (existing) {
      /*
       * 复用分支要做两件事：
       * 1. upsert 成员行 —— 用户可能此前退过群，leftAt 非空会看不到会话
       * 2. 未读清零 —— 主动点开联系人等同于读了
       */
      await this.prisma.chatConversationMember.upsert({
        where: {
          conversationId_userId: { conversationId: existing.id, userId },
        },
        create: { conversationId: existing.id, userId },
        update: { leftAt: null, unread: 0, lastReadAt: new Date() },
      });
      return this.getOne(userId, existing.id);
    }

    const created = await this.prisma.chatConversation.create({
      data: {
        kind: 'DIRECT',
        directKey,
        members: { create: [{ userId }, { userId: friendId }] },
      },
      select: { id: true },
    });
    return this.getOne(userId, created.id);
  }

  /** 建群。memberIds 不需要包含自己，这里负责加进去 */
  async createGroup(
    userId: string,
    title: string,
    memberIds: string[],
  ): Promise<ConversationDto> {
    // 去重并排除自己 —— 前端可能把自己的 id 也勾上
    const ids = [...new Set(memberIds)].filter((id) => id && id !== userId);
    if (ids.length === 0) {
      throw new BadRequestException('群聊至少要有一位成员');
    }
    if (ids.length > 100) {
      throw new BadRequestException('群成员最多 100 人');
    }
    // 只允许拉好友进群，否则可以把陌生人拖进来给他发消息
    await this.friends.assertFriends(userId, ids);

    const created = await this.prisma.chatConversation.create({
      data: {
        kind: 'GROUP',
        title: title.trim() || '未命名群聊',
        ownerId: userId,
        members: { create: [userId, ...ids].map((id) => ({ userId: id })) },
      },
      select: { id: true },
    });
    return this.getOne(userId, created.id);
  }

  /**
   * 置顶 / 免打扰。
   *
   * **只改当前用户自己那一行** ChatConversationMember。
   * 改会话行的话，一个人置顶会让全群的人都置顶。
   */
  async updateFlags(
    userId: string,
    conversationId: string,
    dto: UpdateConversationDto,
  ): Promise<ConversationDto> {
    await this.assertMember(userId, conversationId);

    const data: { pinned?: boolean; muted?: boolean } = {};
    if (dto.pinned !== undefined) data.pinned = dto.pinned;
    if (dto.muted !== undefined) data.muted = dto.muted;

    if (Object.keys(data).length > 0) {
      await this.prisma.chatConversationMember.update({
        where: { conversationId_userId: { conversationId, userId } },
        data,
      });
    }
    return this.getOne(userId, conversationId);
  }

  /**
   * 标记已读：未读清零 + 把别人发给我的消息置为 READ。
   *
   * 返回成员 id，让调用方（controller）决定是否推事件 ——
   * service 不直接依赖网关，避免 service 与 gateway 互相循环依赖。
   */
  async markRead(userId: string, conversationId: string): Promise<string[]> {
    await this.assertMember(userId, conversationId);

    await this.prisma.$transaction([
      this.prisma.chatConversationMember.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { unread: 0, lastReadAt: new Date() },
      }),
      this.prisma.chatMessage.updateMany({
        where: { conversationId, senderId: { not: userId }, status: 'SENT' },
        data: { status: 'READ' },
      }),
    ]);

    return this.memberIds(conversationId);
  }
}
