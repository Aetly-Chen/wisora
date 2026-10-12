import { StructuredToolInterface } from '@langchain/core/tools';
import { NotesService } from '../../notes/notes.service';
import { NoteSearchService } from '../../rag/note-search.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry, type ToolPolicy } from './tool.registry';
import { createQueryUserTool } from './user-info.tool';
import {
  createListConversationsTool,
  createReadConversationTool,
  createRenameConversationTool,
} from './conversation.tool';

import {  
  createCreateNoteTool,  
  createDeleteNoteTool,  
  createListNotesTool,  
  createReadNoteTool,  
  createUpdateNoteTool,  
  createWriteNoteTool,  
} from './notes.tool';
import { createSearchNotesTool } from './search-notes.tool';


export * from './tool.registry';
export * from './user-info.tool';
export * from './conversation.tool';
export * from './notes.tool';



/** 工具 + 它的执行策略 */
export interface ToolWithPolicy {
  tool: StructuredToolInterface;
  policy: Partial<ToolPolicy>;
}

/**
 * 注册全局工具（与具体用户无关）。
 * 在应用启动时由 AiModule.onModuleInit 调用。
 *
 * 新增全局工具：在 tools/ 下建 xxx.tool.ts，然后在此处登记。
 */
export function registerAllTools(
  registry: ToolRegistry,
  prisma: PrismaService,
): void {
  const tools: ToolWithPolicy[] = [
    {
      tool: createQueryUserTool(prisma),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
  ];

  for (const { tool, policy } of tools) {
    registry.register(tool, policy);
  }
}


/**
 * 按请求创建"当前用户专属"的工具。
 *
 * 为什么要每次请求都新建：这些工具必须带 userId 过滤，
 * 否则 Agent 可能读到甚至改动别人的数据。userId 只有在请求时才拿得到，
 * 所以不能像 query_user 那样在启动时注册成全局单例。
 *
 * 笔记工具依赖 NotesService 而不是 Prisma：层级上限、移动环检测、
 * 子树级联删除这些规则必须复用同一份实现，否则 AI 这条路会绕过校验。
 */
export function createUserScopedTools(
  prisma: PrismaService,
  userId: string,
  notes: NotesService,
  search: NoteSearchService,
): ToolWithPolicy[] {
  return [
    /* ---------- 会话（原有，未改动） ---------- */
    {
      tool: createListConversationsTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createReadConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createRenameConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 0, write: true },
    },

    /* ---------- 笔记：读 ---------- */
    {
      tool: createListNotesTool(notes, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createReadNoteTool(notes, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    // 语义检索要多走一次 embedding 调用，比纯查库慢，超时给宽一些
    {
      tool: createSearchNotesTool(search, userId),
      policy: { timeoutMs: 20_000, retries: 1 },
    },

    /* ---------- 笔记：写 ---------- */
    // 写操作一律 retries: 0 —— 注册表默认是 1，而超时用的是
    // Promise.race，底层写入并不会被取消；再重试一次就会出现
    // 「一篇内容保存成两篇」。这类重复数据很难被用户察觉。
    {
      tool: createCreateNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createWriteNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createUpdateNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createDeleteNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
  ];
}


