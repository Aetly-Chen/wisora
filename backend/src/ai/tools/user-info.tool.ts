import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { PrismaService } from '../../prisma/prisma.service';

export const queryUserArgsSchema = z.object({
  keyword: z.string().describe('邮箱或昵称关键词'),
});

/**
 * 示例工具：按关键词查询用户资料。
 *
 * 用工厂函数创建，把 Nest 的 PrismaService 注入进工具闭包，
 * 这样工具内部可以直接使用依赖注入的 Service。
 */
export function createQueryUserTool(prisma: PrismaService) {
  return tool(
    async ({ keyword }) => {
      const users = await prisma.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            { email: { contains: keyword, mode: 'insensitive' } },
            { nickname: { contains: keyword, mode: 'insensitive' } },
          ],
        },
        select: { id: true, email: true, nickname: true },
        take: 5,
      });

      if (users.length === 0) return JSON.stringify({ found: false });
      return JSON.stringify({ found: true, users });
    },
    {
      name: 'query_user',
      description: '按邮箱或昵称关键词查询用户资料，用于回答与用户相关的问题',
      schema: queryUserArgsSchema,
    },
  );
}
