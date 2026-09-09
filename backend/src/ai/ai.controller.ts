import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Injectable,
  Logger,
  Param,
  Post,
  Query,
  Req,
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
import { SkipResponse } from './decorators/skip-response.decorator';
import {
  StreamTicketGuard,
  type AiStreamRequest,
  type TicketPayload,
} from './guards/stream-ticket.guard';
import { ConversationRepository } from './memory/conversation.repository';
import { RateLimitService } from './rate-limit.service';
import { createUserScopedTools, type ToolWithPolicy } from './tools';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';

/** ticket 有效期（秒）：换票后须在此时长内打开 SSE 流 */
const TICKET_TTL_SECONDS = 30;

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

  /** 1) 先换票：用 JWT 换取 30 秒有效的一次性 ticket */
  @Post('chat/ticket')
  async createTicket(
    @Req() req: Request,
    @Body() body?: { allowWrite?: boolean },
  ) {
    const userId = await this.getUserId(req);

    // 顺带限流：防止刷票
    const limit = await this.rateLimit.check(userId);
    if (!limit.allowed) {
      throw new HttpException(
        { code: 429, msg: `请求过于频繁，请 ${limit.resetSeconds} 秒后再试` },
        429,
      );
    }

    const ticket = randomUUID();
    // ticket 存 JSON：除 userId 外还携带本次会话的写操作授权
    const payload: TicketPayload = {
      userId,
      allowWrite: body?.allowWrite === true,
    };
    await this.redis
      .getClient()
      .setex(
        `ai:ticket:${ticket}`,
        TICKET_TTL_SECONDS,
        JSON.stringify(payload),
      );
    return { ticket, allowWrite: payload.allowWrite };
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
        { code: 429, msg: `请求过于频繁，请 ${limit.resetSeconds} 秒后再试` },
        429,
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
    const userTools = createUserScopedTools(this.prisma, userId);

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

    const messages = await this.conversations.loadHistory(id);
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
  }): AsyncGenerator<StreamEvent> {
    const { userId, question, conversationId } = params;

    // 无会话则新建，标题取问题前 30 字
    const conv = conversationId
      ? { id: conversationId }
      : await this.conversations.createConversation(
          userId,
          question.slice(0, 30),
          process.env.CHAT_MODEL_NAME,
        );

    // 用户消息落库
    const userMessage = await this.conversations.appendMessage(conv.id, {
      role: 'user',
      content: question,
    });

    yield { type: 'start', conversationId: conv.id, messageId: userMessage.id };

    let fullText = '';
    let persisted = false;

    // 最终回复落库（幂等：done 时先落库，异常路径由 finally 兜底）
    const persistAssistant = async () => {
      if (persisted) return;
      persisted = true;
      await this.conversations
        .appendMessage(conv.id, { role: 'assistant', content: fullText })
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
          await persistAssistant();
        }

        yield ev;
      }
    } finally {
      // 中断 / 异常结束时兜底落库，避免丢消息
      await persistAssistant();
    }
  }
}
