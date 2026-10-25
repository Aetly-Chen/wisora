import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { ConversationsService } from './conversations.service';
import { onlineKey } from './friends.service';
import type { ChatClientEvent, ChatServerEvent } from './types/chat-events';

/** 房间名：一个会话一个房间 */
const roomOf = (conversationId: string) => `conv:${conversationId}`;

/**
 * 在线状态 TTL（秒）。
 *
 * 断开时主动删，TTL 只是进程被杀 / 网络僵死时的兜底。
 * 连接期间靠 engine.io 的心跳（默认 25s 一次）不断续期。
 */
const ONLINE_TTL = 120;

/** 前端订阅用的单一事件通道，载荷是 ChatServerEvent（带 type 字段） */
const EVENT_CHANNEL = 'event';

interface AuthedSocket extends Socket {
  data: { userId?: string }; // 握手鉴权通过后写入的用户 id；被拒时一直是 undefined
}

/**
 * 聊天实时网关。
 *
 * 命名空间 `chat`，前端连 `ws://<host>/chat`。
 *
 * 鉴权：令牌**不放 query**（会进访问日志与代理记录）——
 * 与 ai 模块当初为 SSE 引入一次性 ticket 是同一个理由。
 * 支持两种握手方式：
 *   1. socket.io 的 auth 字段：`io(url, { auth: { token } })`
 *   2. Authorization 头：`Bearer <token>`
 */
@WebSocketGateway({
  namespace: 'chat',
  /*
   * 必须显式配 cors：main.ts 里的 app.enableCors() 只管 HTTP，
   * 不影响 WebSocket 的握手响应。
   */
  cors: { origin: true, credentials: true },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly conversations: ConversationsService,
  ) {}

  /* ------------------------------ 连接生命周期 ------------------------------ */

  async handleConnection(client: AuthedSocket) {
    const userId = await this.authenticate(client);
    if (!userId) {
      // 认证失败立刻断开，且不发任何业务事件
      client.disconnect(true);
      return;
    }
    client.data.userId = userId;

    await this.markOnline(userId);

    /*
     * 一次性 join 全部房间。
     * 等发消息时再临时 join 会有竞态：A 连上后 B 发的第一条消息可能到不了。
     */
    const conversationIds = await this.conversations.myConversationIds(userId);
    for (const id of conversationIds) {
      await client.join(roomOf(id));
    }

    /*
     * 续期在线状态。
     *
     * 用 engine.io 的心跳而不是自己 setInterval：心跳本来就是
     * 「连接还活着」的信号，省掉一套定时器的登记与清理。
     * 如果这里没触发，退化为「连上后 120 秒内显示在线」——
     * 不会出现「永远在线」这种更糟的方向。
     */
    client.conn.on('heartbeat', () => {
      void this.markOnline(userId);
    });

    this.broadcast({ type: 'presence', userId, presence: 'online' });
  }

  async handleDisconnect(client: AuthedSocket) {
    const userId = client.data?.userId;
    if (!userId) return;

    /*
     * 同一用户可能多端在线，只有最后一个连接断开才算离线。
     * socket.io 在 authenticate 里把 socket 加进了以 userId 命名的房间，
     * 所以这里按那个房间查剩余连接数。
     */
    const remaining = await this.server.in(userId).fetchSockets();
    if (remaining.length > 0) return;

    await this.redis.getClient().del(onlineKey(userId));
    this.broadcast({ type: 'presence', userId, presence: 'offline' });
  }

  /**
   * 校验握手令牌，并把自己 join 进以 userId 命名的房间（用于多端识别）。
   * 返回 null 表示认证失败。
   */
  private async authenticate(client: Socket): Promise<string | null> {
    const fromAuth = client.handshake.auth?.token;
    const header = client.handshake.headers.authorization;
    const fromHeader =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    const token =
      (typeof fromAuth === 'string' ? fromAuth : undefined) ?? fromHeader;

    if (!token) return null;

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      await client.join(payload.sub);
      return payload.sub;
    } catch {
      this.logger.warn('WebSocket 握手令牌无效，已断开');
      return null;
    }
  }

  private async markOnline(userId: string): Promise<void> {
    try {
      await this.redis
        .getClient()
        .set(onlineKey(userId), '1', 'EX', ONLINE_TTL);
    } catch (err) {
      // Redis 抖动不该把连接踢掉
      this.logger.warn(`写入在线状态失败：${(err as Error).message}`);
    }
  }

  /* ------------------------------ 客户端事件 ------------------------------ */

  /** 输入中。节流交给前端，服务端只做成员校验后转发 */
  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: Extract<ChatClientEvent, { type: 'typing' }>,
  ) {
    const userId = client.data?.userId;
    if (!userId || !body?.conversationId) return;

    // 只有成员才能在这个会话里广播 —— 否则可以把状态推到别人的会话
    const ok = await this.conversations
      .assertMember(userId, body.conversationId)
      .then(() => true)
      .catch(() => false);
    if (!ok) return;

    client.to(roomOf(body.conversationId)).emit(EVENT_CHANNEL, {
      type: 'typing',
      conversationId: body.conversationId,
      userId,
      typing: body.typing === true,
    } satisfies ChatServerEvent);
  }

  /** 主动上报已读（前端目前走 REST，两条路二选一） */
  @SubscribeMessage('read')
  async onRead(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: Extract<ChatClientEvent, { type: 'read' }>,
  ) {
    const userId = client.data?.userId;
    if (!userId || !body?.conversationId) return;

    const memberIds = await this.conversations
      .markRead(userId, body.conversationId)
      .catch(() => null);
    if (!memberIds) return;

    this.pushToMembers(memberIds, userId, {
      type: 'read',
      conversationId: body.conversationId,
      userId,
    });
  }

  /* ------------------------------ 服务端推送 ------------------------------ */

  /**
   * 推给会话成员。
   *
   * @param excludeUserId 排除某个人（一般是不想把事件回推给触发者）；
   *        传 null 表示全员都推 —— 新消息要推给发送者，
   *        这样他多端登录的其它设备也能即时看到
   */
  pushToMembers(
    memberIds: string[],
    excludeUserId: string | null,
    event: ChatServerEvent,
  ): void {
    if (!this.server) return;
    const targets = memberIds.filter((id) => id !== excludeUserId);
    if (targets.length === 0) return;
    // 按 userId 房间定向投递，绝不广播给所有人
    this.server.to(targets).emit(EVENT_CHANNEL, event);
  }

  /**
   * 广播给所有连接。
   *
   * **只用于 presence** —— 它本来就是「不区分会话」的状态。
   * 业务事件一律走 pushToMembers，广播会把消息推给不相干的人。
   */
  private broadcast(event: ChatServerEvent): void {
    if (!this.server) return;
    this.server.emit(EVENT_CHANNEL, event);
  }
}
