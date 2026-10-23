import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
 import {  
   ALLOWED_MIME,  
  assertUploadable,  
   decodeFilename,  
   type UploadedFileLike,  
} from '../common/upload/file-guard';




@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  private async assertOwned(userId: string, attachmentId: string) {
    const found = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, userId },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('附件不存在或无权访问');
  }

  /** 上传：校验类型与大小 → 落盘 → 写元数据 */
  async upload(userId: string, file: UploadedFileLike | undefined, noteId?: string) {
    if (!file) throw new BadRequestException('未收到文件');

    if (!ALLOWED_MIME.has(file.mimetype)) {
      throw new BadRequestException(
        `不支持的文件类型：${file.mimetype}。仅支持 PDF、Markdown、文本、图片与 Office 文档`,
      );
    }
    if (file.size > this.storage.maxSize) {
      throw new BadRequestException(
        `文件过大，最大 ${Math.round(this.storage.maxSize / 1024 / 1024)}MB`,
      );
    }

    // 挂到笔记时先校验笔记归属，避免把附件挂到别人的笔记上
    if (noteId) {
      const note = await this.prisma.note.findFirst({
        where: { id: noteId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!note) throw new NotFoundException('笔记不存在或无权访问');
    }

    const storageKey = await this.storage.save(file.buffer, file.originalname);

    return this.prisma.attachment.create({
      data: {
        userId,
        noteId: noteId ?? null,
        filename: decodeFilename(file.originalname),
        mimeType: file.mimetype,
        size: file.size,
        storageKey,
      },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        noteId: true,
        createdAt: true,
      },
    });
  }

  /** 列附件：按笔记维度，或列出该用户全部 */
  async list(userId: string, noteId?: string) {
    return this.prisma.attachment.findMany({
      where: { userId, ...(noteId ? { noteId } : {}) },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        noteId: true,
        createdAt: true,
      },
    });
  }

  /** 取附件内容用于下载 / 预览 */
  async readContent(userId: string, attachmentId: string) {
    const att = await this.prisma.attachment.findFirst({
      where: { id: attachmentId, userId },
    });
    if (!att) throw new NotFoundException('附件不存在或无权访问');

    const buffer = await this.storage.read(att.storageKey);
    return { attachment: att, buffer };
  }

  /** 删除：先删记录再删文件，避免删文件成功但记录残留导致列表出现死链 */
  async remove(userId: string, attachmentId: string) {
    await this.assertOwned(userId, attachmentId);

    const att = await this.prisma.attachment.delete({
      where: { id: attachmentId },
      select: { storageKey: true },
    });
    await this.storage.remove(att.storageKey);

    return { deleted: true };
  }

  /* ------------------------------------------------------------------ *
   * 附件直链签名
   *
   * 为什么需要：`<img src="...">` 带不了 Authorization 头，而
   * `/attachments/:id/content` 上挂着 JwtAuthGuard —— 图片在编辑器里必然 401。
   * 这也是聊天附件、笔记封面、导出 HTML 会反复撞上的同一个问题。
   *
   * 做法与 S3 presigned URL 同理：HMAC 签「附件 id + 过期时间」。
   * 拿到链接的人能在有效期内读**这一张**图，不能读别的、也不能续签。
   * ------------------------------------------------------------------ */

  /**
   * 签名密钥从 JWT 密钥派生，但**不是同一个值** ——
   * 用途不同，泄漏面要隔开：JWT 泄漏不该同时等于所有附件可读。
   */
  private mediaSecret(): Buffer {
    return createHash('sha256')
      .update(`${process.env.JWT_ACCESS_SECRET ?? ''}::attachment-media`)
      .digest();
  }

  private sign(id: string, exp: number): string {
    return createHmac('sha256', this.mediaSecret())
      .update(`${id}.${exp}`)
      .digest('base64url')
      .slice(0, 32);
  }

  /**
   * 给一批自己的附件签发短时直链。
   * 返回相对路径（`/attachments/...`），由前端拼上 API base ——
   * 后端不拼 host，避免反代 / 多域名下拿到错误的 origin。
   */
  async signMany(userId: string, ids: string[], ttlSeconds = 3600) {
    if (!Array.isArray(ids) || ids.length === 0) return {} as Record<string, string>;
    if (ids.length > 60) throw new BadRequestException('一次最多签发 60 个附件');
    if (ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new BadRequestException('附件 id 不合法');
    }

    // 查不到的 id 静默跳过，不暴露「存在但无权」（与 assertOwned 的 404 口径一致）
    const owned = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });

    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const result: Record<string, string> = {};
    for (const { id } of owned) {
      result[id] = `/attachments/${id}/raw?exp=${exp}&sig=${this.sign(id, exp)}`;
    }
    return result;
  }

  /**
   * 校验直链签名并读内容。
   *
   * 这里**刻意不校验 userId** —— 签名本身就是授权凭证（与 presigned URL 一致）。
   * 任何失败都返回同一个 404，不区分「没签名」「签名错」「已过期」之外的信息，
   * 避免把「这个 id 存在」泄漏给拿不到签名的人。
   */
  async readBySignature(attachmentId: string, exp: string, sig: string) {
    const expNum = Number(exp);
    if (!Number.isInteger(expNum) || expNum <= 0) {
      throw new NotFoundException('链接无效');
    }
    if (expNum * 1000 < Date.now()) {
      throw new NotFoundException('链接已过期');
    }

    const expected = this.sign(attachmentId, expNum);
    const given = Buffer.from(sig ?? '');
    const want = Buffer.from(expected);
    // timingSafeEqual 长度不等会抛，必须先比长度
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      throw new NotFoundException('链接无效');
    }

    const att = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });
    if (!att) throw new NotFoundException('附件不存在');

    const buffer = await this.storage.read(att.storageKey);
    return { attachment: att, buffer };
  }
}
export type { UploadedFileLike } from '../common/upload/file-guard';  
export { ALLOWED_MIME };

