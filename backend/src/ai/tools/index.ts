import { StructuredToolInterface } from '@langchain/core/tools';
import { PrismaService } from '../../prisma/prisma.service';
import { ToolRegistry, type ToolPolicy } from './tool.registry';
import { createQueryUserTool } from './user-info.tool';
import {
  createListConversationsTool,
  createReadConversationTool,
  createRenameConversationTool,
} from './conversation.tool';

export * from './tool.registry';
export * from './user-info.tool';
export * from './conversation.tool';

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
 * 为什么要每次请求都新建：会话类工具必须带 userId 过滤，
 * 否则 Agent 可能读到甚至改动别人的数据。userId 只有在请求时才拿得到，
 * 所以不能像 query_user 那样在启动时注册成全局单例。
 */
export function createUserScopedTools(
  prisma: PrismaService,
  userId: string,
): ToolWithPolicy[] {
  return [
    {
      tool: createListConversationsTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createReadConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      // 写操作：未取得本次会话授权时会被 AiService.invokeTool 拦截
      tool: createRenameConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 0, write: true },
    },
  ];
}
