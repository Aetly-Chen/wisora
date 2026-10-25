import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { cosine, decodeVector } from './vector';

export interface NoteSearchHit {
  noteId: string; // 命中笔记的 id，前端据此跳转到笔记详情
  /** 笔记标题 */
  noteTitle: string;
  /** 命中块所在的小节标题 */
  section: string;
  /** 命中块正文 */
  content: string;
  /** 余弦相似度，0~1，越大越相关 */
  score: number;
}

@Injectable()
export class NoteSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  get enabled(): boolean {
    return this.embedding.enabled;
  }

  /**
   * 语义检索当前用户的笔记。
   *
   * 每次都把这个用户的块全量读出来在内存里算 —— 没有缓存。
   * 理由是量级：实测 2 万条 1024 维向量算一遍只要 35ms，而读库和反序列化
   * 才是大头；在这个量级下维护一套缓存失效逻辑（笔记改了要清、多实例要同步）
   * 带来的复杂度远大于收益。等单个用户的块数上万、或并发上来了再加。
   */
  async search(userId: string, query: string, limit: number): Promise<NoteSearchHit[]> {
    if (!this.embedding.enabled) return [];

    const [queryVec] = await this.embedding.embed([query]);
    if (!queryVec) return [];

    /*
     * 两个过滤条件都不能省：
     * - `userId`：少了它就会把别人的笔记片段召回给当前用户，这是 RAG 里
     *   最容易出的安全事故，而且不报错、只是"悄悄多返回几条"。
     * - `note.deletedAt`：笔记走软删除，NoteChunk 上的 Cascade 不会触发，
     *   已删笔记的块还留在库里，不 join 回来过滤就会搜出不存在的内容。
     */
    const rows = await this.prisma.noteChunk.findMany({
      where: { userId, note: { deletedAt: null } },
      select: {
        noteId: true,
        title: true,
        content: true,
        embedding: true,
        note: { select: { title: true } },
      },
    });

    return rows
      .map((row) => ({
        noteId: row.noteId,
        noteTitle: row.note.title,
        section: row.title,
        content: row.content,
        score: cosine(queryVec, decodeVector(row.embedding)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
