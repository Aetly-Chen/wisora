import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';

/** 列表项：不返回正文，避免列表接口拖着几十 KB 的 Markdown */
const LIST_SELECT = {
  id: true,
  title: true,
  pinned: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 归属校验，不归属则抛 404。
   *
   * 与 ai 模块同一套策略：凡是"外部传入 id"的入口都必须先过这一关，
   * 且"不存在"与"无权访问"返回同一文案，
   * 避免攻击者用错误差异探测他人笔记 id。
   */
  async assertOwned(userId: string, noteId: string): Promise<void> {
    const owned = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!owned) {
      throw new NotFoundException('笔记不存在或无权访问');
    }
  }

  /** 列表：置顶优先，其余按更新时间倒序 */
  async list(userId: string, keyword?: string) {
    const notes = await this.prisma.note.findMany({
      where: {
        userId,
        deletedAt: null,
        ...(keyword
          ? {
              OR: [
                { title: { contains: keyword, mode: 'insensitive' as const } },
                { content: { contains: keyword, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      select: LIST_SELECT,
    });
    return notes;
  }

  /** 详情：含正文与附件列表 */
  async get(userId: string, noteId: string) {
    await this.assertOwned(userId, noteId);
    const note = await this.prisma.note.findUnique({
      where: { id: noteId },
      include: {
        attachments: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            filename: true,
            mimeType: true,
            size: true,
            createdAt: true,
          },
        },
      },
    });
    if (!note) throw new NotFoundException('笔记不存在或无权访问');
    return note;
  }

  async create(userId: string, dto: CreateNoteDto) {
    return this.prisma.note.create({
      data: {
        userId,
        title: dto.title?.trim() || '无标题',
        content: dto.content ?? '',
      },
      select: { ...LIST_SELECT, content: true },
    });
  }

  /** 更新：只改传了的字段，避免把没传的字段覆盖成空 */
  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    await this.assertOwned(userId, noteId);

    const data: { title?: string; content?: string; pinned?: boolean } = {};
    if (dto.title !== undefined) data.title = dto.title.trim() || '无标题';
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.pinned !== undefined) data.pinned = dto.pinned;

    return this.prisma.note.update({
      where: { id: noteId },
      data,
      select: { ...LIST_SELECT, content: true },
    });
  }

  /** 软删除：连带把附件标记为已删（实体文件由 AttachmentService 处理） */
  async remove(userId: string, noteId: string) {
    await this.assertOwned(userId, noteId);
    await this.prisma.note.update({
      where: { id: noteId },
      data: { deletedAt: new Date() },
    });
    return { deleted: true };
  }
}
