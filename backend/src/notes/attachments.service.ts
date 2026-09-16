import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from './storage.service';

/**
 * multer 上传文件的形状。
 *
 * 这里本地声明而不是依赖 @types/multer：项目里 multer 只是
 * @nestjs/platform-express 的传递依赖，为一个类型引入新的 types 包不划算。
 */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * 还原文件名编码。
 *
 * multer 对 multipart 里的文件名按 latin1 解码，中文名会变成
 * "æµè¯ææ¡£.pdf" 这样的乱码 —— 字节本身没错（仍是 UTF-8 序列），
 * 只是被当成了单字节字符。这里按 latin1 读回字节再解成 UTF-8。
 *
 * 加两道判断是因为存在两种情况：
 *   1. 名字含 0x80–0xFF 的高位字符 → 属于 latin1 误读，需要还原
 *   2. 客户端已正确按 UTF-8 传（字符码 > 0xFF）→ 原样返回
 * 还原结果若含替换字符 U+FFFD，说明本就不是误读，同样保持原样。
 */
function decodeFilename(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * 允许上传的类型白名单。
 *
 * 不做通配放行：上传目录同源可访问，若放任 .html/.svg 等
 * 可执行脚本的类型落盘，等于给自己开了个存储型 XSS 的口子。
 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/markdown',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Office 文档：支持上传与下载，前端不做在线预览
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

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
}
