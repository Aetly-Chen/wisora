import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { FriendsService } from './friends.service';
import type { ShareNoteResultDto } from './types/chat-events';
import type { ShareNoteDto } from './dto/share.dto';

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly friends: FriendsService,
  ) {}

  /**
   * 把笔记 / 目录分享给若干好友。
   *
   * 每个好友一条单聊消息，而不是建一个群 —— 分享是「我发给你的」
   * 一次性动作，建群会把收件人互相暴露出去。
   *
   * 部分失败：**照常返回成功的那部分**，前端提示「N 位好友已收到」。
   * 一个人失败就整体回滚的话，用户得重新勾选一遍，代价更大。
   */
  async share(userId: string, dto: ShareNoteDto): Promise<ShareNoteResultDto> {
    const friendIds = [...new Set(dto.toFriendIds ?? [])].filter(
      (id) => id && id !== userId,
    );
    if (friendIds.length === 0) {
      throw new BadRequestException('请至少选择一位好友');
    }
    // 只能分享给好友：否则可以给任意 userId 发消息
    await this.friends.assertFriends(userId, friendIds);

    const comment = dto.comment?.trim() || null;
    const conversationIds = new Set<string>();
    let messageCount = 0;
    let lastError: Error | null = null;

    for (const friendId of friendIds) {
      try {
        const conversation = await this.conversations.createDirect(
          userId,
          friendId,
        );
        await this.messages.createNoteMessage(
          userId,
          conversation.id,
          dto.noteId,
          comment,
        );
        conversationIds.add(conversation.id);
        messageCount += 1;
      } catch (err) {
        // 单个人失败不中断其余：记日志后继续
        lastError = err as Error;
        this.logger.warn(
          `分享笔记给 ${friendId} 失败：${(err as Error).message}`,
        );
      }
    }

    if (messageCount === 0) {
      /*
       * 全都失败才报错。这里把原因原样带出来 ——
       * 最常见的失败是 noteId 不归属当前用户（NotesService 抛 404），
       * 吞掉那个错误会让用户看到一句无用的「分享失败」。
       */
      if (lastError instanceof NotFoundException) {
        throw new NotFoundException('笔记不存在或无权访问');
      }
      throw new BadRequestException(
        lastError?.message || '分享失败，请稍后重试',
      );
    }

    return {
      conversationCount: conversationIds.size,
      messageCount,
    };
  }
}
