import { Injectable } from '@nestjs/common';
import { StructuredToolInterface } from '@langchain/core/tools';

export interface ToolPolicy {
  /** 单次执行超时（毫秒） */
  timeoutMs: number;
  /** 失败重试次数。写操作务必设为 0，避免重复执行 */
  retries: number;
  /** 允许调用的角色（留空表示不限制，权限控制预留） */
  roles?: string[];
  /**
   * 是否为写操作（会改变数据）。
   *
   * 写操作只有在客户端换票时声明 allowWrite=true 才会真正执行；
   * 未授权时返回"需要授权"的结果，由模型转告用户。
   * 这样既保持 SSE 单向，又避免 AI 擅自改数据。
   */
  write?: boolean;
}

/**
 * 工具注册表：统一管理 AI 可调用的工具，
 * 提供鉴权 / 超时 / 重试策略。
 *
 * 工具用工厂函数创建（见 user-info.tool.ts），
 * 才能在工具内部使用 Nest 依赖注入的 Service（Prisma、Redis 等）。
 */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, StructuredToolInterface>();
  private readonly policies = new Map<string, ToolPolicy>();

  register(tool: StructuredToolInterface, policy?: Partial<ToolPolicy>) {
    this.tools.set(tool.name, tool);
    this.policies.set(tool.name, {
      timeoutMs: 15_000,
      retries: 1,
      ...policy,
    });
  }

  list(): StructuredToolInterface[] {
    return [...this.tools.values()];
  }

  get(name: string): StructuredToolInterface | undefined {
    return this.tools.get(name);
  }

  policy(name: string): ToolPolicy | undefined {
    return this.policies.get(name);
  }
}
