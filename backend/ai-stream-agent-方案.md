# Wisora AI 流式 Agent / 大模型对话 实现方案

> 参考文章：[用 NestJS + LangChain + RxJS 打造可扩展的 AI 流式 Agent](https://juejin.cn/post/7619250910057824282)  
> 本方案沿用其核心思想（SSE + Generator + Agent Loop + Tool），但针对 wisora 现有代码做了适配与若干加固。

---

## 〇、先说结论

文章的三层拆分是对的，但直接搬进 wisora 会踩 4 个坑：

| # | 问题                                                                | 影响           | 本方案处理                                 |
| - | ----------------------------------------------------------------- | ------------ | ------------------------------------- |
| 1 | 全局 `ResponseInterceptor` 会把 SSE 包成 `{code:200,msg:'ok',data:...}` | **SSE 直接失效** | 加 `@SkipResponse()` 装饰器，拦截器按元数据放行     |
| 2 | 全局 `HttpExceptionFilter` 把错误转成 JSON                               | 流中途报错无法告知前端  | 流内部 try/catch，以 `error` 事件形式下发        |
| 3 | `EventSource` 不支持 `Authorization` 头，只能 GET                        | 鉴权与长上下文传参困难  | 一次性 ticket（Redis，30s）+ 前端用 `fetch` 读流 |
| 4 | `while(true)` 没有上限                                                | 工具调用死循环烧钱    | `maxIterations` + 工具超时 + 单请求 token 预算 |

另一个关键取舍：**不要绑定 OpenAI 官方**。用 `ChatOpenAI` + `configuration.baseURL` 即可通吃 DeepSeek / 通义 / 豆包 / Kimi / 智谱等所有 OpenAI 兼容模型，换模型只改环境变量。

---

## 一、技术选型

| 层    | 选型                                                        | 理由                                                    |
| ---- | --------------------------------------------------------- | ----------------------------------------------------- |
| 传输   | **SSE**（`text/event-stream`）                              | Agent 是单向推送，比 WebSocket 简单得多，自带断线重连，走 HTTP 无额外网关配置    |
| 编排   | **LangChain JS**（`@langchain/core` + `@langchain/openai`） | 工具调用分片拼接、消息类型、多模型适配这些脏活已封装，比手写省 300 行                 |
| 流式   | **AsyncGenerator 生产 + RxJS 分发**                           | Generator 负责"生成"，RxJS 的 `Observable` 对接 NestJS `@Sse` |
| 参数校验 | **zod**（必须 v3）                                            | LangChain 工具 schema 目前只支持 zod v3，装 v4 会炸              |
| 短期记忆 | **Redis**（已有 `RedisService`）                              | 会话上下文缓存 + 中断信号 + 流式 ticket                            |
| 长期记忆 | **PostgreSQL + Prisma**                                   | 会话与消息持久化，支持历史回看                                       |

> 备选：如果团队不想引入 LangChain（依赖较重），可换成 `openai` SDK + 手写 tool loop，见文末「轻量化变体」。

### 依赖

```bash
pnpm add @langchain/core @langchain/openai zod@^3.23.8
pnpm add -D @types/node   # 已有
```

> ⚠️ 必须锁 `zod@^3`。`@langchain/core@0.3.x` 与 zod v4 不兼容。

### 环境变量（`.env`）

```bash
# DeepSeek（当前项目实际使用）
OPENAI_API_KEY=sk-xxx                  # 到 DeepSeek 控制台申请
OPENAI_BASE_URL=https://api.deepseek.com  # 注意：不要加 /v1，SDK 会自动补 /chat/completions

# 指定具体模型，用平台给的模型名原样填
#   deepseek-v4-flash               快、便宜，适合简单问答与工具调用
#   deepseek-v4-pro                 强推理，适合复杂任务，贵且慢
#   deepseek-v4-flash-vision-exp    多模态实验版，不稳定，勿用于生产
CHAT_MODEL_NAME=deepseek-v4-flash

# Anthropic 兼容入口（同一份 key，给 Claude 系客户端用）
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic

# 采样温度，常见取值 0~1（部分厂商支持到 2）：越低越确定，越高越发散
#   0 ~ 0.3    工具调用、结构化抽取、分类   ← Agent 场景推荐
#   0.3 ~ 0.7  日常问答、多轮对话
#   0.7 ~ 1.0  创意写作、头脑风暴
# 注意：temperature=0 也不保证逐字可复现（浮点与批处理存在非确定性）
CHAT_MODEL_TEMPERATURE=0.3

# 单次模型请求的超时上限（毫秒），超时即中断并抛错，防止连接挂死占资源
#   普通对话       120000（2 分钟）够用
#   推理模型       建议 300000，DeepSeek-R1 / QwQ 深度推理常超 2 分钟
#   与心跳 15s 是两回事：心跳防代理掐连接，这个防后端挂死
#   部署注意：Nginx 的 proxy_read_timeout 必须大于此值，否则网关先断
CHAT_STREAM_TIMEOUT_MS=120000
```



---

## 二、架构总览

```
┌──────────────────── 前端 (React 19) ─────────────────────┐
│  fetch + ReadableStream 解析 SSE → zustand 增量渲染        │
└────────────────────────┬─────────────────────────────────┘
                         │ GET /api/ai/chat/stream?ticket=xxx
┌────────────────────────▼─────────────────────────────────┐
│  AiController   @Sse + @SkipResponse + ticket 鉴权         │  ← 只负责协议
├──────────────────────────────────────────────────────────┤
│  AiService      AsyncGenerator + Agent Loop               │  ← 只负责编排
│    ├─ iterate   : while (iter < maxIterations)            │
│    ├─ stream    : yield token / reasoning                 │
│    ├─ dispatch  : 命中 tool_calls → 执行 → 回填 ToolMessage │
│    └─ guard     : 超时 / 中断 / token 预算                 │
├──────────────────────────────────────────────────────────┤
│  ToolRegistry   zod schema + 动态注册 + 权限/超时           │  ← AI 的"手"
├──────────────────────────────────────────────────────────┤
│  Memory         Redis(短期热缓存) + Prisma(长期持久化)      │
├──────────────────────────────────────────────────────────┤
│  LlmProvider    ChatOpenAI(baseURL) —— 模型可替换          │
└──────────────────────────────────────────────────────────┘
```

**数据流**：用户提问 → 落库 → 拉历史 → Agent Loop（LLM 流式 → 有文本就 yield → 有 tool_call 就执行并回填 → 再问 LLM）→ 无 tool_call 则结束 → 完整消息落库。

---

## 三、SSE 事件协议设计

不要用裸字符串，统一 JSON 信封，前端才能区分"正文""工具调用""报错"。

```ts
// src/ai/types/stream-event.ts
export type StreamEvent =
  | { type: 'start'; conversationId: string; messageId: string }
  | { type: 'token'; content: string }          // 正文增量
  | { type: 'reasoning'; content: string }      // 思维链（DeepSeek-R1 等）
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; name: string; ok: boolean; result: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'done'; finishReason: string; usage?: Record<string, number> };
```

事件名固定用 `message`，靠 `type` 字段区分；再加一个 `ping` 心跳事件保活。

---

## 四、目录结构

```
src/ai/
├── ai.module.ts
├── ai.controller.ts              # @Sse 流式接口 + 会话 CRUD
├── ai.service.ts                 # Agent Loop（核心）
├── dto/
│   └── chat.dto.ts
├── llm/
│   └── llm.provider.ts           # CHAT_MODEL Provider，模型可替换
├── tools/
│   ├── tool.registry.ts          # 注册表：鉴权/超时/重试
│   ├── user-info.tool.ts         # 示例：查当前用户资料
│   └── index.ts
├── memory/
│   └── conversation.repository.ts # Redis 热缓存 + Prisma 持久化
├── guards/
│   └── stream-ticket.guard.ts    # SSE 一次性票据鉴权
├── decorators/
│   └── skip-response.decorator.ts
└── types/
    └── stream-event.ts
```

---

## 五、关键代码

### 5.1 先拆坑：让 SSE 绕过全局响应包装

```ts
// src/ai/decorators/skip-response.decorator.ts
import { SetMetadata } from '@nestjs/common';
export const SKIP_RESPONSE_KEY = 'skipResponse';
export const SkipResponse = () => SetMetadata(SKIP_RESPONSE_KEY, true);
```

```ts
// src/common/interceptors/response.interceptor.ts（改造后）
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SKIP_RESPONSE_KEY } from '../../ai/decorators/skip-response.decorator';

@Injectable()
export class ResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // SSE / 文件下载 / 健康检查等场景原样透出
    if (skip) return next.handle();

    return next.handle().pipe(
      map((data) => (data && data.__raw ? data : { code: 200, msg: 'ok', data })),
    );
  }
}
```

> `Reflector` 来自 `@nestjs/core`，无需新增依赖。用元数据判断而非判断 `Content-Type`，因为 Nest 的 SSE 响应头是在拦截器之后才写入的。

### 5.2 模型层：Provider 解耦（可换任意 OpenAI 兼容模型）

```ts
// src/ai/llm/llm.provider.ts
import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';

export const CHAT_MODEL = 'CHAT_MODEL';

export const chatModelProvider: Provider = {
  provide: CHAT_MODEL,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new ChatOpenAI({
      model: config.get<string>('CHAT_MODEL_NAME') ?? 'deepseek-chat',
      apiKey: config.get<string>('OPENAI_API_KEY'),
      temperature: Number(config.get('CHAT_MODEL_TEMPERATURE') ?? 0.3),
      streaming: true,
      maxRetries: 1,
      timeout: Number(config.get('CHAT_STREAM_TIMEOUT_MS') ?? 120_000),
      configuration: {
        baseURL: config.get<string>('OPENAI_BASE_URL'),
      },
    }),
};
```

### 5.3 工具层：注册表 + zod 参数

```ts
// src/ai/tools/user-info.tool.ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const queryUserArgsSchema = z.object({
  keyword: z.string().describe('邮箱或昵称关键词'),
});

// 工厂函数：把 Nest 的 Service 注入进工具
export function createQueryUserTool(userService: { findByKeyword(k: string): Promise<any> }) {
  return tool(
    async ({ keyword }) => {
      const user = await userService.findByKeyword(keyword);
      if (!user) return JSON.stringify({ found: false });
      return JSON.stringify({
        found: true,
        id: user.id,
        email: user.email,
        nickname: user.nickname,
      });
    },
    {
      name: 'query_user',
      description: '按邮箱或昵称关键词查询用户资料，用于回答与用户相关的问题',
      schema: queryUserArgsSchema,
    },
  );
}
```

```ts
// src/ai/tools/tool.registry.ts
import { Injectable } from '@nestjs/common';
import { StructuredToolInterface } from '@langchain/core/tools';

export interface ToolPolicy {
  timeoutMs: number;   // 单次执行超时
  retries: number;     // 失败重试
  roles?: string[];    // 允许调用的角色（权限控制）
}

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

  list() { return [...this.tools.values()]; }
  get(name: string) { return this.tools.get(name); }
  policy(name: string) { return this.policies.get(name); }
}
```

> 工具用**工厂函数**创建，才能在工具内部使用 Nest 依赖注入的 Service（Prisma、Redis 等）。这是文章没提但生产必踩的点。

### 5.4 核心：Agent Service（AsyncGenerator + Agent Loop）

```ts
// src/ai/ai.service.ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AIMessageChunk, BaseMessage, HumanMessage, SystemMessage, ToolMessage,
} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { Observable } from 'rxjs';
import { MessageEvent } from '@nestjs/common'; // 实际从 '@nestjs/common' 导入 Sse 类型
import type { StreamEvent } from './types/stream-event';
import { ToolRegistry } from './tools/tool.registry';

const MAX_ITERATIONS = 8;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    @Inject('CHAT_MODEL') private readonly model: ChatOpenAI,
    private readonly tools: ToolRegistry,
  ) {}

  /** 把内部事件流桥接成 NestJS @Sse 需要的 Observable<MessageEvent> */
  toSse(gen: AsyncGenerator<StreamEvent>): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      let cancelled = false;

      // 每 15s 一个注释行，防代理掐连接
      const heartbeat = setInterval(() => {
        subscriber.next({ data: ':ping' } as MessageEvent);
      }, 15_000);

      (async () => {
        try {
          for await (const ev of gen) {
            if (cancelled) break;
            subscriber.next({ data: JSON.stringify(ev) } as MessageEvent);
          }
          if (!cancelled) subscriber.complete();
        } catch (err) {
          this.logger.error(`stream failed: ${err?.message}`, err?.stack);
          subscriber.next({
            data: JSON.stringify({
              type: 'error',
              code: 'STREAM_FAILED',
              message: err?.message ?? '生成失败',
            }),
          } as MessageEvent);
          subscriber.complete();   // 注意：用 complete 而非 error，避免全局过滤器污染
        } finally {
          clearInterval(heartbeat);
        }
      })();

      // 客户端断开时的清理（Nest 在连接关闭时会 unsubscribe）
      return () => {
        cancelled = true;
        clearInterval(heartbeat);
        gen.return?.(undefined);
      };
    });
  }

  /** Agent Loop：推理 → 行动 → 观察 → 再推理 */
  async *runAgent(params: {
    question: string;
    history?: BaseMessage[];
    systemPrompt?: string;
    signal?: AbortSignal;
  }): AsyncGenerator<StreamEvent> {
    const { question, history = [], systemPrompt, signal } = params;

    const messages: BaseMessage[] = [
      new SystemMessage(
        systemPrompt ??
          '你是 Wisora 的智能助手。可以使用工具获取信息。用中文回答，简洁准确。',
      ),
      ...history,
      new HumanMessage(question),
    ];

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      if (signal?.aborted) {
        yield { type: 'done', finishReason: 'aborted' };
        return;
      }

      let full: AIMessageChunk | null = null;

      const stream = await this.model.stream(messages, { signal });

      for await (const chunk of stream) {
        full = full ? full.concat(chunk) : chunk;

        const text = this.toText(chunk.content);
        if (text) yield { type: 'token', content: text };

        // 思维链（DeepSeek-R1 / QwQ 等）
        const reasoning = (chunk.additional_kwargs as any)?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning) {
          yield { type: 'reasoning', content: reasoning };
        }
      }

      if (!full) break;
      messages.push(full);

      const toolCalls = full.tool_calls ?? [];
      if (toolCalls.length === 0) {
        yield { type: 'done', finishReason: 'stop' };
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

        const result = await this.invokeTool(call.name, call.args);

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

    yield {
      type: 'error',
      code: 'MAX_ITERATIONS',
      message: `工具调用超过 ${MAX_ITERATIONS} 轮，已强制结束`,
    };
    yield { type: 'done', finishReason: 'max_iterations' };
  }

  /** 带超时与重试的工具执行 */
  private async invokeTool(
    name: string,
    args: unknown,
  ): Promise<{ ok: boolean; output: string }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `未注册的工具：${name}` };
    }
    const policy = this.tools.policy(name);
    const timeoutMs = policy?.timeoutMs ?? 15_000;
    const retries = policy?.retries ?? 1;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const output = await Promise.race([
          tool.invoke(args as any),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('tool timeout')), timeoutMs),
          ),
        ]);
        return { ok: true, output: String(output) };
      } catch (err) {
        if (attempt === retries) {
          this.logger.warn(`tool ${name} failed: ${err?.message}`);
          return { ok: false, output: `工具执行失败：${err?.message}` };
        }
      }
    }
    return { ok: false, output: '工具执行失败' };
  }

  private toText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (c?.type === 'text' ? (c.text ?? '') : ''))
        .join('');
    }
    return '';
  }
}
```

### 5.5 Controller：SSE 接口 + ticket 鉴权

因为 `EventSource` 不能带请求头，用**一次性 ticket** 代替 JWT：

```ts
// src/ai/guards/stream-ticket.guard.ts
import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';

@Injectable()
export class StreamTicketGuard implements CanActivate {
  constructor(private readonly redis: RedisService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const url = new URL(req.url, 'http://localhost');
    const ticket = url.searchParams.get('ticket');
    if (!ticket) throw new UnauthorizedException('缺少 ticket');

    const userId = await this.redis.getClient().get(`ai:ticket:${ticket}`);
    if (!userId) throw new UnauthorizedException('ticket 无效或已过期');

    // ticket 一次性，取完即焚
    await this.redis.getClient().del(`ai:ticket:${ticket}`);
    (req as any).userId = userId;
    return true;
  }
}
```

```ts
// src/ai/ai.controller.ts
import { Controller, Sse, Post, Body, Req, UseGuards, Query } from '@nestjs/common';
import { Observable } from 'rxjs';
import { AiService } from './ai.service';
import { SkipResponse } from './decorators/skip-response.decorator';
import { StreamTicketGuard } from './guards/stream-ticket.guard';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  /** 1) 先换票：用 JWT 换取 30 秒有效的一次性 ticket */
  @Post('chat/ticket')
  createTicket(@Req() req: any) {
    const userId = req.user?.sub ?? req.userId;   // 接现有 JWT 中间件
    const ticket = crypto.randomUUID();
    await this.redis.getClient().setex(`ai:ticket:${ticket}`, 30, userId);
    return { ticket };
  }

  /** 2) 再开流 */
  @Sse('chat/stream')
  @SkipResponse()
  @UseGuards(StreamTicketGuard)
  stream(@Query('q') question: string, @Query('conversationId') convId: string) {
    const gen = this.aiService.runAgent({ question, conversationId: convId });
    return this.aiService.toSse(gen);
  }
}
```

### 5.6 会话持久化（Prisma）

```prisma
// prisma/schema.prisma 追加
model Conversation {
  id        String    @id @default(cuid())
  userId    String
  title     String?
  model     String?
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?
  messages  Message[]
  user      User      @relation(fields: [userId], references: [id])

  @@index([userId, updatedAt])
}

model Message {
  id             String   @id @default(cuid())
  conversationId String
  role           String   // system | user | assistant | tool
  content        String
  toolCalls      Json?
  toolCallId     String?
  name           String?
  usage          Json?
  createdAt      DateTime @default(now())
  conversation   Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, createdAt])
}
```

`User` 模型补一行 `conversations Conversation[]`，然后：

```bash
pnpm prisma migrate dev --name add_ai_conversation
pnpm prisma generate
```

**上下文窗口策略**（务必做，否则长对话必爆 token）：Redis 缓存最近 N 条热数据，超出后只取最近 20 条消息 + 对更早内容做一次摘要。

---

## 六、前端对接（React 19）

不要用 `EventSource`（不能带 header、不能 POST）。用 `fetch` 读流并手动解析：

```ts
// wisora-web/src/api/ai-stream.ts
export async function streamChat(
  question: string,
  conversationId: string,
  handlers: {
    onToken: (t: string) => void;
    onToolCall?: (name: string, args: string) => void;
    onDone?: () => void;
    onError?: (msg: string) => void;
  },
  signal?: AbortSignal,
) {
  const ticket = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${getToken()}` },
  }).then((r) => r.json());

  const res = await fetch(
    `${BASE}/ai/chat/stream?ticket=${ticket.data.ticket}` +
      `&q=${encodeURIComponent(question)}&conversationId=${conversationId}`,
    { headers: { Accept: 'text/event-stream' }, signal },
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';

    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const raw = line.slice(5).trim();
      if (!raw || raw.startsWith(':')) continue;   // 心跳

      const ev = JSON.parse(raw);
      if (ev.type === 'token') handlers.onToken(ev.content);
      else if (ev.type === 'tool_call') handlers.onToolCall?.(ev.name, ev.args);
      else if (ev.type === 'error') handlers.onError?.(ev.message);
      else if (ev.type === 'done') handlers.onDone?.();
    }
  }
}
```

zustand store 里把 `onToken` 接到当前消息的字符串累加，配合 `useState` 就能出打字机效果。用户点"停止"时调 `controller.abort()`。

---

## 七、生产化检查清单

**后端**

- [ ] `ResponseInterceptor` 已按 `@SkipResponse` 放行 SSE
- [ ] 流内部异常走 `error` 事件，不抛给全局过滤器
- [ ] `maxIterations` 上限（建议 8）
- [ ] 单工具超时（15s）+ 重试上限
- [ ] 心跳 `ping`（15s）
- [ ] 客户端断开 → `Observable` teardown → `AbortController.abort()`
- [ ] 上下文截断策略（最近 20 条 or 摘要）
- [ ] 按 userId 限流（Redis 令牌桶，例如 10 次/分钟）
- [ ] 记录 token 消耗与耗时（用于成本核算）

**网关 / 部署**

- [ ] Nginx：`proxy_buffering off;` + `proxy_read_timeout 300s;` + `chunked_transfer_encoding on;`
- [ ] 关闭该路由的响应压缩（`gzip off`），否则会被缓冲
- [ ] 若用 HTTP/1.1，注意浏览器同域并发 6 连接上限（HTTP/2 无此问题）

**前端**

- [ ] 用 `fetch` 而非 `EventSource`
- [ ] 断线重连与"重新生成"按钮
- [ ] 工具调用过程可视化（提升信任感）

---

## 八、轻量化变体（不引入 LangChain）

如果觉得 LangChain 太重，可以用 `openai` SDK 手写 loop，依赖只剩 1 个：

```bash
pnpm add openai
```

```ts
const stream = await client.chat.completions.create({
  model: 'deepseek-chat',
  messages,
  tools,                 // 仍用 JSON Schema 描述
  stream: true,
});
for await (const part of stream) {
  const delta = part.choices[0]?.delta;
  if (delta?.content) yield { type: 'token', content: delta.content };
  // 手动累加 delta.tool_calls（index → arguments 字符串拼接）
}
```

代价：工具调用的**分片参数拼接**、多厂商字段差异、消息类型管理都要自己写。工具超过 3 个就不划算了，所以本方案仍推荐 LangChain。

---

## 九、分阶段落地计划

| 阶段 | 内容                                         | 产出                         |
| -- | ------------------------------------------ | -------------------------- |
| P0 | 拦截器改造 + `CHAT_MODEL` Provider + 纯流式对话（无工具） | 能打字机式聊天的 `/ai/chat/stream` |
| P1 | ToolRegistry + 1 个业务工具 + Agent Loop        | 模型能查库并据此回答                 |
| P2 | Prisma 会话持久化 + Redis 上下文缓存 + ticket 鉴权     | 多轮对话、历史回看                  |
| P3 | 中断、限流、token 统计、工具权限                        | 可上线                        |
| P4 | 摘要记忆、多 Agent（Planner/Executor）             | 进阶                         |

---

## 附：与原文的主要差异

| 点    | 原文                          | 本方案                                     |
| ---- | --------------------------- | --------------------------------------- |
| 鉴权   | 未涉及                         | 一次性 ticket（避免 JWT 出现在 URL）              |
| 中断   | 只提了方向                       | `AbortSignal` + Observable teardown 全链路 |
| 异常处理 | `observe.error()`           | 转成 `error` 事件（兼容全局过滤器）                  |
| 循环终止 | `while(true)` + 无工具即 return | `maxIterations` 兜底                      |
| 工具注入 | 直接闭包                        | 工厂函数 + Nest DI                          |
| 心跳   | 无                           | 15s `ping`                              |
| 持久化  | 无                           | Redis + Prisma 双层记忆                     |
