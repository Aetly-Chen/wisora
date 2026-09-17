import { HttpException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** 单条消息（内存 / 缓存 / 持久化的统一形状） */
export interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: unknown;
  toolCallId?: string;
  name?: string;
  createdAt?: Date;
}

/** 上下文窗口：超出后只取最近 N 条（后续 P4 再做摘要记忆） */
const HISTORY_LIMIT = 20;
/** Redis 热缓存 TTL */
const CACHE_TTL_SECONDS = 60 * 30;

/**
 * 双层记忆：
 * - Redis：会话上下文热缓存（短期记忆，加速多轮对话取历史）
 * - Prisma：会话与消息持久化（长期记忆，支持历史回看）
 */
@Injectable()
export class ConversationRepository {
  private readonly logger = new Logger(ConversationRepository.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private cacheKey(conversationId: string) {
    return `ai:conv:${conversationId}`;
  }

  async createConversation(userId: string, title?: string, model?: string) {
    return this.prisma.conversation.create({
      data: { userId, title: title ?? null, model: model ?? null },
    });
  }

  /**
   * 会话的模型发生变化时同步落库。
   *
   * 用 updateMany + where 条件一次搞定：只有确实不同才写，
   * 避免每轮对话都产生一次无意义的 UPDATE。
   * 失败只记日志 —— 它只影响列表展示，不该拖垮正在进行的流式回答。
   */
  async updateModelIfChanged(
    conversationId: string,
    model: string,
  ): Promise<void> {
    try {
      await this.prisma.conversation.updateMany({
        where: { id: conversationId, NOT: { model } },
        data: { model },
      });
    } catch (err) {
      this.logger.warn(
        `update conversation model failed: ${(err as Error).message}`,
      );
    }
  }

  async listConversations(userId: string) {
    return this.prisma.conversation.findMany({
      where: { userId, deletedAt: null },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /**
   * 校验会话归属，不归属则抛错。
   *
   * 凡是"通过外部传入的 conversationId 读写会话"的入口都必須先过这一关
   * （尤其是 SSE 开流接口，它只带 ticket、不带 JWT，
   *   如果不校验，任何人都能拿别人的 conversationId 读历史、写消息）。
   */
  async assertOwned(
    userId: string,
    conversationId: string,
  ): Promise<void> {
    const owned = await this.prisma.conversation.findFirst({
      where: { id: conversationId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!owned) {
      // 不区分"不存在"和"无权访问"，避免通过错误差异探测他人会话 ID
      throw new HttpException(
        { code: 404, msg: '会话不存在或无权访问' },
        404,
      );
    }
  }

  async appendMessage(
    conversationId: string,
    message: Omit<ChatMessage, 'id'>,
  ): Promise<ChatMessage> {
    const saved = await this.prisma.message.create({
      data: {
        conversationId,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls ?? undefined,
        toolCallId: message.toolCallId ?? undefined,
        name: message.name ?? undefined,
      },
    });

    // 写穿到 Redis 热缓存（缓存不致命，失败只打日志）
    try {
      const key = this.cacheKey(conversationId);
      const raw = await this.redis.getClient().get(key);
      const list: ChatMessage[] = raw ? (JSON.parse(raw) as ChatMessage[]) : [];
      list.push({ ...message, id: saved.id });
      // 只保留最近 HISTORY_LIMIT 条
      const trimmed = list.slice(-HISTORY_LIMIT);
      await this.redis
        .getClient()
        .setex(key, CACHE_TTL_SECONDS, JSON.stringify(trimmed));
    } catch (err) {
      this.logger.warn(`cache write failed: ${(err as Error).message}`);
    }

    return { ...message, id: saved.id };
  }

  /** 取最近 HISTORY_LIMIT 条上下文：优先 Redis，miss 则回源 Prisma 并回填缓存 */
  async loadHistory(conversationId: string): Promise<ChatMessage[]> {
    const key = this.cacheKey(conversationId);

    try {
      const raw = await this.redis.getClient().get(key);
      if (raw) return JSON.parse(raw) as ChatMessage[];
    } catch {
      // Redis 异常时降级直查数据库
    }

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      take: -HISTORY_LIMIT, // 最近的 N 条
    });

    const list: ChatMessage[] = messages.map((m) => ({
      id: m.id,
      role: m.role as ChatMessage['role'],
      content: m.content,
      toolCalls: m.toolCalls ?? undefined,
      toolCallId: m.toolCallId ?? undefined,
      name: m.name ?? undefined,
      createdAt: m.createdAt,
    }));

    try {
      await this.redis
        .getClient()
        .setex(key, CACHE_TTL_SECONDS, JSON.stringify(list));
    } catch {
      // 缓存失败不影响主流程
    }

    return list;
  }

  async softDeleteConversation(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.redis.getClient().del(this.cacheKey(conversationId));
  }
}
