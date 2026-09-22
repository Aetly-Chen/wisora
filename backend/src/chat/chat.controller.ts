import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SkipResponse } from '../common/decorators/skip-response.decorator';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { UploadedFileLike } from '../common/upload/file-guard';
import { FriendsService } from './friends.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ShareService } from './share.service';
import { ChatGateway } from './chat.gateway';
import { AddFriendDto } from './dto/friend.dto';
import {
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';
import { SendMessageDto } from './dto/message.dto';
import { ShareNoteDto } from './dto/share.dto';

/** 发消息与上传附件各自的限流参数 */
const SEND_SCOPE = 'chat-send';
const SEND_MAX_PER_MINUTE = 30;
const UPLOAD_SCOPE = 'chat-upload';
const UPLOAD_MAX_PER_MINUTE = 20;

/**
 * 聊天接口。
 *
 * 路径前缀 `/chat`（**不加全局前缀**，与 `/ai`、`/notes` 一致），
 * 前端拼的是 `${VITE_BASE_API}/chat/...`。
 *
 * 全部接口挂 JwtAuthGuard，userId 一律从令牌取 —— 不接受客户端传入，
 * 否则任何人都能冒充他人发消息。
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly friends: FriendsService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly attachments: ChatAttachmentsService,
    private readonly share: ShareService,
    private readonly rateLimit: RateLimitService,
    private readonly gateway: ChatGateway,
  ) {}

  /* ------------------------------ 好友 ------------------------------ */

  /** 我的好友列表 */
  @Get('friends')
  listFriends(@CurrentUser() userId: string) {
    return this.friends.list(userId);
  }

  /** 搜索用户。空关键词返回空数组，不返回全量用户 */
  @Get('users')
  searchUsers(
    @CurrentUser() userId: string,
    @Query('keyword') keyword?: string,
  ) {
    return this.friends.search(userId, keyword ?? '');
  }

  /** 加好友。幂等：已加过返回既有关系 */
  @Post('friends')
  addFriend(@CurrentUser() userId: string, @Body() dto: AddFriendDto) {
    return this.friends.add(userId, dto.userId);
  }

  @Delete('friends/:userId')
  removeFriend(
    @CurrentUser() userId: string,
    @Param('userId') friendId: string,
  ) {
    return this.friends.remove(userId, friendId);
  }

  /* ------------------------------ 会话 ------------------------------ */

  @Get('conversations')
  listConversations(@CurrentUser() userId: string) {
    return this.conversations.list(userId);
  }

  /** 单聊 / 建群，按 body 里的 kind 分流 */
  @Post('conversations')
  createConversation(
    @CurrentUser() userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(userId, dto);
  }

  /** 置顶 / 免打扰。只改当前用户自己那一行成员记录 */
  @Patch('conversations/:id')
  updateConversation(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversations.updateFlags(userId, id, dto);
  }

  /**
   * 标记已读。
   *
   * 除了改库，还要给会话内其他人推 read 事件 —— 否则对方看不到
   * 「已读」双勾变成实心。推送由 controller 发起而不是 service：
   * service 注入 gateway 会形成 service ↔ gateway 循环依赖。
   */
  @Post('conversations/:id/read')
  async markRead(@CurrentUser() userId: string, @Param('id') id: string) {
    const memberIds = await this.conversations.markRead(userId, id);
    this.gateway.pushToMembers(memberIds, userId, {
      type: 'read',
      conversationId: id,
      userId,
    });
    return { read: true };
  }

  /* ------------------------------ 消息 ------------------------------ */

  /** 历史消息，时间正序。游标分页：?before=<messageId>&limit=30 */
  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messages.list(
      userId,
      id,
      before,
      limit ? Number(limit) : undefined,
    );
  }

  /**
   * 发消息。body 三者至少一个：text / attachmentId / noteId。
   *
   * 发成功后推送给**全部**会话成员（含发送者自己）—— 前端已按 id 去重，
   * 服务端统一推一次可以让多端登录的其它设备也即时看到。
   */
  @Post('conversations/:id/messages')
  async sendMessage(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    await this.assertRateLimit(userId, SEND_SCOPE, SEND_MAX_PER_MINUTE);

    const message = await this.messages.send(userId, id, dto);
    const memberIds = await this.conversations.memberIds(id);
    this.gateway.pushToMembers(memberIds, null, { type: 'message', message });

    return message;
  }

  /**
   * 分享笔记给好友。
   *
   * 请求体只有 noteId / toFriendIds / comment —— 标题由后端自己按
   * noteId 查，见 ShareNoteDto 的注释。
   */
  @Post('notes/share')
  shareNote(@CurrentUser() userId: string, @Body() dto: ShareNoteDto) {
    return this.share.share(userId, dto);
  }

  /* ------------------------------ 附件 ------------------------------ */

  /**
   * 上传附件，先拿 id 再发消息。
   *
   * 字段名固定 `file`。内存存储（不写磁盘），白名单与体积校验在 service 里。
   * limits.fileSize 只是第一道闸，真正给用户看的报错来自 assertUploadable。
   */
  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadAttachment(
    @CurrentUser() userId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    await this.assertRateLimit(userId, UPLOAD_SCOPE, UPLOAD_MAX_PER_MINUTE);
    return this.attachments.upload(userId, file);
  }

  /** 删除「还没发出去」的附件（前端暂未接） */
  @Delete('attachments/:id')
  removeAttachment(
    @CurrentUser() userId: string,
    @Param('id') id: string,
  ) {
    return this.attachments.remove(userId, id);
  }

  /**
   * 读取附件内容（预览与下载共用）。
   *
   * 必须 @SkipResponse()：全局拦截器会把响应包成 {code,msg,data}，
   * 二进制内容会被破坏。
   *
   * 前端不能把这个地址直接塞给 <img src> —— 接口需要 Authorization 头，
   * 而 img / iframe 带不上自定义头。前端要先 fetch 成 Blob 再转 objectURL
   * （笔记模块的 fetchAttachmentBlob 是同一套做法）。
   */
  @Get('attachments/:id/content')
  @SkipResponse()
  async attachmentContent(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('download') download?: string,
  ) {
    const { attachment, buffer } = await this.attachments.readContent(
      userId,
      id,
    );

    // 文件名含中文时需用 RFC 5987 编码，否则部分浏览器会乱码
    const encoded = encodeURIComponent(attachment.filename);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
    );
    res.end(buffer);
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 超限抛 429。前端按 429 提示「发送过于频繁」。
   *
   * 阈值比 AI 模块宽松（30 vs 10）：聊天是高频动作，
   * 用 AI 那个阈值正常聊天都会被拦。
   */
  private async assertRateLimit(
    userId: string,
    scope: string,
    max: number,
  ): Promise<void> {
    const result = await this.rateLimit.check(userId, { scope, max });
    if (!result.allowed) {
      throw new HttpException(
        `操作过于频繁，请 ${result.resetSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
