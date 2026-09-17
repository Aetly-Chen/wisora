import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { Observable } from 'rxjs';
import { ChatModelFactory } from './llm/llm.provider';
import { DEFAULT_SYSTEM_PROMPT } from './prompts/system.prompt';
import { ToolRegistry } from './tools/tool.registry';
import type { ToolWithPolicy } from './tools';
import type { StreamEvent } from './types/stream-event';

/** Agent Loop 轮数上限，防止工具调用死循环烧钱 */
const MAX_ITERATIONS = 8;

/** 心跳间隔（毫秒），防代理掐连接 */
const HEARTBEAT_INTERVAL_MS = 15_000;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly models: ChatModelFactory,
    private readonly tools: ToolRegistry,
  ) {}

  /**
   * 把内部 AsyncGenerator<StreamEvent> 桥接成
   * NestJS @Sse 需要的 Observable<MessageEvent>。
   *
   * @param genFactory 接收 AbortSignal 的生成器工厂：signal 会一路透传到
   *                   model.stream()，客户端断开时用来中断请求、停止计费
   *
   * - 每 15s 发一个 `:ping` 注释行心跳
   * - 流内部异常转成 `error` 事件下发（而非 subscriber.error，
   *   避免被全局 HttpExceptionFilter / ResponseInterceptor 污染）
   * - 客户端断开（Nest unsubscribe）→ AbortController.abort() → 中断 LLM
   */
  toSse(
    genFactory: (signal: AbortSignal) => AsyncGenerator<StreamEvent>,
  ): Observable<{ data: string }> {
    return new Observable((subscriber) => {
      let cancelled = false;
      const controller = new AbortController();
      const gen = genFactory(controller.signal);

      const heartbeat = setInterval(() => {
        subscriber.next({ data: ':ping' });
      }, HEARTBEAT_INTERVAL_MS);

      void (async () => {
        try {
          for await (const ev of gen) {
            if (cancelled) break;
            subscriber.next({ data: JSON.stringify(ev) });
          }
          if (!cancelled) subscriber.complete();
        } catch (err) {
          // 客户端主动断开导致的中断属于预期行为，不打 error 也不下发事件
          if (cancelled) return;

          this.logger.error(
            `stream failed: ${(err as Error).message}`,
            (err as Error).stack,
          );
          subscriber.next({
            data: JSON.stringify({
              type: 'error',
              code: 'STREAM_FAILED',
              message: (err as Error).message || '生成失败',
            }),
          });
          // 注意：用 complete 而非 error，避免全局过滤器污染
          subscriber.complete();
        } finally {
          clearInterval(heartbeat);
        }
      })();

      // 客户端断开时的清理（Nest 在连接关闭时会 unsubscribe）
      return () => {
        cancelled = true;
        clearInterval(heartbeat);
        // 关键：中断底层 LLM 请求，否则模型会继续生成并计费
        controller.abort();
        void gen.return?.(undefined);
      };
    });
  }

  /** Agent Loop：推理 → 行动 → 观察 → 再推理 */
  async *runAgent(params: {
    question: string;
    history?: BaseMessage[];
    systemPrompt?: string;
    signal?: AbortSignal;
    /** 本次会话是否允许执行写操作工具 */
    allowWrite?: boolean;
    /**
     * 按请求创建的专属工具（例如带上 userId 过滤的会话类工具）。
     * 与全局注册表里的工具合并后一起绑给模型。
     */
    extraTools?: ToolWithPolicy[];
    /**
     * 本次请求使用的模型名。
     * 未传或不在白名单内时由 ChatModelFactory 回落到默认模型。
     */
    model?: string;
  }): AsyncGenerator<StreamEvent> {
    const {
      question,
      history = [],
      systemPrompt,
      signal,
      allowWrite = false,
      extraTools = [],
      model: requestedModel,
    } = params;

    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt ?? DEFAULT_SYSTEM_PROMPT),
      ...history,
      new HumanMessage(question),
    ];

    // 关键：把注册表里的工具绑给模型，否则 LLM 看不到工具，
    // tool_calls 恒为空，Agent 永远不会调用工具。
    // 全局工具 + 本次请求的专属工具一起绑定。
    const allTools = [...this.tools.list(), ...extraTools.map((t) => t.tool)];
    const baseModel = this.models.get(this.models.resolve(requestedModel));
    const model =
      allTools.length > 0 ? baseModel.bindTools(allTools) : baseModel;

    const startedAt = Date.now();
    // 累计 token 消耗（多轮工具调用需跨轮累加）
    const usage: Record<string, number> = {};

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (signal?.aborted) {
        yield { type: 'done', finishReason: 'aborted', usage };
        return;
      }

      let full: AIMessageChunk | null = null;

      const stream = await model.stream(messages, { signal });

      for await (const chunk of stream) {
        full = full ? full.concat(chunk) : chunk;

        const text = this.toText(chunk.content);
        if (text) yield { type: 'token', content: text };

        // 思维链（DeepSeek-R1 / QwQ 等）
        const reasoning = (chunk.additional_kwargs as Record<string, unknown>)
          ?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'reasoning', content: reasoning };
        }
      }

      if (!full) break;
      messages.push(full);
      this.accumulateUsage(usage, full);

      const toolCalls = full.tool_calls ?? [];
      if (toolCalls.length === 0) {
        this.logRun(startedAt, iter + 1, usage);
        yield { type: 'done', finishReason: 'stop', usage };
        return;
      }

      // 执行工具并把结果作为 ToolMessage 回填
      for (const call of toolCalls) {
        yield {
          type: 'tool_call',
          id: call.id ?? '',
          name: call.name,
          args: JSON.stringify(call.args),
        };

        const result = await this.invokeTool(
          call.name,
          call.args,
          allowWrite,
          extraTools,
        );

        yield {
          type: 'tool_result',
          id: call.id ?? '',
          name: call.name,
          ok: result.ok,
          result: result.output,
        };

        messages.push(
          new ToolMessage({
            content: result.output,
            name: call.name,
            tool_call_id: call.id ?? '',
          }),
        );
      }
    }

    this.logRun(startedAt, MAX_ITERATIONS, usage);
    yield {
      type: 'error',
      code: 'MAX_ITERATIONS',
      message: `工具调用超过 ${MAX_ITERATIONS} 轮，已强制结束`,
    };
    yield { type: 'done', finishReason: 'max_iterations', usage };
  }

  /**
   * 累计 token 消耗。LangChain 不同版本字段位置不同：
   * v1 用 usage_metadata，部分厂商仍放在 response_metadata.token_usage。
   */
  private accumulateUsage(
    usage: Record<string, number>,
    chunk: AIMessageChunk,
  ): void {
    const candidates: Array<Record<string, unknown> | undefined> = [
      (chunk as unknown as { usage_metadata?: Record<string, unknown> })
        .usage_metadata,
      (
        chunk as unknown as {
          response_metadata?: { token_usage?: Record<string, unknown> };
        }
      ).response_metadata?.token_usage,
    ];

    for (const source of candidates) {
      if (!source) continue;
      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'number') {
          usage[key] = (usage[key] ?? 0) + value;
        }
      }
    }
  }

  /** 打印单次请求的耗时与 token 消耗，用于成本核算 */
  private logRun(
    startedAt: number,
    iterations: number,
    usage: Record<string, number>,
  ): void {
    const total = usage.total_tokens ?? usage.totalTokens;
    this.logger.log(
      `chat finished in ${Date.now() - startedAt}ms, iterations=${iterations}` +
        (total === undefined ? '' : `, tokens=${total}`) +
        (Object.keys(usage).length ? ` usage=${JSON.stringify(usage)}` : ''),
    );
  }

  /**
   * 带授权校验、超时与重试的工具执行。
   *
   * @param allowWrite 本次会话是否允许写操作（由客户端换票时声明）
   */
  private invokeTool(
    name: string,
    args: unknown,
    allowWrite: boolean,
    extraTools: ToolWithPolicy[] = [],
  ): Promise<{ ok: boolean; output: string }> {
    // 优先在本次请求的专属工具里找，找不到再回退到全局注册表
    const extra = extraTools.find((t) => t.tool.name === name);
    const tool = extra?.tool ?? this.tools.get(name);
    const policy = extra ? extra.policy : this.tools.policy(name);
    if (!tool) {
      return Promise.resolve({ ok: false, output: `未注册的工具：${name}` });
    }

    // 写操作必须获得本次会话的显式授权，否则不执行，只告知模型
    if (policy?.write && !allowWrite) {
      this.logger.warn(`blocked write tool ${name}: 未获得写操作授权`);
      return Promise.resolve({
        ok: false,
        output:
          `工具 ${name} 属于写操作，当前会话未获得用户授权，已阻止执行。` +
          '请告知用户：需要开启"允许 AI 修改数据"后才可以执行此操作。',
      });
    }

    return this.executeWithRetry(tool, name, args, policy);
  }

  /** 执行工具并套上超时 / 重试策略 */
  private async executeWithRetry(
    tool: { invoke: (arg: unknown) => Promise<unknown> },
    name: string,
    args: unknown,
    policy?: { timeoutMs?: number; retries?: number },
  ): Promise<{ ok: boolean; output: string }> {
    const timeoutMs = policy?.timeoutMs ?? 15_000;
    const retries = policy?.retries ?? 1;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const output: unknown = await Promise.race([
          tool.invoke(args),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('tool timeout')), timeoutMs),
          ),
        ]);
        return { ok: true, output: String(output) };
      } catch (err) {
        if (attempt === retries) {
          this.logger.warn(`tool ${name} failed: ${(err as Error).message}`);
          return {
            ok: false,
            output: `工具执行失败：${(err as Error).message}`,
          };
        }
      }
    }
    return { ok: false, output: '工具执行失败' };
  }

  /** 兼容 string 与分片数组两种 content 形状 */
  private toText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: { type?: string; text?: string }) =>
          c?.type === 'text' ? (c.text ?? '') : '',
        )
        .join('');
    }
    return '';
  }
}
