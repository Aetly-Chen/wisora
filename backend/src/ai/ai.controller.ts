import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  Sse,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import { Request } from 'express';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { StreamEvent } from './types/stream-event';
import { AiService } from './ai.service';
import { SkipResponse } from '../common/decorators/skip-response.decorator';
import {
  StreamTicketGuard,
  type AiStreamRequest,
  type TicketPayload,
} from './guards/stream-ticket.guard';
import { ConversationRepository } from './memory/conversation.repository';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { createUserScopedTools, type ToolWithPolicy } from './tools';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotesService } from '../notes/notes.service';
import { NoteSearchService } from '../rag/note-search.service';
import {
  availableModelNames,
  ChatModelFactory,
  defaultModelName,
} from './llm/llm.provider';

/** ticket 有效期（秒）：换票后须在此时长内打开 SSE 流 */
const TICKET_TTL_SECONDS = 30;

/**
 * 引用上下文长度上限（字符）。
 *
 * 为什么不设更大：它会被整段塞进 HumanMessage，超过这个量级既烧 token
 * 又超出「选中一段问问」的实际需要（`read_my_note` 的截断是 4000，对齐）。
 * 超限走 400，不静默截断。
 */
const CONTEXT_MAX_CHARS = 6000;

@Injectable()
@Controller('ai')
export class AiController {
  private readonly logger = new Logger(AiController.name);

  constructor(
    private readonly aiService: AiService,
    private readonly jwtService: JwtService,
    private readonly redis: RedisService,
    private readonly conversations: ConversationRepository,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
    private readonly models: ChatModelFactory,
     private readonly notes: NotesService,
    private readonly search: NoteSearchService,  

  ) {}

  /** 从 Authorization: Bearer xxx 中解析 userId */
  private async getUserId(req: Request): Promise<string> {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      throw new UnauthorizedException('缺少访问令牌');
    }
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(
        auth.slice('Bearer '.length),
        { secret: process.env.JWT_ACCESS_SECRET },
      );
      return payload.sub;
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
  }

  /**
   * 可选模型列表 + 当前默认模型。
   *
   * 前端用它渲染模型切换器。列表来自环境变量 CHAT_MODEL_OPTIONS，
   * 默认模型来自 CHAT_MODEL_NAME —— 两者都不写死在前端，
   * 换模型厂商时前端不用改代码。
   */
  @Get('models')
  async listModels(@Req() req: Request) {
    await this.getUserId(req);
    return {
      current: defaultModelName(),
      options: availableModelNames(),
    };
  }

  /**
   * 1) 换票 + 暂存上下文：`POST /ai/chat/prepare`
   *
   * 为什么把「引用上下文」（笔记里选中的那段）放在这里、而不是拼进 query：
   *
   * - SSE 走 GET，`q` 在 URL 里。中文经 encodeURIComponent 是 9 字节/字，
   *   撞 Node 的 16KB 请求头上限 —— **实测 1800 汉字能进、1850 汉字直接 431**。
   *   而「选中一整节问 AI」轻易超过这个长度。
   * - `question` 还要被拿去落库和当会话标题（见 chatStream），
   *   把整段正文塞进去会污染历史与标题。
   *
   * 所以：短问题仍走 `q`，长上下文存 Redis（与 ticket 同期 30s、绑 userId、
   * 取用即删），流接口只带一个 `ctxId`。
   */
  @Post('chat/prepare')
  async prepare(
    @Req() req: Request,
    @Body() body?: { allowWrite?: boolean; context?: string },
  ) {
    const userId = await this.getUserId(req);
    return this.stage(userId, body?.allowWrite === true, body?.context);
  }

  /**
   * 旧入口：只换票。
   *
   * 保留是因为它没有 `context`，语义与 prepare 完全一样；
   * 前端已经改用 prepare，这里只是不让旧客户端 404。
   */
  @Post('chat/ticket')
  async createTicket(
    @Req() req: Request,
    @Body() body?: { allowWrite?: boolean },
  ) {
    const userId = await this.getUserId(req);
    return this.stage(userId, body?.allowWrite === true);
  }

  /** 换票与上下文暂存的唯一实现（两条路由共用，别写成两份） */
  private async stage(userId: string, allowWrite: boolean, context?: string) {
    // 顺带限流：防止刷票
    const limit = await this.rateLimit.check(userId);
    if (!limit.allowed) {
      throw new HttpException(
        `请求过于频繁，请 ${limit.resetSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const text = typeof context === 'string' ? context.trim() : '';
    if (text.length > CONTEXT_MAX_CHARS) {
      // 显式拒绝，而不是悄悄截断 —— 截断会让模型以为看到的是全部
      throw new BadRequestException(
        `引用上下文过长（上限 ${CONTEXT_MAX_CHARS} 字，当前 ${text.length} 字）`,
      );
    }

    const ticket = randomUUID();
    const ctxId = text ? randomUUID() : undefined;
    // 两者都存 JSON：除 userId 外还携带本次会话的写操作授权 / 上下文正文
    const payload: TicketPayload = { userId, allowWrite };

    /**
     * 写票据要限时：Redis 断连时 `setex` 会卡在重连队列里（实测约 8 秒）
     * 然后抛错变成 500 —— 用户看到「转半天圈，然后服务器错误」。
     * 超过 300ms 直接按不可用处理，给一句能看懂的话。
     */
    const staged = await this.redis.withTimeout(async () => {
      const client = this.redis.getClient();
      if (ctxId) {
        await client.setex(
          `ai:ctx:${ctxId}`,
          TICKET_TTL_SECONDS,
          JSON.stringify({ userId, context: text }),
        );
      }
      await client.setex(
        `ai:ticket:${ticket}`,
        TICKET_TTL_SECONDS,
        JSON.stringify(payload),
      );
      return true;
    }, false);

    if (!staged) {
      throw new ServiceUnavailableException(
        'AI 服务暂不可用（缓存未连接），请稍后再试',
      );
    }
    return { ticket, allowWrite, ctxId };
  }

  /**
   * 取出并消费上下文（一次性）。
   *
   * `ctxId` 和 `ticket` 一样来自 URL，所以**必须校验它属于当前 userId**，
   * 否则拿到别人的 ctxId 就能把别人的笔记内容读进自己的对话（IDOR）。
   */
  private async takeContext(
    userId: string,
    ctxId?: string,
  ): Promise<string | undefined> {
    if (!ctxId) return undefined;

    const key = `ai:ctx:${ctxId}`;
    const raw = await this.redis.withTimeout<string | null | undefined>(
      () => this.redis.getClient().get(key),
      undefined,
    );
    if (raw === undefined) {
      throw new ServiceUnavailableException('AI 服务暂不可用（缓存未连接），请稍后再试');
    }
    if (!raw) return undefined; // 过期/已用过：按"没有上下文"处理，不报错

    // 取用即删：同一次引用不能被重放
    void this.redis.withTimeout(() => this.redis.getClient().del(key), 0);

    try {
      const parsed = JSON.parse(raw) as { userId?: string; context?: string };
      if (parsed.userId !== userId) {
        // 别人的上下文：当作不存在，且不透露原因
        this.logger.warn(`ctxId 归属不匹配，已忽略 userId=${userId}`);
        return undefined;
      }
      return parsed.context;
    } catch {
      return undefined;
    }
  }

  /** 2) 再开流：GET /ai/chat/stream?ticket=xxx&q=...&conversationId=...
   *  必须用 @Sse（而非 @Get）：@Get 会让 Nest 把 Observable 当普通响应，
   *  只取最后一个值发 JSON，流式数据会全部丢失。 */
  @Sse('chat/stream')
  @SkipResponse()
  @UseGuards(StreamTicketGuard)
  async stream(
    @Req() req: AiStreamRequest,
    @Query('q') question: string,
    @Query('conversationId') conversationId?: string,
    @Query('model') model?: string,
    @Query('ctxId') ctxId?: string,
  ) {
    if (!question) {
      throw new HttpException('缺少参数 q', 400);
    }

    const userId = req.userId as string;
    const allowWrite = req.allowWrite === true;

    // 按 userId 限流（10 次/分钟）
    const limit = await this.rateLimit.check(userId);
    if (!limit.allowed) {
      throw new HttpException(
        `请求过于频繁，请 ${limit.resetSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    /**
     * 归属校验（IDOR 防护）：
     * conversationId 来自 query，本接口只带一次性 ticket、不带 JWT，
     * 若不校验，任何登录用户都能传他人的会话 ID——
     * 既能把对方历史读进 LLM 上下文，也能往对方会话里写消息。
     */
    if (conversationId) {
      await this.conversations.assertOwned(userId, conversationId);
    }

    const history = conversationId
      ? await this.conversations.loadHistory(conversationId)
      : [];

    // 按本次请求创建用户专属工具（带 userId 过滤，防止越权访问他人会话）
    const userTools = createUserScopedTools(this.prisma, userId, this.notes, this.search);

    // 白名单校验：不在 CHAT_MODEL_OPTIONS 里的名字会被回落到默认模型
    const resolvedModel = this.models.resolve(model);

    /*
     * 引用上下文（笔记里选中的那段）：只喂模型、不落库。
     * 取用即删，且校验归属（见 takeContext）。
     */
    const context = await this.takeContext(userId, ctxId);

    // signal 透传进 Agent Loop：客户端断开时可中断 LLM 请求
    return this.aiService.toSse((signal) =>
      this.chatStream({
        userId,
        question,
        conversationId,
        history,
        signal,
        allowWrite,
        userTools,
        model: resolvedModel,
        context,
      }),
    );
  }

  /** 会话列表 */
  @Get('conversations')
  async listConversations(@Req() req: Request) {
    const userId = await this.getUserId(req);
    return this.conversations.listConversations(userId);
  }

  /** 软删除会话 */
  @Delete('conversations/:id')
  async deleteConversation(@Req() req: Request, @Param('id') id: string) {
    const userId = await this.getUserId(req);
    await this.conversations.softDeleteConversation(userId, id);
    return { deleted: true };
  }

  /** 会话历史消息：前端切换会话时用它回显 */
  @Get('conversations/:id/messages')
  async listMessages(@Req() req: Request, @Param('id') id: string) {
    const userId = await this.getUserId(req);

    // 先校验归属再取历史，避免读到别人的会话
    await this.conversations.assertOwned(userId, id);

    /*
     * 与 SSE 开流用的 loadHistory **刻意分开**：
     * 那个是给 LLM 的上下文窗口（最近 20 条 + Redis 热缓存），
     * 这个是给界面回看的完整历史。复用会让界面也只看到 20 条，
     * 且缓存过期后只剩最后一轮（详见 listAllMessages 的注释）。
     */
    const messages = await this.conversations.listAllMessages(id);
    return { conversationId: id, messages };
  }

  /** 包装 Agent Loop：补 start 事件 + 落库用户消息与最终回复 */
  private async *chatStream(params: {
    userId: string;
    question: string;
    conversationId?: string;
    history: Array<{ role: string; content: string }>;
    signal?: AbortSignal;
    allowWrite?: boolean;
    userTools?: ToolWithPolicy[];
    /** 本次使用的模型（已过白名单校验） */
    model: string;
    /** 引用上下文：只喂模型，不落库、不当会话标题 */
    context?: string;
  }): AsyncGenerator<StreamEvent> {
    const { userId, question, conversationId, model, context } = params;

    // 无会话则新建，标题取问题前 30 字
    const conv = conversationId
      ? { id: conversationId }
      : await this.conversations.createConversation(
          userId,
          question.slice(0, 30),
          model,
        );

    // 已有会话：模型可能与上次不同，同步到库里，方便会话列表如实展示
    if (conversationId) {
      void this.conversations.updateModelIfChanged(conv.id, model);
    }

    // 用户消息落库
    const userMessage = await this.conversations.appendMessage(conv.id, {
      role: 'user',
      content: question,
    });

    yield { type: 'start', conversationId: conv.id, messageId: userMessage.id };

    let fullText = '';
    let persisted = false;

    // 最终回复落库（幂等：done 时先落库，异常路径由 finally 兜底）
    /*
     * usage 只从 `done` 事件来 —— 那是这一轮真正累积完的 token 用量。
     * 异常路径（finally 兜底）拿不到就按「没有用量」存，
     * 不编一个假数字进去。
     */
    const persistAssistant = async (usage?: Record<string, number>) => {
      if (persisted) return;
      persisted = true;
      await this.conversations
        .appendMessage(conv.id, { role: 'assistant', content: fullText, usage })
        .catch((err) => {
          this.logger.warn(`persist assistant message failed: ${err}`);
        });
    };

    // 只取 user / assistant 轮次做上下文（tool 轮次依赖 tool_calls 配对，跳过）
    const history = params.history
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
      .map((m) =>
        m.role === 'user'
          ? new HumanMessage(m.content)
          : new AIMessage(m.content),
      );

    try {
      for await (const ev of this.aiService.runAgent({
        question,
        history,
        signal: params.signal,
        allowWrite: params.allowWrite,
        extraTools: params.userTools,
        model,
        // 引用上下文只喂模型；落库与标题用的仍是干净的 question
        context,
      })) {
        if (ev.type === 'token') fullText += ev.content;

        // 审计留痕：把工具调用与结果落库，事后可追溯 AI 做过什么
        if (ev.type === 'tool_call') {
          void this.conversations
            .appendMessage(conv.id, {
              role: 'tool',
              content: `${ev.name} ${ev.args}`,
              name: ev.name,
              toolCallId: ev.id,
            })
            .catch((err) =>
              this.logger.warn(`persist tool_call failed: ${err}`),
            );
        }
        if (ev.type === 'tool_result') {
          void this.conversations
            .appendMessage(conv.id, {
              role: 'tool',
              content: ev.result,
              name: ev.name,
              toolCallId: ev.id,
            })
            .catch((err) =>
              this.logger.warn(`persist tool_result failed: ${err}`),
            );
        }

        // 关键：先落库再发 done。否则客户端收到 done 后立刻发起下一轮，
        // 会读到尚未写入的历史（多轮记忆随机失效）
        if (ev.type === 'done') {
          await persistAssistant(ev.usage);
        }

        yield ev;
      }
    } finally {
      // 中断 / 异常结束时兜底落库，避免丢消息
      await persistAssistant();
    }
  }
}
