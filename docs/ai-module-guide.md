# Wisora AI 模块前后端对照详解

> 覆盖后端 `backend/src/ai`（14 文件 / 1329 行）与前端 `frontend/src` 的 AI 相关代码（4 文件 / 1119 行）。
> 目标：一份文档看懂整条链路，每个环节都能定位到具体文件与设计原因。

---

## 目录

1. [模块定位与一句话架构](#1-模块定位与一句话架构)
2. [前后端文件对照表](#2-前后端文件对照表)
3. [全链路数据流](#3-全链路数据流)
4. [SSE 鉴权：一次性票据](#4-sse-鉴权一次性票据)
5. [SSE 事件协议](#5-sse-事件协议)
6. [Agent Loop：推理 → 行动 → 观察](#6-agent-loop推理--行动--观察)
7. [工具系统](#7-工具系统)
8. [记忆系统：Redis + PostgreSQL 双层](#8-记忆系统redis--postgresql-双层)
9. [安全设计](#9-安全设计)
10. [前端状态管理](#10-前端状态管理)
11. [踩过的坑（代码注释里的血泪）](#11-踩过的坑代码注释里的血泪)
12. [扩展指南](#12-扩展指南)

---

## 1. 模块定位与一句话架构

Wisora 的 AI 模块是一个**带工具调用能力的流式对话 Agent**，不是简单的"转发 LLM 接口"。

```
用户输入 → 换票 → 开 SSE 流 → 模型流式生成
                              ↓ 需要工具？
                              是 → 执行工具 → 结果回填 → 再推理（最多 8 轮）
                              否 → 结束
                   全程 token 增量下发，前端逐字渲染
```

| 维度 | 选型 |
| --- | --- |
| 后端框架 | NestJS 11 |
| Agent 编排 | LangChain Core 1.x（`bindTools` / `model.stream`） |
| 模型接入 | `@langchain/openai` 的 `ChatOpenAI` + 自定义 `baseURL` |
| 当前模型 | DeepSeek（`deepseek-v4-flash`） |
| 传输协议 | SSE（Server-Sent Events） |
| 持久化 | PostgreSQL（Prisma 7） |
| 缓存 / 限流 / 票据 | Redis |
| 前端状态 | zustand |

**关键设计取舍：模型走 OpenAI 兼容协议**（`llm.provider.ts`），换厂商只改环境变量，不动代码。

---

## 2. 前后端文件对照表

### 后端 `backend/src/ai/`

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `ai.module.ts` | 47 | 模块装配；`onModuleInit` 时注册全局工具 |
| `ai.controller.ts` | 288 | 5 个 HTTP 入口（换票 / 开流 / 会话 CRUD） |
| `ai.service.ts` | 335 | **核心**：SSE 桥接 + Agent Loop + 工具执行 |
| `types/stream-event.ts` | 22 | SSE 事件协议单一真源 |
| `llm/llm.provider.ts` | 26 | 模型实例工厂，环境变量驱动 |
| `guards/stream-ticket.guard.ts` | 61 | 一次性票据校验与焚毁 |
| `decorators/skip-response.decorator.ts` | 16 | 让 SSE 绕过全局响应包装 |
| `memory/conversation.repository.ts` | 154 | 双层记忆 + IDOR 归属校验 |
| `tools/tool.registry.ts` | 53 | 工具注册表与执行策略 |
| `tools/index.ts` | ~70 | 工具装配：全局 vs 按请求 |
| `tools/user-info.tool.ts` | 39 | 示例全局工具 `query_user` |
| `tools/conversation.tool.ts` | ~120 | 按请求创建的会话类工具（含写操作） |
| `dto/chat.dto.ts` | 23 | 换票接口入参校验 |
| `rate-limit.service.ts` | ~55 | 按 userId 固定窗口限流 |

### 前端 `frontend/src/`

| 文件 | 行数 | 职责 | 对应后端 |
| --- | --- | --- | --- |
| `types/agent.ts` | 73 | 事件协议 / 消息 / 会话类型 | `types/stream-event.ts` |
| `request/ai-stream.ts` | 195 | 换票、会话 CRUD、SSE 解析 | `ai.controller.ts` |
| `stores/useAgentStore.ts` | 306 | 对话状态、流式累加、中断 | `ai.service.ts` 的事件流 |
| `pages/agent/index.tsx` | 545 | 页面布局、侧边栏、输入框 | — |

### 一一对应关系

| 关注点 | 后端 | 前端 |
| --- | --- | --- |
| 事件类型定义 | `types/stream-event.ts` | `types/agent.ts` 的 `StreamEvent`（**必须手动保持同步**） |
| 换票 | `POST /ai/chat/ticket` | `createChatTicket()` |
| 开流 | `GET /ai/chat/stream` | `streamChat()` |
| 会话列表 | `GET /ai/conversations` | `listConversations()` |
| 历史回显 | `GET /ai/conversations/:id/messages` | `getConversationMessages()` |
| 软删除 | `DELETE /ai/conversations/:id` | `deleteConversation()` |

---

## 3. 全链路数据流

```
┌─ 前端 ──────────────────────────────────────────────────────────┐
│                                                                 │
│  InputBar 提交                                                   │
│      ↓                                                          │
│  useAgentStore.send(text)                                       │
│      ├─ new AbortController()                                   │
│      ├─ 追加 user 消息 + 空的 assistant 占位消息                  │
│      └─ streamChat({ question, conversationId, signal, handlers })│
│             ↓                                                   │
│         createChatTicket()  ──── axios ────┐                    │
│             ↓                              │                    │
│         fetch(/ai/chat/stream?ticket=…) ───┼──┐                 │
│             ↓                              │  │                 │
│         ReadableStream 逐块读 → 按 \n\n 切帧 │  │                 │
│             ↓                              │  │                 │
│         switch (ev.type) → 回调 handlers    │  │                 │
│             ↓                              │  │                 │
│         onToken → 只更新最后一条助手消息      │  │                 │
└─────────────────────────────────────────────┼──┼─────────────────┘
                                             ↓  ↓
┌─ 后端 ──────────────────────────────────────────────────────────┐
│  POST /ai/chat/ticket                                           │
│      ├─ 校验 JWT → userId                                        │
│      ├─ 限流检查（10 次 / 60 秒）                                 │
│      └─ randomUUID() → Redis SETEX ai:ticket:<uuid> 30s          │
│                                                                 │
│  GET /ai/chat/stream?ticket=…&q=…&conversationId=…              │
│      ├─ StreamTicketGuard：取 ticket → 校验 → 立即 DEL（一次性）   │
│      ├─ 限流检查                                                 │
│      ├─ assertOwned(userId, conversationId) ← IDOR 防护          │
│      ├─ loadHistory(conversationId)                             │
│      ├─ createUserScopedTools(prisma, userId)                   │
│      └─ aiService.toSse(signal => chatStream(...))              │
│             ↓                                                   │
│         chatStream：建会话 → 存 user 消息 → yield start           │
│             ↓                                                   │
│         runAgent：                                              │
│           ┌──────────────────────────────────────┐              │
│           │ model.stream(messages, { signal })    │              │
│           │   → yield token / reasoning          │              │
│           │ tool_calls?                          │              │
│           │   是 → yield tool_call                │              │
│           │        invokeTool()（授权+超时+重试）  │              │
│           │        yield tool_result              │              │
│           │        push ToolMessage → 继续循环    │              │
│           │   否 → yield done（先落库再发）        │              │
│           └──────────────────────────────────────┘              │
│             （最多 8 轮）                                         │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. SSE 鉴权：一次性票据

### 为什么需要

原生 `EventSource` **不能携带 `Authorization` 头**。若把 JWT 直接拼在 URL 上：

- JWT 会进入浏览器历史、服务器访问日志、CDN 日志
- JWT 有效期长（本项目的 access token 显然远大于 30 秒），泄露窗口大

### 方案：两段式

```
① POST /ai/chat/ticket  （带 Authorization 头，axios）
      → 返回 { ticket: "<uuid>", allowWrite }
      
② GET /ai/chat/stream?ticket=<uuid>&q=...  （fetch / SSE）
      → 守卫校验后立刻 DEL，一次性
```

### 后端实现要点（`ai.controller.ts` + `guards/stream-ticket.guard.ts`）

```ts
const TICKET_TTL_SECONDS = 30;

// 换票：ticket 存的是 JSON，除 userId 还带写操作授权
const payload: TicketPayload = { userId, allowWrite: body?.allowWrite === true };
await redis.setex(`ai:ticket:${ticket}`, TICKET_TTL_SECONDS, JSON.stringify(payload));

// 守卫：取出即焚
const raw = await redis.get(`ai:ticket:${ticket}`);
if (!raw) throw new UnauthorizedException('ticket 无效或已过期');
await redis.del(`ai:ticket:${ticket}`);
```

设计细节：

- **30 秒 TTL**：够前端建立连接，又足够短，杜绝长期重放
- **取完即焚**：同一个 ticket 无法开两次流
- **ticket 携带授权范围**：`allowWrite` 随票走，客户端在换票时声明"本次会话是否允许 AI 改数据"
- **向后兼容**：守卫兼容早期"纯字符串只存 userId"的旧 ticket

### 前端对应（`request/ai-stream.ts`）

```ts
const { ticket } = await createChatTicket();
const qs = new URLSearchParams({ ticket, q: question });
const res = await fetch(`${BASE}/ai/chat/stream?${qs}`, {
  headers: { Accept: 'text/event-stream', Authorization: `Bearer ${getToken() ?? ''}` },
  signal,
});
```

注意：请求里**依然带了 Authorization**，但那只是给网关 / 代理层看的；真正的身份校验在后端由 ticket 完成。

---

## 5. SSE 事件协议

后端 `types/stream-event.ts` 与前端 `types/agent.ts` 定义了**同一套联合类型**，是前后端的契约。

| type | 载荷 | 时机 | 前端处理 |
| --- | --- | --- | --- |
| `start` | `conversationId`, `messageId` | 流开始，会话已确定 | 记下 `conversationId`（下一轮带上才能接续） |
| `token` | `content` | 正文增量 | 追加到最后一条助手消息 |
| `reasoning` | `content` | 思维链（DeepSeek-R1 / QwQ） | 追加到该消息的 `reasoning` 字段 |
| `tool_call` | `id`, `name`, `args` | 模型决定调用工具 | 插入一条 `role:'tool'` 消息，`toolStatus:'calling'` |
| `tool_result` | `id`, `name`, `ok`, `result` | 工具执行完 | 更新对应消息，`toolStatus: ok?'done':'failed'` |
| `error` | `code`, `message` | 出错 | 写入 `error` 状态并提示 |
| `done` | `finishReason`, `usage?` | 结束 | 停 loading，展示 token 消耗，刷新会话列表 |

另有 `:ping` —— **心跳注释行，不属于协议**，前端必须跳过：

```ts
if (!raw || raw.startsWith(':')) continue;
```

心跳每 15 秒发一次（`HEARTBEAT_INTERVAL_MS`），防止代理 / 网关掐掉长连接。

---

## 6. Agent Loop：推理 → 行动 → 观察

`ai.service.ts` 的 `runAgent()` 是整个模块的心脏。

### 轮次上限

```ts
const MAX_ITERATIONS = 8;   // 防止工具调用死循环烧钱
```

超出后发 `error`（`code: 'MAX_ITERATIONS'`）+ `done`（`finishReason: 'max_iterations'`）。

### 主循环

```ts
for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
  if (signal?.aborted) { yield { type: 'done', finishReason: 'aborted' }; return; }

  const stream = await model.stream(messages, { signal });
  for await (const chunk of stream) {
    full = full ? full.concat(chunk) : chunk;
    const text = this.toText(chunk.content);
    if (text) yield { type: 'token', content: text };          // 正文增量
    const reasoning = chunk.additional_kwargs?.reasoning_content;
    if (reasoning) yield { type: 'reasoning', content: reasoning };
  }

  messages.push(full);
  this.accumulateUsage(usage, full);

  const toolCalls = full.tool_calls ?? [];
  if (toolCalls.length === 0) {
    yield { type: 'done', finishReason: 'stop', usage };
    return;
  }

  for (const call of toolCalls) {
    yield { type: 'tool_call', ... };
    const result = await this.invokeTool(call.name, call.args, allowWrite, extraTools);
    yield { type: 'tool_result', ... };
    messages.push(new ToolMessage({ content: result.output, tool_call_id: call.id }));
  }
  // 带着工具结果回到循环开头，让模型再推理
}
```

### 关键一步：绑定工具

```ts
const allTools = [...this.tools.list(), ...extraTools.map(t => t.tool)];
const model = allTools.length > 0 ? this.model.bindTools(allTools) : this.model;
```

**不 `bindTools`，模型根本看不到工具**，`tool_calls` 恒为空，Agent 永远不会调用工具 —— 这是最容易踩的坑。

### token 统计的兼容处理

LangChain 各版本、各厂商放 usage 的位置不同，代码里两个来源都取：

```ts
usage_metadata                    // LangChain v1
response_metadata.token_usage     // 部分厂商仍在用
```

多轮工具调用需跨轮累加，所以 `usage` 定义在循环外。

### 流式中断

```ts
// toSse 的 teardown
return () => {
  cancelled = true;
  clearInterval(heartbeat);
  controller.abort();      // 关键：中断底层 LLM 请求，否则模型继续生成并计费
  void gen.return?.(undefined);
};
```

前端点"停止"→ `AbortController.abort()` → fetch 断开 → Nest unsubscribe → 后端 abort → 模型请求终止。**真正停止计费**，不是前端假装停了。

---

## 7. 工具系统

### 两类工具

| 类型 | 创建时机 | 例子 | 原因 |
| --- | --- | --- | --- |
| **全局** | 应用启动时 | `query_user` | 与具体用户无关，可复用单例 |
| **按请求** | 每次开流 | `list_my_conversations`、`read_my_conversation`、`rename_my_conversation` | 必须闭包注入 `userId` 做数据过滤 |

```ts
// 按请求创建：userId 只有在请求时才拿得到
export function createUserScopedTools(prisma: PrismaService, userId: string) { ... }
```

**这是防越权的关键**：会话类工具如果做成全局单例，Agent 就可能读到甚至改动别人的数据。

### 执行策略（`ToolPolicy`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | 15 000 | 单次执行超时 |
| `retries` | 1 | 失败重试次数；**写操作必须为 0**，避免重复执行 |
| `roles` | — | 角色白名单（预留） |
| `write` | false | 是否为写操作 |

### 写操作授权机制

SSE 是单向的（服务端无法中途问用户），所以授权前置到换票阶段：

```
客户端换票时声明 allowWrite=true
        ↓
写入 ticket payload
        ↓
开流时守卫解出 allowWrite
        ↓
invokeTool 遇到 policy.write 且未授权 → 不执行，
返回"需要授权"的结果 → 由模型转告用户
```

```ts
if (policy?.write && !allowWrite) {
  return { ok: false, output: '工具 X 属于写操作，当前会话未获得用户授权…' };
}
```

这样既保持了 SSE 单向，又让 AI 无法擅自改数据 —— 而且用户是从"AI 的回复"里得知需要授权的，交互自然。

### 现有工具

| 名称 | 类型 | 写操作 | 用途 |
| --- | --- | --- | --- |
| `query_user` | 全局 | 否 | 按邮箱 / 昵称关键词查用户 |
| `list_my_conversations` | 按请求 | 否 | 列出当前用户最近会话 |
| `read_my_conversation` | 按请求 | 否 | 读取某会话历史 |
| `rename_my_conversation` | 按请求 | **是** | 改会话标题 |

---

## 8. 记忆系统：Redis + PostgreSQL 双层

`memory/conversation.repository.ts`

| 层 | 存什么 | TTL | 作用 |
| --- | --- | --- | --- |
| **Redis** | `ai:conv:<id>` → 最近 20 条消息 | 30 分钟 | 短期记忆，多轮对话取历史快 |
| **PostgreSQL** | `Conversation` + `Message` 表 | 永久 | 长期记忆，支持历史回看 |

```ts
const HISTORY_LIMIT = 20;                    // 上下文窗口
const CACHE_TTL_SECONDS = 60 * 30;           // 热缓存 30 分钟
```

读路径：Redis 命中直接返回；miss 则回源 Prisma 并回填缓存。写路径：写库后写穿到 Redis。

**Redis 挂了不影响主流程** —— 所有缓存操作都包在 try/catch 里，失败只打日志，降级直查数据库。

### 上下文组装

```ts
// 只取 user / assistant 轮次；tool 轮次依赖 tool_calls 配对，跳过
const history = params.history
  .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
  .map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content));
```

---

## 9. 安全设计

### 9.1 IDOR 防护（最重要）

`/ai/chat/stream` **只带 ticket、不带 JWT**，而 `conversationId` 来自 query 参数。若不校验归属：

> 任何登录用户都能传他人的会话 ID —— 既能把对方历史读进 LLM 上下文，也能往对方会话里写消息。

```ts
async assertOwned(userId: string, conversationId: string): Promise<void> {
  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!owned) {
    // 不区分"不存在"和"无权访问"，避免通过错误差异探测他人会话 ID
    throw new HttpException({ code: 404, msg: '会话不存在或无权访问' }, 404);
  }
}
```

统一的错误文案是刻意的 —— 如果"不存在"和"无权访问"返回不同错误，攻击者就能用它探测哪些会话 ID 真实存在。

**凡是接收外部 `conversationId` 的入口都必须先过这一关**（开流、`GET /:id/messages`）。

### 9.2 限流

```ts
const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10;   // 每用户 60 秒 10 次
```

Redis `INCR` + 首次命中设过期。换票和开流**两处都查**，防止刷票绕过。

### 9.3 其他

- **ticket 一次性 + 30 秒**：杜绝重放
- **软删除**：会话 `deletedAt` 标记，所有查询都带 `deletedAt: null`
- **工具按 userId 过滤**：闭包注入，Agent 越不过去
- **审计留痕**：`tool_call` / `tool_result` 都落库，事后可追溯 AI 做过什么

---

## 10. 前端状态管理

`stores/useAgentStore.ts`（zustand）

### 流式更新的性能要点

```ts
// 只更新"最后一条助手消息"，避免整列重渲染
const appendToAssistant = (updater) => {
  set(state => ({
    messages: state.messages.map(m => m.id === assistantId ? { ...m, ...updater(m) } : m)
  }));
};
```

发送时先插入一条**空的 assistant 占位消息**，后续 token 往这里累加。

### 串台防护

```ts
openConversation: async (id) => {
  controller?.abort();      // 切换前必须先中断
  ...
}
```

不中断的话，旧流会继续往已被替换的 `messages` 里追加 token，两条会话的内容混在一起。

### 中断处理

```ts
catch (err) {
  const aborted = err?.name === 'AbortError';
  set({ isStreaming: false, error: aborted ? undefined : err.message });
  if (aborted) {
    // 保留已生成的部分，并标注
    appendToAssistant(m => m.content ? { meta: '（已停止生成）' } : { content: '（已停止生成）' });
  }
}
```

主动中断不算错误，不弹提示，但保留已生成内容。

### 乐观删除

```ts
removeConversation: async (id) => {
  const previous = get().conversations;
  set({ conversations: previous.filter(c => c.id !== id) });   // 先本地移除
  try { await deleteConversation(id); }
  catch { set({ conversations: previous }); }                   // 失败回滚
}
```

### 为什么分 axios 和 fetch

| 用途 | 走什么 | 原因 |
| --- | --- | --- |
| 换票、会话 CRUD | **axios** | 复用项目统一的 token 自动注入 / 401 刷新重放 |
| 开 SSE 流 | **fetch** | axios 基于 XHR，浏览器端拿不到流式增量；只有 `ReadableStream` 能逐块读 |

这是同一层里混用两套 HTTP 客户端的唯一理由。

---

## 11. 踩过的坑（代码注释里的血泪）

### 后端

| 坑 | 正确做法 |
| --- | --- |
| 用 `@Get` 返回 Observable | 必须用 `@Sse`。`@Get` 会让 Nest 只取最后一个值发 JSON，流式数据全丢 |
| 忘了 `bindTools` | 模型看不到工具，`tool_calls` 恒为空，Agent 永不调用工具 |
| 全局响应拦截器包装 SSE | 加 `@SkipResponse()`；且**不能**判断 Content-Type（SSE 响应头在拦截器之后才写入） |
| 流内异常用 `subscriber.error` | 用 `complete` + 下发 `error` 事件，避免被全局 `HttpExceptionFilter` 污染 |
| 先发 `done` 再落库 | **必须先落库再发 done**。否则客户端收到 done 立刻发下一轮，会读到未写入的历史（多轮记忆随机失效） |
| teardown 不 abort | 客户端断开后模型继续生成并计费 |
| 写工具设 retries > 0 | 写操作重试可能造成重复执行，务必设为 0 |

### 前端

| 坑 | 正确做法 |
| --- | --- |
| 把 `:ping` 当数据解析 | 心跳行以 `:` 开头，解析时跳过 |
| 用 `EventSource` 开流 | 它不能带 Authorization 头，也不支持自定义中断；用 fetch + ticket |
| 在组件内部定义组件 | React 会因函数身份变化重挂子树，输入框失焦（一次只能输一个字符）。`InputBar` 必须定义在模块顶层 |
| 切会话不中断旧流 | 两条会话内容串台 |
| 首屏渲染被保护的路由 | `/agent` 需登录；首页也在 `ProtectedRoute` 下 |

---

## 12. 扩展指南

### 加一个只读工具

1. 在 `backend/src/ai/tools/` 新建 `xxx.tool.ts`，用工厂函数（才能注入 `PrismaService`）：

```ts
export function createXxxTool(prisma: PrismaService) {
  return tool(async (args) => { /* ... */ return JSON.stringify(result); },
    { name: 'xxx', description: '…', schema: z.object({ ... }) }
  );
}
```

2. 在 `tools/index.ts` 登记：
   - 与用户无关 → 加进 `registerAllTools`（全局，启动时注册）
   - 需要按用户过滤 → 加进 `createUserScopedTools`（按请求创建，闭包注入 userId）

3. 若会改数据，务必 `policy: { write: true, retries: 0 }`。

### 换模型

只改后端环境变量，代码零改动：

```bash
OPENAI_BASE_URL=https://api.deepseek.com   # 不要加 /v1，SDK 自动补
CHAT_MODEL_NAME=deepseek-v4-flash
OPENAI_API_KEY=sk-...
CHAT_MODEL_TEMPERATURE=0.3
```

### 调参位置

| 参数 | 文件 | 当前值 |
| --- | --- | --- |
| 票据有效期 | `ai.controller.ts` | 30 秒 |
| Agent 轮次上限 | `ai.service.ts` | 8 |
| 心跳间隔 | `ai.service.ts` | 15 秒 |
| 限流 | `rate-limit.service.ts` | 10 次 / 60 秒 |
| 上下文窗口 | `memory/conversation.repository.ts` | 20 条 |
| 缓存 TTL | 同上 | 30 分钟 |
| 工具超时 / 重试 | `tool.registry.ts` | 15 秒 / 1 次 |

### 新增事件类型

1. 改后端 `types/stream-event.ts`
2. **同步改前端 `types/agent.ts`**（两边靠人工保持一致，没有代码生成）
3. 前端在 `streamChat` 的 `switch` 里加分支

---

## 附：待办 / 可改进点

- [ ] 前后端事件类型目前靠人工同步，可考虑用共享包或代码生成消除漂移风险
- [ ] 上下文超窗后直接截断，P4 计划做摘要记忆
- [ ] 限流是固定窗口计数，若要更平滑可换令牌桶或 Lua 脚本
- [ ] `ChatDto` 已定义但换票接口用的是内联类型，未真正启用校验
