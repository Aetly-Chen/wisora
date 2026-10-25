import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';

/** 单条消息（内存 / 缓存 / 持久化的统一形状） */
export interface ChatMessage {
  id: string; // 消息主键，来自 Prisma；内存里新拼的对象也带
  role: 'system' | 'user' | 'assistant' | 'tool'; // 说话方；tool 是工具调用与返回值的回填轮次
  content: string; // 文本正文；tool 轮次里存「工具名 + 参数」或工具返回值
  toolCalls?: unknown; // assistant 轮次请求调用的工具，其它轮次为空
  toolCallId?: string; // 工具调用 id，tool 轮次靠它对上具体某一次调用
  name?: string; // 工具名，仅 tool 轮次有值
  /**
   * token 用量（input / output / total，厂商字段名不完全一致）。
   *
   * 只有 assistant 轮次有。落库是给「刷新页面后还能看到这轮花了多少 token」用的 ——
   * `done` 事件里本来就算好了，但之前只推给前端、没存，一刷新就没了。
   *
   * 落库时若没有值，要写 undefined 而不是 null —— 这列是 Prisma 的 Json?，
   * 写 null 会触发类型错误。
   */
  usage?: unknown;
  createdAt?: Date; // 落库时间；仅从库里读出来时存在，刚构造的消息是 undefined
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
      throw new NotFoundException('会话不存在或无权访问');
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
        // Json 列：undefined 表示「没有这条数据」，写 null 会让 Prisma 报类型错
        usage:
          message.usage === undefined || message.usage === null
            ? undefined
            : (message.usage as object),
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
      usage: m.usage ?? undefined,
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

  /**
   * 界面回看用的**完整**历史。
   *
   * 为什么不能复用 loadHistory：
   * 1. 它优先读 Redis 热缓存，而那份缓存是 `appendMessage` 写穿的，
   *    每条消息都 `slice(-HISTORY_LIMIT)` —— **只有最近 20 条**。
   * 2. 更糟的是缓存过期（TTL 30 分钟）之后，下一条消息会让它从空数组重建：
   *    `appendMessage` 读到 miss 就 `list = []` 再 push 这一条，
   *    于是缓存里只剩最后 1~2 条。界面此时去读，就只看到最后一轮对话，
   *    前面的历史"凭空消失"。
   * 3. 即便缓存 miss 走到 Prisma，`take: -HISTORY_LIMIT` 也只取 20 条。
   *
   * 20 条是给 LLM 上下文窗口的预算，不是给界面看的 —— 两者必须分开。
   *
   * 排序显式给 `createdAt asc` + `id asc`：工具轮次是 `void appendMessage`
   * 并发落库的（同一毫秒内两条很常见），只按 createdAt 排结果会飘，
   * 表现是历史里"结果"卡片跑到"参数"卡片前面。
   */
  async listAllMessages(conversationId: string): Promise<ChatMessage[]> {
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return messages.map((m) => ({
      id: m.id,
      role: m.role as ChatMessage['role'],
      content: m.content,
      toolCalls: m.toolCalls ?? undefined,
      toolCallId: m.toolCallId ?? undefined,
      name: m.name ?? undefined,
      /**
       * ⚠️ 必须带上 `usage`，否则「落库了但界面看不到」：
       * 界面历史走这个方法，而 `loadHistory` 只服务 LLM 上下文。
       */
      usage: m.usage ?? undefined,
      createdAt: m.createdAt,
    }));
  }

  async softDeleteConversation(userId: string, conversationId: string) {
    await this.prisma.conversation.updateMany({
      where: { id: conversationId, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await this.redis.getClient().del(this.cacheKey(conversationId));
  }
}
