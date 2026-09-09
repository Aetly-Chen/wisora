import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * 会话类工具：让 Agent 能查询和管理用户自己的会话。
 *
 * 全部强制带上 userId 过滤（从工厂闭包注入），
 * 确保 Agent 只能操作当前登录用户的数据，不能越权看别人的会话。
 */

const listConversationsSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe('返回的会话数量，默认 5，最多 20'),
});

export function createListConversationsTool(
  prisma: PrismaService,
  userId: string,
) {
  return tool(
    async ({ limit }) => {
      const rows = await prisma.conversation.findMany({
        where: { userId, deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: limit ?? 5,
        select: { id: true, title: true, model: true, updatedAt: true },
      });

      if (rows.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        conversations: rows.map((r) => ({
          id: r.id,
          title: r.title ?? '(未命名)',
          model: r.model,
          updatedAt: r.updatedAt.toISOString(),
        })),
      });
    },
    {
      name: 'list_my_conversations',
      description:
        '列出当前用户最近的会话（标题、模型、更新时间）。当用户问"我之前聊过什么""我的会话列表"时使用。',
      schema: listConversationsSchema,
    },
  );
}

const readConversationSchema = z.object({
  conversationId: z.string().describe('要查看的会话 ID'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('返回最近多少条消息，默认 20'),
});

export function createReadConversationTool(
  prisma: PrismaService,
  userId: string,
) {
  return tool(
    async ({ conversationId, limit }) => {
      // 校验归属：不存在的 ID 或别人的会话都视为无权访问
      const conv = await prisma.conversation.findFirst({
        where: { id: conversationId, userId, deletedAt: null },
        select: { id: true, title: true },
      });
      if (!conv) {
        return JSON.stringify({ found: false, reason: '会话不存在或无权访问' });
      }

      const messages = await prisma.message.findMany({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'asc' },
        take: limit ?? 20,
        select: { role: true, content: true, createdAt: true },
      });

      return JSON.stringify({
        found: true,
        title: conv.title ?? '(未命名)',
        messages: messages.map((m) => ({
          role: m.role,
          content:
            m.content.length > 500 ? `${m.content.slice(0, 500)}…` : m.content,
        })),
      });
    },
    {
      name: 'read_my_conversation',
      description:
        '读取当前用户某个会话的历史消息。当用户想回顾某次对话内容时使用。',
      schema: readConversationSchema,
    },
  );
}

const renameConversationSchema = z.object({
  conversationId: z.string().describe('要改名的会话 ID'),
  title: z.string().min(1).max(60).describe('新的会话标题'),
});

/**
 * 写操作工具示例：修改会话标题。
 *
 * 在 registerAllTools 里标记 policy.write = true，
 * 只有客户端换票时声明 allowWrite 才会真正执行。
 */
export function createRenameConversationTool(
  prisma: PrismaService,
  userId: string,
) {
  return tool(
    async ({ conversationId, title }) => {
      const updated = await prisma.conversation.updateMany({
        where: { id: conversationId, userId, deletedAt: null },
        data: { title },
      });

      if (updated.count === 0) {
        return JSON.stringify({
          success: false,
          message: '会话不存在或无权修改',
        });
      }
      return JSON.stringify({
        success: true,
        conversationId,
        title,
        message: `已将会话标题改为「${title}」`,
      });
    },
    {
      name: 'rename_my_conversation',
      description:
        '修改当前用户某个会话的标题。当用户说"把这个会话改名为…""重新起个标题"时使用。这是写操作，需要用户授权。',
      schema: renameConversationSchema,
    },
  );
}
