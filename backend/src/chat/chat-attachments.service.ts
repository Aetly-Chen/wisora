import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import {
  assertUploadable,
  decodeFilename,
  type UploadedFileLike,
} from '../common/upload/file-guard';
import { toAttachment } from './chat.mapper';
import type { AttachmentDto } from './types/chat-events';

/**
 * 聊天附件上限（字节）。默认 50MB，与前端 CHAT_FILE_MAX_BYTES 对齐。
 *
 * 比笔记的 20MB 大：聊天里发视频 / 压缩包是常见需求，
 * 而笔记附件基本是 PDF 与图片。
 */
const MAX_BYTES = Number(
  process.env.CHAT_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024,
);

@Injectable()
export class ChatAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 上传：校验 → 落盘 → 写元数据。
   *
   * 此时 messageId 还是 NULL（「待发送」状态）。用户传了文件却关掉页面
   * 会留下孤儿附件，需要定时清理（见 README 的待办）。
   *
   * 控制器用内存存储（FileInterceptor 不写磁盘），先过白名单与体积校验
   * 再落盘，避免非法文件先写进磁盘。
   */
  async upload(
    userId: string,
    file: UploadedFileLike | undefined,
  ): Promise<AttachmentDto> {
    if (!file) throw new BadRequestException('未收到文件');

    // 白名单与体积：真正的安全边界在这里，前端按扩展名判断拦不住任何人
    assertUploadable(file, MAX_BYTES);

    // 只解一次：写库与落盘用同一个名字（两次调用会各算一遍，浪费且有分歧风险）
    const filename = decodeFilename(file.originalname);
    const storageKey = await this.storage.save(file.buffer, filename);

    const row = await this.prisma.chatAttachment.create({
      data: {
        uploaderId: userId,
        filename,
        storageKey,
        mimeType: file.mimetype,
        size: file.size,
      },
      select: { id: true, filename: true, mimeType: true, size: true },
    });

    return toAttachment(row);
  }

  /**
   * 读取附件内容。
   *
   * 两条准入路径：
   * 1. 已挂到某条消息上 → 必须是该消息所属会话的成员
   * 2. 还没挂（上传未发送）→ 只有上传者本人
   *
   * 不校验的话，附件 id 泄露就等于文件泄露（cuid 不易猜，
   * 但会话里任何人都能看到别人发的附件 id）。
   */
  async readContent(userId: string, attachmentId: string) {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        storageKey: true,
        uploaderId: true,
        messageId: true,
      },
    });
    if (!attachment) throw new NotFoundException('附件不存在或无权访问');

    if (attachment.messageId) {
      const member = await this.prisma.chatConversationMember.findFirst({
        where: {
          userId,
          leftAt: null,
          conversation: { messages: { some: { id: attachment.messageId } } },
        },
        select: { id: true },
      });
      if (!member) throw new NotFoundException('附件不存在或无权访问');
    } else if (attachment.uploaderId !== userId) {
      throw new NotFoundException('附件不存在或无权访问');
    }

    return {
      attachment,
      buffer: await this.storage.read(attachment.storageKey),
    };
  }

  /**
   * 删除「还没发出去」的附件。
   *
   * 已挂到消息上的不允许单独删 —— 那会在聊天记录里留下一个打不开的卡片。
   * 要删得连同消息一起删（暂未开放）。
   */
  async remove(userId: string, attachmentId: string) {
    const attachment = await this.prisma.chatAttachment.findFirst({
      where: { id: attachmentId, uploaderId: userId },
      select: { id: true, storageKey: true, messageId: true },
    });
    if (!attachment) throw new NotFoundException('附件不存在或无权访问');
    if (attachment.messageId) {
      throw new BadRequestException('附件已发送，不能单独删除');
    }

    /*
     * 先删记录再删文件：反过来的话，删文件成功但删记录失败会留下
     * 一个指向空文件的记录；现在是失败也不会产生死链。
     */
    await this.prisma.chatAttachment.delete({ where: { id: attachment.id } });
    await this.storage.remove(attachment.storageKey);
    return { deleted: true };
  }

  /**
   * 清理孤儿附件（上传了但一直没发出去）。
   *
   * 由 ChatModule 启动时挂一个简易定时器调用，不引入 @nestjs/schedule ——
   * 为一个清理任务加一个运行期依赖不划算。
   */
  async cleanupOrphans(olderThanHours = 24): Promise<number> {
    const before = new Date(Date.now() - olderThanHours * 3600_000);
    const orphans = await this.prisma.chatAttachment.findMany({
      where: { messageId: null, createdAt: { lt: before } },
      select: { id: true, storageKey: true },
      take: 200,
    });

    for (const item of orphans) {
      // 先删文件：即使这里失败，下轮还能靠记录再试一次
      await this.storage.remove(item.storageKey);
    }
    if (orphans.length > 0) {
      await this.prisma.chatAttachment.deleteMany({
        where: { id: { in: orphans.map((o) => o.id) } },
      });
    }
    return orphans.length;
  }
}
