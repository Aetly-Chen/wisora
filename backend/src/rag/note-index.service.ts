import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmbeddingService } from './embedding.service';
import { chunkNote, toEmbeddingText, type Chunk } from './chunk';
import { encodeVector } from './vector';

/** 单次写库的块数上限，避免一条 INSERT 塞进几千行 */
const INSERT_BATCH = 200;

/**
 * 笔记索引：把笔记正文切成块、编码成向量、写进 NoteChunk。
 *
 * 这里直接查 Prisma 而不走 NotesService —— 和 ai/tools/notes.tool.ts 里
 * 「工具必须走 NotesService」的约定不冲突：那条约定针对的是**写笔记**，
 * 为的是不绕过层级/软删等业务校验。而建索引是只读地取正文 + 写自己的
 * NoteChunk 表，不碰笔记本身，也就没有绕开校验的问题。
 *
 * 反过来，如果这里依赖 NotesService，就会形成 rag → notes 的耦合，
 * 而 notes 又要依赖 rag（保存后触发重建）—— 直接成环。
 */
@Injectable()
export class NoteIndexService {
  private readonly logger = new Logger(NoteIndexService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {}

  /**
   * 重建单篇笔记的索引，返回生成的块数。
   *
   * ⚠️ 先删后建，而且**先删**这一步无论笔记是否存在都要做：
   * 笔记被删掉、或者正文被改短了，旧块若留着，检索就会召回
   * 已经不存在的内容 —— 比搜不到更糟。
   */
  async reindexNote(noteId: string): Promise<number> {
    const note = await this.prisma.note.findFirst({
      where: { id: noteId, deletedAt: null },
      select: { id: true, userId: true, title: true, content: true },
    });

    await this.removeChunks([noteId]);

    if (!note || !this.embedding.enabled) return 0;

    const chunks = chunkNote(note.title, note.content);
    if (chunks.length === 0) return 0;

    const vectors = await this.embedding.embed(chunks.map(toEmbeddingText));
    await this.writeChunks(note.userId, note.id, chunks, vectors);
    return chunks.length;
  }

  /** 删除若干篇笔记的块（笔记软删、正文变短、重走索引时都要用） */
  async removeChunks(noteIds: string[]): Promise<void> {
    if (noteIds.length === 0) return;
    await this.prisma.noteChunk.deleteMany({ where: { noteId: { in: noteIds } } });
  }

  /** 清掉整个用户的索引（换 embedding 模型后必须走这一步） */
  async dropUserIndex(userId: string): Promise<number> {
    const r = await this.prisma.noteChunk.deleteMany({ where: { userId } });
    return r.count;
  }

  /**
   * 全量重建某个用户的索引。
   *
   * 先把所有笔记切成块、再统一送去编码 —— 比「逐篇编码」少很多次往返，
   * 因为 embed() 内部本来就会分批。
   */
  async reindexUser(userId: string): Promise<{ notes: number; chunks: number }> {
    const notes = await this.prisma.note.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, title: true, content: true },
    });

    await this.dropUserIndex(userId);

    if (!this.embedding.enabled) {
      this.logger.warn('未配置 EMBEDDING_API_KEY，跳过向量化（旧索引已清除）');
      return { notes: notes.length, chunks: 0 };
    }

    const pending: { noteId: string; chunk: Chunk }[] = [];
    for (const note of notes) {
      for (const chunk of chunkNote(note.title, note.content)) {
        pending.push({ noteId: note.id, chunk });
      }
    }
    if (pending.length === 0) return { notes: notes.length, chunks: 0 };

    const vectors = await this.embedding.embed(pending.map((p) => toEmbeddingText(p.chunk)));

    // 按笔记分组写，保留各自的 seq
    const byNote = new Map<string, { chunks: Chunk[]; vectors: Float32Array[] }>();
    pending.forEach((p, i) => {
      const bucket = byNote.get(p.noteId) ?? { chunks: [], vectors: [] };
      bucket.chunks.push(p.chunk);
      bucket.vectors.push(vectors[i]);
      byNote.set(p.noteId, bucket);
    });

    let total = 0;
    for (const [noteId, bucket] of byNote) {
      await this.writeChunks(userId, noteId, bucket.chunks, bucket.vectors);
      total += bucket.chunks.length;
    }

    return { notes: notes.length, chunks: total };
  }

  private async writeChunks(
    userId: string,
    noteId: string,
    chunks: Chunk[],
    vectors: Float32Array[],
  ): Promise<void> {
    for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
      const slice = chunks.slice(i, i + INSERT_BATCH);
      await this.prisma.noteChunk.createMany({
        data: slice.map((c, j) => ({
          noteId,
          userId,
          seq: c.seq,
          title: c.title,
          content: c.content,
          embedding: encodeVector(vectors[i + j]),
        })),
      });
    }
  }
}
