import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';
import { MESSAGE_SHAPE, toMessage } from './chat.mapper';
import { NotesService } from '../notes/notes.service';
import type { MessageDto } from './types/chat-events';
import type { SendMessageDto } from './dto/message.dto';

/** 历史消息默认条数 */
const DEFAULT_PAGE_SIZE = 30;
/** 单次最多返回条数 */
const MAX_PAGE_SIZE = 100;

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly notes: NotesService,
  ) {}

  /**
   * 历史消息，**时间正序**返回（时间线是自上而下渲染的）。
   *
   * 游标分页而不是 offset：实时聊天里消息是不断插入的，
   * offset 分页会让「翻页时看到重复消息」或「漏掉一条」。
   * 游标用 messageId，比传时间戳更稳（同毫秒内的多条不会错位）。
   */
  async list(
    userId: string,
    conversationId: string,
    before?: string,
    limit?: number,
  ): Promise<MessageDto[]> {
    await this.conversations.assertMember(userId, conversationId);

    const take = clampPageSize(limit);
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId },
      // 先按倒序取最新的若干条
      orderBy: { createdAt: 'desc' },
      take,
      // cursor + skip:1 = 从这条之后开始取（不含这条本身）
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      select: MESSAGE_SHAPE,
    });

    // 再翻回正序
    return rows.reverse().map(toMessage);
  }

  /**
   * 发消息。
   *
   * 三件事必须在一个事务里：写消息、推会话活跃时间、给其他人累加未读。
   * 分开做的话，中间失败会留下「消息存在但未读没加」这种静默不一致。
   */
  async send(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<MessageDto> {
    await this.conversations.assertMember(userId, conversationId);

    const text = dto.text?.trim() || null;
    if (!text && !dto.attachmentId && !dto.noteId) {
      throw new BadRequestException('消息内容不能为空');
    }

    // 附件与笔记各有一条独立的建消息路径，因为 kind 与快照字段来源不同
    if (dto.noteId) {
      return this.writeNoteMessage(userId, conversationId, dto.noteId, text);
    }
    if (dto.attachmentId) {
      return this.writeAttachmentMessage(
        userId,
        conversationId,
        dto.attachmentId,
        text,
      );
    }

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: 'TEXT',
      text,
    });
    return toMessage(created);
  }

  /**
   * 写入一条笔记卡片消息。**公开**：分享接口要复用它。
   *
   * 一条 note 消息的写入规则只应有一处，两条路径各写一遍迟早不一致。
   * 自己先做成员校验，所以外部直接调用也是安全的。
   */
  async createNoteMessage(
    userId: string,
    conversationId: string,
    noteId: string,
    comment: string | null,
  ): Promise<MessageDto> {
    await this.conversations.assertMember(userId, conversationId);
    return this.writeNoteMessage(userId, conversationId, noteId, comment);
  }

  /* ------------------------------ 三种消息写入 ------------------------------ */

  /**
   * 文本 / 附件 / 笔记消息的统一落库点。
   *
   * unread 的累加对象排除了发送者自己 —— 给自己加未读会让列表上
   * 出现一个自己发完消息就冒出来的红点。
   */
  private async insertMessage(data: {
    conversationId: string;
    senderId: string;
    kind: 'TEXT' | 'IMAGE' | 'FILE' | 'NOTE';
    text: string | null;
    noteSnapshot?: {
      noteId: string;
      title: string;
      kind: 'note' | 'folder';
      childCount: number;
    };
    attachmentId?: string;
  }) {
    const [created] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          conversationId: data.conversationId,
          senderId: data.senderId,
          kind: data.kind,
          text: data.text,
          ...(data.noteSnapshot
            ? {
                noteId: data.noteSnapshot.noteId,
                noteTitle: data.noteSnapshot.title,
                noteKind: data.noteSnapshot.kind,
                noteChildCount: data.noteSnapshot.childCount,
              }
            : {}),
          ...(data.attachmentId
            ? { attachment: { connect: { id: data.attachmentId } } }
            : {}),
        },
        select: MESSAGE_SHAPE,
      }),
      // updatedAt 是 @updatedAt，这里显式写一次把会话顶到列表最前
      this.prisma.chatConversation.update({
        where: { id: data.conversationId },
        data: { updatedAt: new Date() },
      }),
      this.prisma.chatConversationMember.updateMany({
        where: {
          conversationId: data.conversationId,
          userId: { not: data.senderId },
          leftAt: null,
        },
        data: { unread: { increment: 1 } },
      }),
    ]);

    return created;
  }

  /**
   * 附件消息。
   *
   * 归属校验不能省：附件上传后拿到的 id 就是个字符串，不校验的话
   * 调用方可以把别人的附件 id 塞进来，等于「转发」了他人的文件。
   *
   * 用 403（而不是 404）：对上传者本人来说「不存在」与「不属于你」
   * 是同一件事，前端文案一致即可。
   */
  private async writeAttachmentMessage(
    userId: string,
    conversationId: string,
    attachmentId: string,
    text: string | null,
  ): Promise<MessageDto> {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, uploaderId: true, mimeType: true, messageId: true },
    });
    if (!attachment || attachment.uploaderId !== userId) {
      throw new ForbiddenException('附件不存在或无权访问');
    }
    // 一个附件只能挂在一条消息上（messageId 唯一），否则会出现「一条文件发两遍」
    if (attachment.messageId) {
      throw new BadRequestException('该附件已经发送过了');
    }

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: attachment.mimeType.startsWith('image/') ? 'IMAGE' : 'FILE',
      text,
      attachmentId: attachment.id,
    });
    return toMessage(created);
  }

  /**
   * 笔记卡片消息。
   *
   * 标题等快照信息由服务端按 noteId 查（顺带完成归属校验），
   * **不接受前端传入** —— 否则可以伪造标题把别人的笔记发出去。
   */
  private async writeNoteMessage(
    userId: string,
    conversationId: string,
    noteId: string,
    comment: string | null,
  ): Promise<MessageDto> {
    // 归属校验 + 取快照。get() 内部就是 assertOwned，不归属会抛 404
    const note = await this.notes.get(userId, noteId);

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: 'NOTE',
      text: comment,
      noteSnapshot: {
        noteId: note.id,
        title: note.title || '无标题',
        // 有子页面就当作目录分享，卡片上显示「含 N 个子页面」
        kind: note.children.length > 0 ? 'folder' : 'note',
        childCount: note.children.length,
      },
    });
    return toMessage(created);
  }
}

function clampPageSize(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}
