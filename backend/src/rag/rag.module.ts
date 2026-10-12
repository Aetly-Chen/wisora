import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmbeddingService } from './embedding.service';
import { NoteIndexService } from './note-index.service';
import { NoteSearchService } from './note-search.service';

/**
 * RAG 检索基础设施：向量化、笔记索引、语义检索。
 *
 * 独立成模块、而不是塞进 ai —— 因为 notes 模块也要用它（保存笔记后重建索引），
 * 放 ai 里会让 notes 反向依赖 ai。项目里已经因为同样的问题把 RateLimitService
 * 从 ai 挪到了 common（见 ai.module.ts 里那条注释）。
 *
 * 依赖方向：notes → rag ← ai，两边都只依赖 rag，rag 只依赖 Prisma。
 * rag 绝不能反过来依赖 NotesModule，否则就是环。
 *
 * @Global() 是为了让 ai / notes 都能直接注入，不必各自 import 一遍；
 * 但注意 @Global() 的模块**仍然要在 app.module.ts 里挂一次**才生效。
 */
@Global()
@Module({
  imports: [PrismaModule],
  providers: [EmbeddingService, NoteIndexService, NoteSearchService],
  exports: [EmbeddingService, NoteIndexService, NoteSearchService],
})
export class RagModule {}
