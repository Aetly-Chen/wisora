import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { NoteSearchService } from '../../rag/note-search.service';

/**
 * 语义检索笔记。
 *
 * 和 list_my_notes 的分工（两个都保留，不是替代关系）：
 * - `list_my_notes` 走字面匹配（`contains`）：用户给了明确的词，或要列全部时用它，
 *   精确、可预期，还能按关键词定位到具体哪一篇。
 * - `search_my_notes` 走向量语义：用户描述的是「意思」而不是原词时才有优势 ——
 *   「上次那篇讲播放器卡顿的笔记」这种，字面搜不到，语义能捞回来。
 *
 * userId 由工厂闭包注入，和 notes.tool.ts 同一策略：
 * 模型无法通过参数指定别人的 userId，检索天然只覆盖当前用户的数据。
 */

/** 单条摘录回给模型的长度上限。5 条 × 这个长度就是一次工具调用塞进上下文的总量 */
const EXCERPT_LIMIT = 800;

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('要检索的问题或描述。用自然语言写，不要求是笔记里的原词'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回多少条片段，默认 5'),
});

export function createSearchNotesTool(search: NoteSearchService, userId: string) {
  return tool(
    async ({ query, limit }) => {
      try {
        if (!search.enabled) {
          return JSON.stringify({
            found: false,
            message:
              '语义检索当前不可用（服务端未配置 embedding 服务），请改用 list_my_notes 按关键词搜索',
          });
        }

        const hits = await search.search(userId, query, limit ?? 5);
        if (hits.length === 0) {
          return JSON.stringify({
            found: false,
            message: '没有找到与这个问题相关的笔记内容',
          });
        }

        return JSON.stringify({
          found: true,
          count: hits.length,
          results: hits.map((hit) => ({
            noteId: hit.noteId,
            noteTitle: hit.noteTitle,
            section: hit.section,
            // 保留三位小数：模型看到的相对顺序比绝对值更有用
            relevance: Number(hit.score.toFixed(3)),
            excerpt: hit.content.slice(0, EXCERPT_LIMIT),
          })),
        });
      } catch (err) {
        // 检索失败不该让整轮对话崩掉 —— 转成模型能读懂的结果，它可以改用别的工具
        const message = err instanceof Error ? err.message : String(err);
        return JSON.stringify({ found: false, message: `语义检索失败：${message}` });
      }
    },
    {
      name: 'search_my_notes',
      description:
        '按语义检索当前用户的笔记，返回最相关的若干片段（含所属笔记 id、标题与所属小节）。' +
        '当用户描述的是「意思」而不是原文里的词时用它，比如「上次那篇讲性能优化的笔记」' +
        '「我之前记过关于响应式的东西吗」；如果用户给的是明确的词、或要列出全部笔记，' +
        '用 list_my_notes 更准确。要读全文或改写，拿返回的 noteId 去调 read_my_note。',
      schema: searchSchema,
    },
  );
}
