import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';

/** 列表项：不返回正文，避免列表接口拖着几十 KB 的 Markdown */
const LIST_SELECT = {
  id: true,
  title: true,
  pinned: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * 详情结构：创建 / 更新 / 查询三个接口共用同一份。
 *
 * 曾经创建与更新用的是 `{ ...LIST_SELECT, content: true }`，少了 attachments，
 * 而前端 NoteDetail 把 attachments 声明为必填 —— 新建笔记后页面读
 * `attachments.length` 直接抛 TypeError。共用一份 select 就不会再漏。
 */
const DETAIL_SELECT = {
  id: true,
  userId: true,
  title: true,
  content: true,
  pinned: true,
  parentId: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  /**
   * 子页面摘要。带上是为了「父页面无内容时展示子页面标题」——
   * 否则每打开一个父页面都要多发一次请求，而且切换时会有明显的空窗。
   */
  /*
   * 这里用单键 orderBy：`as const` 会把数组推成 readonly 元组，
   * 与 Prisma 要求的可变数组不兼容；去掉 `as const` 则 'desc' 退化成 string，
   * 同样不匹配。单对象形式两边都满足。
   * 「置顶优先」的次级排序在 get() 里补。
   */
  children: {
    where: { deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, pinned: true, updatedAt: true },
  },
  attachments: {
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      size: true,
      noteId: true,
      createdAt: true,
    },
  },
} as const;

/**
 * 目录层级上限。
 *
 * 不限制的话，用户连点几下就能造出几十层嵌套，侧边栏缩进会一路顶到右边
 * 没法用，面包屑也跟着失控。这里在写入侧直接挡住。
 */
const MAX_DEPTH = 6;

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

  /** 列表：置顶优先，其余按更新时间倒序。返回扁平结构，树由前端组装 */
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

  /** 详情：含正文、子页面摘要与附件列表 */
  async get(userId: string, noteId: string) {
    await this.assertOwned(userId, noteId);
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, userId, deletedAt: null },
      select: DETAIL_SELECT,
    });
    if (!note) throw new NotFoundException('笔记不存在或无权访问');

    // Prisma 只按 updatedAt 排了子页面，这里补上「置顶优先」
    const children = [...note.children].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        b.updatedAt.getTime() - a.updatedAt.getTime(),
    );
    return { ...note, children };
  }

  /**
   * 从指定节点往上数层级（顶层为 1）。
   * 一路向上直到 parentId 为空或触顶，循环上限即 MAX_DEPTH，天然防死循环。
   */
  private async depthOf(userId: string, noteId: string): Promise<number> {
    let depth = 1;
    let current: string | null = noteId;

    while (current && depth <= MAX_DEPTH) {
      const row: { parentId: string | null } | null =
        await this.prisma.note.findFirst({
          where: { id: current, userId },
          select: { parentId: true },
        });
      if (!row?.parentId) break;
      current = row.parentId;
      depth += 1;
    }
    return depth;
  }

  /** 校验父页面可用（归属正确、未删除、层级未超限），返回其 id */
  private async resolveParent(
    userId: string,
    parentId?: string | null,
  ): Promise<string | null> {
    if (!parentId) return null;

    // 归属校验：否则可以把子页面挂到别人的笔记下
    const parent = await this.prisma.note.findFirst({
      where: { id: parentId, userId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('父页面不存在或无权访问');

    if ((await this.depthOf(userId, parentId)) >= MAX_DEPTH) {
      throw new BadRequestException(
        `目录层级最多 ${MAX_DEPTH} 层，请换一个更上层的页面`,
      );
    }
    return parentId;
  }

  /** 新建：返回结构必须与 get 一致（含空的 attachments），前端才不用做形状判断 */
  async create(userId: string, dto: CreateNoteDto) {
    const parentId = await this.resolveParent(userId, dto.parentId);

    return this.prisma.note.create({
      data: {
        userId,
        parentId,
        title: dto.title?.trim() || '无标题',
        content: dto.content ?? '',
      },
      select: DETAIL_SELECT,
    });
  }

  /**
   * 子树相对自身的高度（自身算 1）。
   * 用于移动时判断「搬过去会不会超过总层数上限」。
   */
  private async subtreeHeight(userId: string, rootId: string): Promise<number> {
    let height = 1;
    let frontier: string[] = [rootId];
    while (frontier.length > 0) {
      const children = await this.prisma.note.findMany({
        where: { userId, parentId: { in: frontier }, deletedAt: null },
        select: { id: true },
      });
      const next = children.map((c) => c.id);
      if (next.length === 0) break;
      height += 1;
      frontier = next;
    }
    return height;
  }

  /**
   * 移动到另一个页面下（parentId 传 null 即移到顶层）。
   *
   * 两道校验缺一不可：
   * 1. **不能移动到自己的子树里** —— 否则会形成环：A 的父是 B、
   *    B 的父是 A，两棵子树互相嵌套，之后谁都遍历不出来，
   *    侧边栏里它们会整片消失。
   * 2. **搬家后总层数不能超限** —— 一个 5 层深的子树挂到第 4 层下
   *    就会变成 8 层。这里算的是「子树最高 + 新父级深度」。
   */
  async move(userId: string, noteId: string, parentId: string | null) {
    await this.assertOwned(userId, noteId);

    if (parentId === noteId) {
      throw new BadRequestException('不能把页面移动到它自己下面');
    }

    let newParentId: string | null = null;
    if (parentId) {
      // 归属校验：不能把页面搬到别人的笔记下
      const parent = await this.prisma.note.findFirst({
        where: { id: parentId, userId, deletedAt: null },
        select: { id: true },
      });
      if (!parent) throw new NotFoundException('目标页面不存在或无权访问');

      // 关键：目标不能落在自己的子树里（collectSubtree 含自身）
      const ownSubtree = await this.collectSubtree(userId, noteId);
      if (ownSubtree.includes(parentId)) {
        throw new BadRequestException('不能把页面移动到它自己的子页面下');
      }

      const [height, parentDepth] = await Promise.all([
        this.subtreeHeight(userId, noteId),
        this.depthOf(userId, parentId),
      ]);
      // 新父级深度 + 子树高度 = 搬家后整棵子树的总深度
      if (parentDepth + height > MAX_DEPTH) {
        throw new BadRequestException(
          `移动后层级会超过 ${MAX_DEPTH} 层，请选一个更上层的页面`,
        );
      }
      newParentId = parentId;
    }

    return this.prisma.note.update({
      where: { id: noteId },
      data: { parentId: newParentId },
      select: DETAIL_SELECT,
    });
  }

  /** 更新：只改传了的字段，避免把没传的字段覆盖成空 */
  async update(userId: string, noteId: string, dto: UpdateNoteDto) {
    await this.assertOwned(userId, noteId);

    // 移动单独走 move（那里有环与层级的校验），这里只处理普通字段。
    // 注意区分「没传」（undefined，不动）与「传了 null」（移到顶层）。
    if (dto.parentId !== undefined) {
      return this.move(userId, noteId, dto.parentId);
    }

    const data: { title?: string; content?: string; pinned?: boolean } = {};
    if (dto.title !== undefined) data.title = dto.title.trim() || '无标题';
    if (dto.content !== undefined) data.content = dto.content;
    if (dto.pinned !== undefined) data.pinned = dto.pinned;

    return this.prisma.note.update({
      where: { id: noteId },
      data,
      select: DETAIL_SELECT,
    });
  }

  /**
   * 收集整棵子树的 id（含自身）。
   *
   * 逐层广度遍历而不是递归 SQL：笔记树很浅（<= MAX_DEPTH），
   * 每层一次查询最多 6 次，代价可忽略，换来的是逻辑一眼能看懂。
   */
  private async collectSubtree(userId: string, rootId: string): Promise<string[]> {
    const all: string[] = [rootId];
    let frontier: string[] = [rootId];

    while (frontier.length > 0) {
      const children = await this.prisma.note.findMany({
        where: { userId, parentId: { in: frontier }, deletedAt: null },
        select: { id: true },
      });
      const next = children.map((c) => c.id);
      if (next.length === 0) break;
      all.push(...next);
      frontier = next;
    }
    return all;
  }

  /**
   * 软删除：连同整棵子树一起删。
   *
   * 只删父页面会让子页面变成"孤儿"—— 列表里还在，但父级已经打不开，
   * 层级关系断裂，用户再也找不到它们。所以按 Notion 的做法整棵删掉，
   * 并返回影响数量让前端能如实地告诉用户删了几篇。
   */
  async remove(userId: string, noteId: string) {
    await this.assertOwned(userId, noteId);

    const ids = await this.collectSubtree(userId, noteId);
    await this.prisma.note.updateMany({
      where: { id: { in: ids }, userId },
      data: { deletedAt: new Date() },
    });

    return { deleted: true, count: ids.length };
  }
}
