# Wisora 核心模块详解：AI 与笔记

> 覆盖 `backend/src/ai`（14 文件 / 1344 行）、`backend/src/notes`（7 文件 / 551 行）
> 与前端对应代码（9 文件 / 2133 行）。
> 目标：一份文档看懂两条链路，每个环节都能定位到具体文件，并解释「为什么这么设计」。

---

## 目录

- [0. 总览](#0-总览)
- [Part I　AI 模块](#part-i-ai-模块)
  - [1.1 全链路数据流](#11-全链路数据流)
  - [1.2 SSE 鉴权：一次性票据](#12-sse-鉴权一次性票据)
  - [1.3 SSE 事件协议](#13-sse-事件协议)
  - [1.4 Agent Loop](#14-agent-loop推理--行动--观察)
  - [1.5 工具系统](#15-工具系统)
  - [1.6 双层记忆](#16-双层记忆redis--postgresql)
  - [1.7 系统提示词](#17-系统提示词决定回答像不像样)
  - [1.8 前端状态管理](#18-前端状态管理与渲染)
  - [1.9 安全设计](#19-安全设计)
- [Part II　笔记模块](#part-ii-笔记模块)
  - [2.1 数据模型](#21-数据模型)
  - [2.2 后端分层](#22-后端分层)
  - [2.3 鉴权：通用 JWT 守卫](#23-鉴权通用-jwt-守卫)
  - [2.4 文件上传](#24-文件上传四道防线)
  - [2.5 附件预览](#25-附件预览为什么必须先取-blob)
  - [2.6 前端：编辑器与自动保存](#26-前端编辑器与自动保存)
  - [2.7 Markdown 渲染与安全](#27-markdown-渲染与安全)
- [Part III　两个模块共享的基础设施](#part-iii-两个模块共享的基础设施)
- [Part IV　踩坑清单](#part-iv-踩坑清单)
- [Part V　扩展与调参](#part-v-扩展与调参)

---

## 0. 总览

Wisora 有两个相对独立、又复用同一套基础设施的业务模块：

| | AI 模块 | 笔记模块 |
| --- | --- | --- |
| 定位 | 带工具调用的**流式对话 Agent** | 类 Notion 的 **Markdown 笔记 + 附件** |
| 传输 | SSE 流式 | 普通 JSON + multipart 上传 |
| 数据 | Conversation / Message | Note / Attachment |
| 外部依赖 | LLM（DeepSeek）、Redis 缓存 | 本地磁盘存储 |
| 前端页面 | `/agent` | `/notes` |

**共享基础设施**：JWT 鉴权、Prisma（`@Global`）、Redis（`@Global`）、
全局响应拦截器与 `@SkipResponse()`、前端 axios 请求层与 zustand。

### 前后端文件对照

**后端**

| AI 模块 | 行数 | 笔记模块 | 行数 |
| --- | --- | --- | --- |
| `ai.controller.ts` | 288 | `notes.controller.ts` | ~50 |
| `ai.service.ts` | 335 | `notes.service.ts` | ~120 |
| `types/stream-event.ts` | 22 | `dto/note.dto.ts` | ~40 |
| `llm/llm.provider.ts` | 26 | `attachments.controller.ts` | ~100 |
| `guards/stream-ticket.guard.ts` | 61 | `attachments.service.ts` | ~160 |
| `memory/conversation.repository.ts` | 154 | `storage.service.ts` | ~80 |
| `tools/*`（4 文件） | ~300 | `notes.module.ts` | ~20 |
| `prompts/system.prompt.ts` | ~30 | | |
| `rate-limit.service.ts` | ~55 | | |
| `ai.module.ts` | ~47 | | |

**前端**

| 文件 | 行数 | 职责 | 对应后端 |
| --- | --- | --- | --- |
| `types/agent.ts` | 73 | 事件协议 / 消息 / 会话类型 | `types/stream-event.ts` |
| `request/ai-stream.ts` | 195 | 换票、会话 CRUD、SSE 解析 | `ai.controller.ts` |
| `stores/useAgentStore.ts` | 306 | 对话状态、流式累加、中断 | `ai.service.ts` 的事件流 |
| `pages/agent/index.tsx` | 545 | 对话界面 | — |
| `types/note.ts` | 27 | 笔记 / 附件 / 保存状态类型 | Prisma 模型 |
| `request/notes.ts` | 78 | 笔记 CRUD、上传、取 Blob | 两个 controller |
| `stores/useNotesStore.ts` | 238 | 列表、防抖保存、附件 | — |
| `pages/notes/index.tsx` | 632 | 笔记界面（列表 + 编辑器） | — |
| `components/MarkdownView.tsx` | 39 | Markdown 渲染（marked + DOMPurify） | — |

---

# Part I　AI 模块

## 1.1 全链路数据流

```
┌─ 前端 ──────────────────────────────────────────────────────────┐
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

## 1.2 SSE 鉴权：一次性票据

### 为什么需要

原生 `EventSource` **不能携带 `Authorization` 头**。若把 JWT 直接拼在 URL 上：

- JWT 会进入浏览器历史、服务器访问日志、CDN 日志
- JWT 有效期远大于 30 秒，泄露窗口很长

### 方案：两段式

```
① POST /ai/chat/ticket  （带 Authorization 头，axios）
      → 返回 { ticket: "<uuid>", allowWrite }

② GET /ai/chat/stream?ticket=<uuid>&q=...  （fetch / SSE）
      → 守卫校验后立刻 DEL，一次性
```

后端要点（`ai.controller.ts` + `guards/stream-ticket.guard.ts`）：

```ts
const TICKET_TTL_SECONDS = 30;

// 换票：ticket 存 JSON，除 userId 还带写操作授权
const payload: TicketPayload = { userId, allowWrite: body?.allowWrite === true };
await redis.setex(`ai:ticket:${ticket}`, TICKET_TTL_SECONDS, JSON.stringify(payload));

// 守卫：取出即焚
const raw = await redis.get(`ai:ticket:${ticket}`);
if (!raw) throw new UnauthorizedException('ticket 无效或已过期');
await redis.del(`ai:ticket:${ticket}`);
```

设计细节：

- **30 秒 TTL**：够建立连接，又足够短，杜绝长期重放
- **取完即焚**：同一个 ticket 无法开两次流
- **票带授权范围**：`allowWrite` 随票走，换票时声明本次会话是否允许 AI 改数据
- **向后兼容**：守卫兼容早期「纯字符串只存 userId」的旧 ticket

前端请求里**依然带了 Authorization**，但那只是给网关 / 代理层看的；真正的身份校验由 ticket 完成。

## 1.3 SSE 事件协议

后端 `types/stream-event.ts` 与前端 `types/agent.ts` 定义了**同一套联合类型**，是前后端的契约。

| type | 载荷 | 时机 | 前端处理 |
| --- | --- | --- | --- |
| `start` | `conversationId`, `messageId` | 流开始，会话已确定 | 记下 `conversationId`（下一轮带上才能接续） |
| `token` | `content` | 正文增量 | 追加到最后一条助手消息 |
| `reasoning` | `content` | 思维链（DeepSeek-R1 / QwQ） | 追加到该消息的 `reasoning` 字段 |
| `tool_call` | `id`, `name`, `args` | 模型决定调用工具 | 插入 `role:'tool'` 消息，`toolStatus:'calling'` |
| `tool_result` | `id`, `name`, `ok`, `result` | 工具执行完 | 更新对应消息，`ok?'done':'failed'` |
| `error` | `code`, `message` | 出错 | 写入 `error` 状态并提示 |
| `done` | `finishReason`, `usage?` | 结束 | 停 loading，展示 token 消耗，刷新会话列表 |

另有 `:ping` —— **心跳注释行，不属于协议**，前端必须跳过：

```ts
if (!raw || raw.startsWith(':')) continue;
```

心跳每 15 秒一次（`HEARTBEAT_INTERVAL_MS`），防止代理 / 网关掐掉长连接。

## 1.4 Agent Loop：推理 → 行动 → 观察

`ai.service.ts` 的 `runAgent()` 是整个模块的心脏。

```ts
const MAX_ITERATIONS = 8;   // 防止工具调用死循环烧钱
```

主循环：

```ts
for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
  if (signal?.aborted) { yield { type: 'done', finishReason: 'aborted' }; return; }

  const stream = await model.stream(messages, { signal });
  for await (const chunk of stream) {
    full = full ? full.concat(chunk) : chunk;
    const text = this.toText(chunk.content);
    if (text) yield { type: 'token', content: text };
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

**关键一步 —— 绑定工具**：

```ts
const allTools = [...this.tools.list(), ...extraTools.map(t => t.tool)];
const model = allTools.length > 0 ? this.model.bindTools(allTools) : this.model;
```

不 `bindTools`，模型根本看不到工具，`tool_calls` 恒为空，Agent 永远不会调用工具。

**token 统计兼容**：LangChain 各版本字段位置不同，两个来源都取：

```ts
usage_metadata                    // LangChain v1
response_metadata.token_usage     // 部分厂商仍在用
```

**流式中断**：

```ts
return () => {
  cancelled = true;
  clearInterval(heartbeat);
  controller.abort();      // 中断底层 LLM 请求，否则模型继续生成并计费
  void gen.return?.(undefined);
};
```

前端点「停止」→ `abort()` → fetch 断开 → Nest unsubscribe → 后端 abort → 模型请求终止。**真正停止计费**，不是前端假装停了。

## 1.5 工具系统

### 两类工具

| 类型 | 创建时机 | 例子 | 原因 |
| --- | --- | --- | --- |
| **全局** | 应用启动时 | `query_user` | 与具体用户无关，可复用单例 |
| **按请求** | 每次开流 | `list_my_conversations`、`read_my_conversation`、`rename_my_conversation` | 必须闭包注入 `userId` 做数据过滤 |

```ts
// 按请求创建：userId 只有在请求时才拿得到
export function createUserScopedTools(prisma: PrismaService, userId: string) { ... }
```

**这是防越权的关键**：会话类工具若做成全局单例，Agent 就可能读到甚至改动别人的数据。

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
   ↓ 写入 ticket payload
   ↓ 开流时守卫解出 allowWrite
   ↓ invokeTool 遇到 policy.write 且未授权 → 不执行，
     返回"需要授权"的结果 → 由模型转告用户
```

```ts
if (policy?.write && !allowWrite) {
  return { ok: false, output: '工具 X 属于写操作，当前会话未获得用户授权…' };
}
```

既保持 SSE 单向，又让 AI 无法擅自改数据 —— 用户是从「AI 的回复」里得知需要授权的，交互自然。

### 现有工具

| 名称 | 类型 | 写操作 | 用途 |
| --- | --- | --- | --- |
| `query_user` | 全局 | 否 | 按邮箱 / 昵称关键词查用户 |
| `list_my_conversations` | 按请求 | 否 | 列出当前用户最近会话 |
| `read_my_conversation` | 按请求 | 否 | 读取某会话历史 |
| `rename_my_conversation` | 按请求 | **是** | 改会话标题 |

## 1.6 双层记忆：Redis + PostgreSQL

`memory/conversation.repository.ts`

| 层 | 存什么 | TTL | 作用 |
| --- | --- | --- | --- |
| **Redis** | `ai:conv:<id>` → 最近 20 条消息 | 30 分钟 | 短期记忆，多轮取历史快 |
| **PostgreSQL** | `Conversation` + `Message` 表 | 永久 | 长期记忆，支持历史回看 |

```ts
const HISTORY_LIMIT = 20;                    // 上下文窗口
const CACHE_TTL_SECONDS = 60 * 30;           // 热缓存 30 分钟
```

读：命中直接返回；miss 则回源 Prisma 并回填缓存。写：写库后写穿到 Redis。

**Redis 挂了不影响主流程** —— 所有缓存操作包在 try/catch 里，失败只打日志，降级直查数据库。

上下文组装（只取 user / assistant 轮次，tool 轮次依赖 tool_calls 配对，跳过）：

```ts
const history = params.history
  .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
  .map(m => m.role === 'user' ? new HumanMessage(m.content) : new AIMessage(m.content));
```

## 1.7 系统提示词（决定回答像不像样）

**这是最容易被忽视、但对观感影响最大的一环。**

最初只有 38 字：

```
你是 Wisora 的智能助手。可以使用工具获取信息。用中文回答，简洁准确。
```

导致三类问题：

1. **编造理由**：被问身份时答「没有权限查看自己的底层模型信息」—— 提示词把它设定成 Wisora 助手，它又确实不知道自己的版本号，两头顾不上就编了个听起来合理的借口
2. **答非所问**：被问开放问题时把工具清单一整摊开
3. **语气机械**：`temperature 0.3` 加重了这一点

现抽出到 `src/ai/prompts/system.prompt.ts`，分三节：

```ts
export const DEFAULT_SYSTEM_PROMPT = `你是 Wisora 智能工作台的内置 AI 助手。

## 回答风格
- 用中文回答，先给结论再给依据，不啰嗦
- 不要主动罗列自己的能力清单，除非用户明确问"你能做什么"
- 不知道的直接说不知道，不要编造理由或能力边界

## 工具使用
- 需要真实数据时主动调用工具，不要凭空推测
- 查询会话、用户资料等优先使用工具获取真实结果
- 写操作需要用户授权。未获授权时如实说明
  "需要开启允许 AI 修改数据后才能执行"，不要说成是自己没有权限

## 身份说明
- 用户问你是谁、用的什么模型时，如实说明：你是 Wisora 内置助手，
  底层接入的是大语言模型服务；你不一定能知道确切版本号，
  直接说"我不确定具体版本"即可，不要编造理由是"没有权限查看"
- 不要自称是其他厂商的官方产品`;
```

**实测对比**（`backend/test/probe-answer-style.cjs`）：

| | 问「你是什么模型」 |
| --- | --- |
| 改前 | 我是 Wisora 的智能助手，**没有权限查看自己的底层模型信息**，所以没法准确告诉你具体是哪个模型。 |
| 改后 | …具体用的是哪个厂商、哪个版本的模型，我不确定——这类信息不在我能看到的范围内，所以没法给你一个准确的版本号，**就不编了**。 |

## 1.8 前端状态管理与渲染

`stores/useAgentStore.ts`（zustand）

**流式更新的性能要点**：

```ts
// 只更新「最后一条助手消息」，避免整列重渲染
const appendToAssistant = (updater) => {
  set(state => ({
    messages: state.messages.map(m => m.id === assistantId ? { ...m, ...updater(m) } : m)
  }));
};
```

发送时先插入一条**空的 assistant 占位消息**，后续 token 往这里累加。

**串台防护**：

```ts
openConversation: async (id) => {
  controller?.abort();      // 切换前必须先中断
  ...
}
```

不中断的话，旧流会继续往已被替换的 `messages` 里追加 token，两条会话内容混在一起。

**中断处理**：主动中断不算错误，不弹提示，但保留已生成内容并标注「（已停止生成）」。

**为什么分 axios 和 fetch**：

| 用途 | 走什么 | 原因 |
| --- | --- | --- |
| 换票、会话 CRUD | **axios** | 复用项目统一的 token 自动注入 / 401 刷新重放 |
| 开 SSE 流 | **fetch** | axios 基于 XHR，浏览器端拿不到流式增量；只有 `ReadableStream` 能逐块读 |

这是同一层里混用两套 HTTP 客户端的唯一理由。

## 1.9 安全设计

### IDOR 防护（最重要）

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

统一错误文案是刻意的 —— 如果两种情况返回不同错误，攻击者就能用它探测哪些会话 ID 真实存在。

**凡是接收外部 `conversationId` 的入口都必须先过这一关**（开流、`GET /:id/messages`）。

### 限流

```ts
const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 10;   // 每用户 60 秒 10 次
```

Redis `INCR` + 首次命中设过期。换票和开流**两处都查**，防止刷票绕过。

### 其他

- **ticket 一次性 + 30 秒**：杜绝重放
- **软删除**：会话 `deletedAt` 标记，所有查询都带 `deletedAt: null`
- **工具按 userId 过滤**：闭包注入，Agent 越不过去
- **审计留痕**：`tool_call` / `tool_result` 都落库，事后可追溯 AI 做过什么

---

# Part II　笔记模块

## 2.1 数据模型

```prisma
model Note {
  id        String    @id @default(cuid())
  userId    String
  title     String    @default("无标题")
  content   String    @default("") // Markdown 原文
  pinned    Boolean   @default(false)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt
  deletedAt DateTime?              // 软删除

  user        User         @relation(fields: [userId], references: [id])
  attachments Attachment[]

  @@index([userId, deletedAt, updatedAt])
}

model Attachment {
  id     String  @id @default(cuid())
  userId String
  noteId String?                   // 允许先传文件再挂笔记

  filename   String                // 用户看到的原始文件名
  mimeType   String
  size       Int                   // 字节数
  storageKey String  @unique       // 磁盘上的实际文件名（随机 UUID + 扩展名）

  createdAt DateTime @default(now())
  user User  @relation(fields: [userId], references: [id])
  note Note? @relation(fields: [noteId], references: [id], onDelete: Cascade)

  @@index([userId, createdAt])
  @@index([noteId])
}
```

设计要点：

- **元数据在库、实体在磁盘**：库里只留文件名 / 类型 / 大小 / storageKey，不存二进制
- **`storageKey` 用随机 UUID + 扩展名**：避免同名覆盖，也杜绝用上传文件名拼路径导致的路径穿越
- **`noteId` 可空**：支持「新建笔记时先拖文件」的交互，之后补挂
- **列表索引 `(userId, deletedAt, updatedAt)`**：列表查询就是这个模式

## 2.2 后端分层

```
NotesController        → 笔记 CRUD、搜索、置顶、软删除
AttachmentsController  → multipart 上传、读取内容、删除
        ↓
NotesService           → 笔记业务 + assertOwned 归属校验
AttachmentsService     → 附件业务：类型/大小校验、落盘、读回、删除
        ↓
StorageService         → 磁盘 IO（换 S3/OSS 只改这一层）
```

**为什么 StorageService 要单独抽出来**：当前落在本地磁盘，之后换对象存储只需替换这一个实现，上层 Controller 与 Service 完全不用动。

**路由前缀的坑**：`AttachmentsController` 必须是 `@Controller('attachments')`，
不能挂成 `/notes/attachments` —— `NotesController` 上有 `@Get(':id')`，
同级子路径会被它抢先匹配。

## 2.3 鉴权：通用 JWT 守卫

AI 模块原先在 controller 里内联解析 JWT。笔记模块若再抄一份就是三处重复，
密钥来源与错误文案一旦不一致很难排查。所以抽出通用实现：

```ts
// src/auth/guards/jwt-auth.guard.ts
@Injectable()
export class JwtAuthGuard implements CanActivate {
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException('缺少访问令牌');
    try {
      const payload = await this.jwtService.verifyAsync<{ sub: string; email?: string }>(
        auth.slice('Bearer '.length),
        { secret: process.env.JWT_ACCESS_SECRET },
      );
      req.userId = payload.sub;
      req.userEmail = payload.email;
      return true;
    } catch {
      throw new UnauthorizedException('访问令牌无效或已过期');
    }
  }
}
```

配合 `@CurrentUser()` 装饰器取 userId：

```ts
@Get()
list(@CurrentUser() userId: string, @Query('keyword') keyword?: string) {
  return this.notes.list(userId, keyword);
}
```

**userId 一律从令牌取，不接受客户端传入**，从源头上杜绝冒用他人身份。

## 2.4 文件上传：四道防线

```ts
// 1. 类型白名单
const ALLOWED_MIME = new Set([
  'application/pdf', 'text/markdown', 'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  /* Office 文档：只支持下载，不做在线预览 */
]);

async upload(userId, file, noteId?) {
  if (!file) throw new BadRequestException('未收到文件');
  if (!ALLOWED_MIME.has(file.mimetype)) throw new BadRequestException('不支持的文件类型…');
  if (file.size > this.storage.maxSize) throw new BadRequestException('文件过大…');

  // 2. 挂到笔记前先校验笔记归属
  if (noteId) { /* findFirst({ id: noteId, userId }) */ }

  // 3. 随机文件名落盘
  const storageKey = await this.storage.save(file.buffer, file.originalname);

  // 4. 只把元数据写库
  return this.prisma.attachment.create({ data: { ... } });
}
```

**为什么不做通配放行**：上传目录同源可访问，若放任 `.html` / `.svg` 这类可执行脚本的类型落盘，等于给自己开了个存储型 XSS 的口子。

**读文件时再校验一次路径**（ defense in depth）：

```ts
resolvePath(storageKey: string): string {
  const full = path.resolve(this.root, storageKey);
  if (full !== this.root && !full.startsWith(this.root + path.sep)) {
    throw new NotFoundException('附件不存在');
  }
  return full;
}
```

storageKey 来自数据库（我们自己生成的），仍再校验一次解析结果必须落在 root 内，防止脏数据造成越权读取。

## 2.5 附件预览：为什么必须先取 Blob

附件接口挂在 `JwtAuthGuard` 下需要 `Authorization` 头，而 **`<iframe>` / `<img>` 的请求带不上自定义头**。

如果直接用 `<iframe src="/attachments/:id/content">`，会拿到 401。两种解法：

| 方案 | 问题 |
| --- | --- |
| 把接口开成公开（去掉守卫） | 任何人拿到 id 就能下载别人附件 |
| 签一个短期 URL | 要额外实现签名与过期 |
| **先取 Blob 再转 objectURL** ✅ | 令牌始终留在请求头里 |

采用第三种：

```ts
export async function fetchAttachmentBlob(id: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${BASE}/attachments/${id}/content`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  if (!res.ok) throw new Error(`加载附件失败（HTTP ${res.status}）`);
  return res.blob();
}
```

然后 `URL.createObjectURL(blob)` 交给 `<iframe>`（PDF）或 `<img>`（图片）渲染。
**记得在组件卸载时 `revokeObjectURL`**，否则内存泄漏。

服务端用 `Content-Disposition` 区分两种用途：

```
不传 ?download     → inline   浏览器内渲染
传 ?download=1     → attachment  强制下载
```

文件名含中文时用 RFC 5987 编码：

```ts
const encoded = encodeURIComponent(attachment.filename);
res.setHeader('Content-Disposition',
  `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`);
```

文件下载必须加 `@SkipResponse()`：全局拦截器会把响应包成 `{code,msg,data}`，二进制内容会被破坏。

## 2.6 前端：编辑器与自动保存

### 三视图

编辑 / 分栏 / 预览，用 zustand 外的局部 state 管理（不影响笔记数据）。

### 防抖自动保存

```ts
const AUTOSAVE_DELAY_MS = 800;

const doSave = async () => {
  const { active, saveState } = get();
  if (!active || saveState === 'saving' || saveState === 'saved') return;
  set({ saveState: 'saving' });
  try {
    const saved = await updateNote(active.id, { title, content });
    if (get().activeId !== saved.id) return;   // 保存期间用户已切走
    set({ saveState: 'saved' });
    // 同步列表里的标题/时间，否则侧边栏显示旧标题
  } catch (err) {
    set({ saveState: 'error', error: err.message });
  }
};

const scheduleSave = () => {
  cancelPending();
  saveTimer = setTimeout(() => { saveTimer = null; void doSave(); }, AUTOSAVE_DELAY_MS);
};
```

### 切换笔记前必须落盘（关键）

```ts
openNote: async (id) => {
  if (get().activeId === id) return;
  cancelPending();      // 取消待执行的定时器
  await get().flush();  // 立即落盘
  set({ activeId: id, ... });
  ...
}
```

**不这么做会出两个问题**：

1. 编辑丢失
2. 定时器到点后把**旧笔记的内容 PATCH 到新笔记上** —— 和 AI 模块「串台」是同一类错误

### 乐观删除

先从列表移除让交互立刻响应，请求失败再回滚。

## 2.7 Markdown 渲染与安全

```tsx
marked.setOptions({ gfm: true, breaks: true });

const html = useMemo(() => {
  if (!content.trim()) return '';
  const raw = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}, [content]);
```

**为什么一定要过 DOMPurify**：marked 只负责把 Markdown 转成 HTML 字符串，不做转义。
笔记内容现在由用户自己输入，但一旦将来支持导入他人分享的 `.md` 文件，
这里就是唯一的 XSS 防线 —— 现在就装好，比事后补可靠。

样式手写了一套 `.md-body`（项目没装 `@tailwindcss/typography`，且它的默认排版偏冷灰，与暖白基底不搭）。

---

# Part III　两个模块共享的基础设施

| 设施 | 位置 | 说明 |
| --- | --- | --- |
| `PrismaModule` | `src/prisma` | `@Global()`，任何模块可直接注入 `PrismaService` |
| `RedisModule` | `src/redis` | `@Global()`，票据 / 限流 / 会话缓存都用它 |
| `ResponseInterceptor` | `src/common/interceptors` | 把响应包成 `{code,msg,data}` |
| `@SkipResponse()` | `src/common/decorators` | 让 SSE / 文件下载绕过包装 |
| `JwtAuthGuard` | `src/auth/guards` | 通用 JWT 校验（笔记模块用；AI 的 SSE 走 ticket） |
| `@CurrentUser()` | `src/auth/decorators` | 取令牌里的 userId |
| 前端 axios 实例 | `src/request/index.ts` | token 注入、401 刷新重放、响应解包 |
| 前端 zustand | `src/stores` | 模块各自独立的 store |

### 一次顺带的重构：`@SkipResponse()` 搬家

原先放在 `src/ai/decorators/` —— ai 只是它的**第一个使用者**，文件下载同样需要。
放在业务模块里会导致 `common` 反向依赖 `ai`，所以移到 `src/common/decorators/`，
同步更新了拦截器的 import。

---

# Part IV　踩坑清单

## 共通

| 坑 | 正确做法 |
| --- | --- |
| 在 React 组件内部定义组件 | 函数身份变化会重挂子树，输入框失焦（一次只能输一个字符）。子组件一律提到模块顶层 |
| 外部传入的 id 不做归属校验 | 一律 `assertOwned`，且「不存在」与「无权访问」返回同一文案 |

## AI 模块

| 坑 | 正确做法 |
| --- | --- |
| 用 `@Get` 返回 Observable | 必须用 `@Sse`。`@Get` 只取最后一个值发 JSON，流式数据全丢 |
| 忘了 `bindTools` | 模型看不到工具，`tool_calls` 恒为空 |
| 全局拦截器包装 SSE | 加 `@SkipResponse()`；且**不能**判断 Content-Type（SSE 响应头在拦截器之后才写入） |
| 流内异常用 `subscriber.error` | 用 `complete` + 下发 `error` 事件，避免被全局 `HttpExceptionFilter` 污染 |
| 先发 `done` 再落库 | **必须先落库再发 done**。否则客户端收到 done 立刻发下一轮，读到未写入的历史（多轮记忆随机失效） |
| teardown 不 abort | 客户端断开后模型继续生成并计费 |
| 写工具设 retries > 0 | 写操作重试会造成重复执行，务必设为 0 |
| 把 `:ping` 当数据解析 | 心跳行以 `:` 开头，解析时跳过 |
| 用 `EventSource` 开流 | 不能带 Authorization 头，也不支持自定义中断；用 fetch + ticket |
| 系统提示词太短 | 会导致编造理由、乱列工具、语气机械（详见 1.7） |

## 笔记模块

| 坑 | 正确做法 |
| --- | --- |
| **中文文件名乱码** | multer 按 latin1 解码 multipart 文件名。用 `decodeFilename()`：名字含 0x80–0xFF 高位字符才按 latin1 读回字节再解 UTF-8；客户端正确传 UTF-8 时（字符码 > 0xFF）原样返回；还原出 U+FFFD 也保持原样 |
| 路由前缀冲突 | 附件必须用 `@Controller('attachments')`，不能挂 `/notes/attachments`，会被 `@Get(':id')` 抢先匹配 |
| iframe 直连受保护接口 | 带不上 Authorization 头 → 先取 Blob 再转 objectURL |
| 忘记 `revokeObjectURL` | 组件卸载时释放，否则内存泄漏 |
| 切换笔记不落盘 | 编辑丢失，且定时器会把旧内容写到新笔记上 |
| 文件下载没加 `@SkipResponse()` | 二进制被响应拦截器包成 JSON 破坏 |
| **`prisma migrate status` 不报漂移** | 只比对已应用的迁移文件；schema 加了模型但没建迁移时照样显示 "up to date"。加模型后用 `migrate dev` 实跑 |

---

# Part V　扩展与调参

## 调参位置

| 参数 | 文件 | 当前值 |
| --- | --- | --- |
| 票据有效期 | `ai.controller.ts` | 30 秒 |
| Agent 轮次上限 | `ai.service.ts` | 8 |
| 心跳间隔 | `ai.service.ts` | 15 秒 |
| 限流 | `rate-limit.service.ts` | 10 次 / 60 秒 |
| 上下文窗口 | `memory/conversation.repository.ts` | 20 条 |
| 缓存 TTL | 同上 | 30 分钟 |
| 工具超时 / 重试 | `tool.registry.ts` | 15 秒 / 1 次 |
| 系统提示词 | `prompts/system.prompt.ts` | 见 1.7 |
| 模型 / 温度 | `.env` | `deepseek-v4-flash` / 0.7 |
| 上传大小上限 | `.env` 的 `UPLOAD_MAX_BYTES` | 20 MB |
| 上传目录 | `.env` 的 `UPLOAD_DIR` | `<项目根>/uploads` |

## 换模型

只改后端环境变量，代码零改动：

```bash
OPENAI_BASE_URL=https://api.deepseek.com   # 不要加 /v1，SDK 自动补
CHAT_MODEL_NAME=deepseek-v4-flash
OPENAI_API_KEY=sk-...
CHAT_MODEL_TEMPERATURE=0.7
```

## 加一个 AI 只读工具

1. 在 `src/ai/tools/` 新建 `xxx.tool.ts`，用工厂函数（才能注入 `PrismaService`）
2. 在 `tools/index.ts` 登记：与用户无关 → `registerAllTools`；需按用户过滤 → `createUserScopedTools`
3. 若会改数据，务必 `policy: { write: true, retries: 0 }`

## 加一种可上传的文件类型

在 `attachments.service.ts` 的 `ALLOWED_MIME` 加 MIME，同时更新前端
`pages/notes/index.tsx` 里 `<input accept="...">` 与 `isPreviewable()`。

## 真机验证脚本

| 脚本 | 覆盖 |
| --- | --- |
| `backend/test/verify-agent-live.cjs` | AI：多轮记忆、工具调用、落库 |
| `backend/test/verify-notes-live.cjs` | 笔记：23 条断言（CRUD、搜索、上传、二进制比对、越权 404、未鉴权 401、类型白名单、软删除） |
| `backend/test/probe-answer-style.cjs` | 回答风格（改提示词前后对比） |
| `backend/test/probe-filename.cjs` | 文件名编码 |

运行前需 PostgreSQL / Redis / 后端在跑。

## 待办与可改进

- 前后端事件类型目前靠人工同步，可考虑共享包或代码生成消除漂移风险
- 上下文超窗后直接截断，后续计划做摘要记忆
- 限流是固定窗口计数，若要更平滑可换令牌桶或 Lua 脚本
- `ChatDto` 已定义但换票接口用的是内联类型，未真正启用校验
- 笔记暂无全文搜索（走 `contains`，大数据量下需要 tsvector 或外部索引）
- 附件删除采用「先删记录再删文件」，长期运行可能产生孤儿文件，可加定时清理任务
