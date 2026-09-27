# Wisora 智能工作台 · 前后端逐文件代码详解

> 面向读者：项目的作者本人（用于系统复习、面试准备与后续维护）。
> 覆盖范围：`backend/src` 下 **92 个手写 `.ts`**（另有 12 个 Prisma 生成文件）+ `frontend/src` 下 **73 个文件**。
> 版本基准：2026-09-25 的工作区状态（提交 `9b0f6bc` 之后）。
>
> 本文所有路径、类名、方法名、常量值均来自实际代码读取，不是设计意图的复述。
> 凡「文档这么写、代码不是这样」的地方，集中在 **Part 4** 列出。

---

## 怎么读这份文档

- **Part 1 / Part 2** 是逐文件的：每个模块先给一张**文件清单表**（路径 → 注释 → 联动），再对其中最核心的文件做**深读**。表格用于查，深读用于懂。
- **Part 3** 是横切的：把模块之间的调用链串成 4 条主干链路，回答「它们怎么联动」。
- **Part 4** 把 `docs/` 里 5 份设计文档与代码逐一对照，列出同步的、滞后的、以及已经被代码反超的地方。

一个约定：本文里的「**路径**」一律相对仓库根 `D:\项目\wisora-web`。

---

## 0. 全局地图

### 0.1 技术栈与运行方式

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | React 19 · Vite 8 · TypeScript · Tailwind CSS 4 · shadcn/ui · zustand · react-router 7 · GSAP · socket.io-client | 单页应用，`frontend/` |
| 后端 | NestJS 11 · Prisma 7 · PostgreSQL · Redis · socket.io · LangChain（`@langchain/openai`） | `backend/` |
| 模型 | DeepSeek（`deepseek-chat` / `deepseek-v4-pro`），走 OpenAI 兼容协议 | `OPENAI_BASE_URL` 指向 `api.deepseek.com` |
| 包管理 | pnpm（前后端各自一份 lockfile） | —— |
| 端口 | 前端 dev `5173`，后端 `3000` | 前端 `VITE_BASE_API` 直连后端 |

一个必须记住的前提：**main.ts 没有 `setGlobalPrefix`**，所以接口是裸路径（`/ai`、`/notes`、`/chat`、`/auth`、`/user`、`/attachments`），前端拼 URL 时不带任何前缀。

### 0.2 目录总览

```
wisora-web/
├─ backend/
│  ├─ prisma/schema.prisma        ← 10 张表 / 3 个枚举，全项目数据形状的来源
│  ├─ src/
│  │  ├─ main.ts app.module.ts app.controller.ts app.service.ts   ← 编排层（4 文件）
│  │  ├─ common/       ← 横切能力：统一响应、异常、限流、存储、上传校验、用户形状（8 文件）
│  │  ├─ prisma/ redis/                        ← 两个 @Global 基础设施（各 2 文件）
│  │  ├─ auth/         ← 认证域（1 controller + 1 service + 1 module + 1 guard + 1 装饰器 + 8 DTO）
│  │  ├─ verification-code/ mail/  ← 认证域的外部依赖（验证码、邮件）
│  │  ├─ user/         ← 用户域（3 文件）
│  │  ├─ notes/        ← 笔记域（6 文件，含附件）
│  │  ├─ chat/         ← 聊天域（11 文件，含 WS 网关）
│  │  ├─ ai/           ← AI 域（14 文件，含工具系统与 LLM 封装）
│  │  └─ generated/prisma/          ← Prisma 生成产物（12 文件，不手改）
│  └─ test/            ← 验证脚本（.cjs，直接连库/HTTP，不经 Nest）
├─ frontend/
│  └─ src/
│     ├─ main.tsx App.tsx index.css
│     ├─ request/      ← 自研请求层（16 文件）
│     ├─ stores/       ← zustand 状态（4 文件）
│     ├─ router/ lib/ types/
│     ├─ pages/        ← 8 个页面
│     └─ components/   ← 23 个业务组件 + 9 个 shadcn 基础组件
└─ docs/               ← 5 份设计文档（Part 4 逐一对照）
```

### 0.3 数据模型全景

数据模型是整个项目的枢纽 —— 模块之间的耦合，一多半是通过共享表体现的。`backend/prisma/schema.prisma` 共 10 个 model、3 个 enum，可以按**三个域**划分：

**① 身份域**

| 模型 | 关键字段 | 注释 |
|---|---|---|
| `User` | `id(cuid)` `email(unique)` `password` `nickname?` `handle?(unique)` `bio?` `emailVerified` `deletedAt?` | 唯一的账号表。`handle` 可空是有原因的：表里已有数据时非空加唯一约束会直接迁移失败，而 Postgres 唯一索引允许多个 NULL。展示为空时回退邮箱前缀。 |

**② AI 助手域**（`Conversation` / `Message` —— 注意这两个名字被 AI 占用了）

| 模型 | 关键字段 | 注释 |
|---|---|---|
| `Conversation` | `userId` `title?` `model?` `deletedAt?`，索引 `[userId, updatedAt]` | AI 会话。`model` 记录该会话用的模型，切换模型时跟随更新。 |
| `Message` | `conversationId` `role(system\|user\|assistant\|tool)` `content` `toolCalls?` `toolCallId?` `name?` `usage?` | 一行存一条消息。`role` 是字符串而不是枚举（因为要容纳 OpenAI 协议的四种角色）。`usage` 列存在但**目前未被填充**（见 Part 4）。 |

**③ 笔记域**

| 模型 | 关键字段 | 注释 |
|---|---|---|
| `Note` | `userId` `title` `content`(Markdown 原文) `pinned` `parentId?` `deletedAt?`，索引 `[userId,deletedAt,updatedAt]` + `[parentId]` | 自关联 `"NoteTree"` 实现父子页面。`onDelete: Cascade` 只是 DB 层兜底 —— 业务走软删除，级联**不会触发**，子树软删由 `NotesService` 显式处理。 |
| `Attachment` | `userId` `noteId?` `filename` `mimeType` `size` `storageKey(unique)` | 实体在磁盘，库里只留元数据。`noteId` 可空是为了「先传文件、笔记还没保存」这条路径。`storageKey = UUID + 扩展名`，从根上杜绝同名覆盖与路径穿越。 |

**④ 聊天域**（5 张表，模型名统一加 `Chat` 前缀）

之所以要加前缀：Prisma 的**模型与枚举共享同一命名空间**，与 AI 域的 `Conversation` / `Message` 直接重名会报 `Duplicate model`。但重名只是表面原因，更根本的是**语义与生命周期不同** —— AI 会话是「人机」，聊天会话是「人人」；删笔记不该牵连聊天记录里的文件，所以附件也分两张表。

| 模型 | 关键字段 | 注释 |
|---|---|---|
| `ChatFriendship` | `userId` `friendId` `alias?`，`@@unique([userId,friendId])` | **双向两行**：A 加 B 会写 `(A,B)` 与 `(B,A)`。查询时不需要 OR。 |
| `ChatConversation` | `kind(DIRECT\|GROUP)` `title?` `ownerId?` `directKey?(unique)` | 单聊去重靠 `directKey`（两个成员 id 排序后 `:` 连接）的**唯一约束**，而不是「先查再建」—— 后者在并发下有窗口。 |
| `ChatConversationMember` | `conversationId` `userId` `pinned` `muted` `unread` `lastReadAt?` `joinedAt` `leftAt?`，`@@unique([conversationId,userId])` | **置顶/免打扰/未读放在成员维度而非会话维度**：这些是每个人自己的状态。放会话上会导致「A 读了消息，B 的未读数也被清零」。`joinedAt` 还是群成员配色的依据（见 1.7）。 |
| `ChatMessage` | `kind(TEXT\|IMAGE\|FILE\|NOTE)` `text?` `noteId?` `noteTitle?` `noteKind?` `noteChildCount` `status(SENT\|READ)`，索引 `[conversationId,createdAt]` | 笔记消息**存快照**而不是联表：聊天记录是历史，笔记后来改名不该改写历史；而且列表一屏几百条，每条 join 笔记表会变成 N+1。 |
| `ChatAttachment` | `messageId?(unique)` `uploaderId` `filename` `storageKey(unique)` `mimeType` `size`，索引 `[uploaderId,createdAt]` | `messageId` **必须可空**：上传与发送是两步（先 `POST /chat/attachments` 拿 id，再带 `attachmentId` 发消息）。代价是会产生「传了没发」的孤儿附件 —— 所以有清理定时器和配套索引。 |

### 0.4 模块依赖图

后端模块的装配关系（`→` 表示 imports）：

```
AppModule
 ├─ AuthModule ──→ PrismaModule, RedisModule, MailModule, VerificationCodeModule, JwtModule
 ├─ UserModule ──→ JwtModule
 ├─ VerificationCodeModule ──→ RedisModule
 ├─ MailModule
 ├─ AiModule ──→ PrismaModule, NotesModule, JwtModule
 ├─ NotesModule ──→ JwtModule, StorageModule
 ├─ ChatModule ──→ JwtModule, NotesModule
 ├─ StorageModule      (@Global)
 └─ RateLimitModule    (@Global)
```

这里面藏着三件必须知道的事（Part 4 会再展开）：

1. **`PrismaModule` 与 `RedisModule` 没有出现在 `AppModule` 的 imports 里** —— 它们是靠 `AuthModule` / `VerificationCodeModule` 间接进入依赖图的。而这两个模块都标了 `@Global()`，所以 `UserModule`、`NotesModule` 等虽然没 import 它们，也能注入 `PrismaService`。**这是一个隐性耦合**：一旦把 `AuthModule` 从根模块摘掉，`UserService` 会立刻启动失败。
2. `AppModule` 的注释写着「`@Global()` 模块也要在根模块挂一次」，而 `StorageModule` / `RateLimitModule` 确实被显式登记了 —— 恰好因为**没有别的模块帮它们兜底**。
3. **没有 `ConfigModule.forRoot()`**。环境变量全靠进程级 `.env`，而真正触发加载的是 `prisma.service.ts` 顶部那行 `import 'dotenv/config'`（副作用式）。也就是说环境变量的可用性依赖 Prisma 先被加载 —— 顺序耦合。

前端没有模块系统，但**分层是严格的单向依赖**：

```
pages/  →  stores/  →  request/  ─┐
   ↓         ↓            ↓       ├→  request/index.ts（axios 实例）
components/  ←──┘          └──→  lib/  types/
```

页面只调 store 与 request，不直接碰 axios 实例；store 只调 request；`lib/` 是无状态的纯函数（`logout.ts` 是唯一例外，它要编排多个 store）。

### 0.5 一次请求的完整旅程

以「AI 助手页发送一句话，模型调用工具写入一篇笔记」为例，把后面 Part 1/2/3 要讲的东西先串一遍：

```
① 用户点发送
   pages/agent/index.tsx  →  useAgentStore.send()
② 取票（axios，走完整请求层）
   request/ai-stream.ts: createChatTicket(allowWrite)
   └→ axios 实例 → 请求拦截器（注入 Bearer TOKEN、登记 pending、showLoading）
      → POST /ai/chat/ticket
      → 后端 AiController.createTicket：verifyAsync 拿 userId → 限流 → 生成 UUID 票
        → Redis SET ai:ticket:<uuid> TTL 30s
③ 开流（原生 fetch，绕过 axios）
   fetch GET /ai/chat/stream?ticket=...&q=...&model=...
   └→ 后端 StreamTicketGuard：GET 存在性检查 → 立即 DEL（取完即焚）→ 把 userId/allowWrite 挂到 request
      → AiController.chatStream：再限流 → 会话归属校验 → loadHistory → createUserScopedTools(userId)
      → AiService.toSse(runAgent(...))
④ Agent Loop（后端内部）
   runAgent：SystemMessage(系统提示词) + 历史 + 用户消息 → model.stream()
   ├→ LLM 先输出 tool_call：create_my_note
   ├→ invokeTool：查策略 → policy.write && !allowWrite 则拦截（返回文本让模型转告用户）
   ├→ 否则调 notes.tool.ts 的工具 → 内部走 NotesService.create()（复用归属校验，不直接用 Prisma）
   └→ tool_result 回灌上下文 → 再迭代（MAX_ITERATIONS = 8）
⑤ 服务端 → 客户端
   SSE 事件流：start → token… → tool_call → tool_result → token… → done
   └→ 每 15s 插一条 ":ping" 心跳（冒号开头，不属于协议）
⑥ 前端渲染
   ai-stream.ts 按 \n\n 分帧、取 data: 行、跳过 : 心跳 → JSON.parse 成 StreamEvent
   → useAgentStore 按 type 派发：token 追加到当前气泡；tool_call 插入工具气泡（并轮换当前助手气泡）
⑦ 跨模块回写
   tool_result 里出现写操作 → useAgentStore 调 useNotesStore.getState().loadNotes() 刷新笔记树
```

这条链路里有 4 个设计决策值得单独记住（后面都会展开）：**为什么用 ticket 而不是把 JWT 放 query**、**为什么用 fetch 而不是 EventSource**、**为什么工具内部走 NotesService 而不是 Prisma**、**为什么工具气泡要轮换新的助手气泡**。

---

# Part 1　后端逐文件详解

## 1.1 应用编排层

### 文件清单

| 路径（`backend/src/`） | 注释 | 联动 |
|---|---|---|
| `main.ts` | 应用引导。`NestFactory.create<NestExpressApplication>`；用 `app.useBodyParser('json'/'urlencoded', {limit:'10mb'})`；全局注册 `ResponseInterceptor`（手动 `app.get(Reflector)` 后 `new`）与 `HttpExceptionFilter`；`enableCors()`；`listen(3000)` | 调用 `common/interceptors/response.interceptor.ts`、`common/filters/http-exception.filter.ts` |
| `app.module.ts` | 根模块。imports 业务模块 + 两个 `@Global` 基础设施；controllers `AppController` | 被 `main.ts` 引导 |
| `app.controller.ts` | 只有一个健康探针 `GET /` | 注入 `AppService` |
| `app.service.ts` | 返回 `'Hello World!'` | 被 `AppController` 调用 |
| `app.controller.spec.ts` | 脚手架单测，断言 `getHello()` | —— |

### 深读 `main.ts`：全局装配点，以及两个非显然的写法

`main.ts` 是**全项目唯一的全局装配点**，全局只注册了两样东西：一个拦截器、一个过滤器。

```ts
const app = await NestFactory.create<NestExpressApplication>(AppModule);
app.useBodyParser('json', { limit: '10mb' });
app.useBodyParser('urlencoded', { extended: true, limit: '10mb' });
const reflector = app.get(Reflector);
app.useGlobalInterceptors(new ResponseInterceptor(reflector));
app.useGlobalFilters(new HttpExceptionFilter());
app.enableCors();
await app.listen(process.env.PORT ?? 3000);
```

三个非显然点：

**① 没有 `useGlobalPipes(new ValidationPipe())`。** 这是全项目最重要的隐性约束：`auth/dto/*.ts`、`chat/dto/*.ts`、`notes/dto/*.ts` 上的 `@IsEmail` / `@MinLength` / `@Length` 装饰器**运行时不生效，只是文档**。真正的校验必须写在 service 里。这条约束在 `chat/README.md` 与 `conversations.service.ts` 的注释里被明确承认过。

**② 为什么用 `app.useBodyParser` 而不是 `import { json } from 'express'`。** 因为 pnpm 的严格 node_modules 下 `express` 只是传递依赖，直接 import 会启动即 `Cannot find module 'express'`。而 `NestExpressApplication` 泛型才有 `useBodyParser` 这个方法，所以 `create()` 的泛型参数不能省。10MB 上限是为「导入整篇 Markdown 笔记」放开的 —— 默认 100KB 会让大文档直接 500。

**③ 拦截器必须手动 `new`。** `useGlobalInterceptors` 传实例时**不走 Nest DI**，`Reflector` 不会自动注入，所以要先 `app.get(Reflector)` 再手工构造。这是「为什么拦截器构造函数是 `constructor(private readonly reflector: Reflector)` 却要手 new」的答案。

另外两个「没有」：没有 `app.enableShutdownHooks()`（`onModuleDestroy` 在 SIGTERM 下的实际触发依赖默认行为）；没有任何全局守卫。

### 深读 `app.module.ts`：注册图里的一处隐性耦合

```ts
@Module({
  imports: [
    AuthModule, UserModule, RedisModule, VerificationCodeModule, MailModule,
    AiModule, NotesModule, ChatModule, StorageModule, RateLimitModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
```

注意：**`PrismaModule` 不在列表里**（`RedisModule` 在，但 `AuthModule` 自己也 import 了它，所以实际是冗余的）。`PrismaModule` 之所以能用，是因为 `AuthModule` 与 `AiModule` 都 import 了它，而它标了 `@Global()`。

于是形成一条**隐式依赖**：

```
UserModule ──(没 import PrismaModule)──> 能用 PrismaService
                                          ↑ 靠 AuthModule 把 PrismaModule 带进依赖图
```

如果哪天重构时把 `AuthModule` 从根模块摘掉，`UserModule` 会立刻报 `Nest can't resolve dependencies of the UserService`。这类错误很难从「UserModule 的代码」上看出来，所以值得记一笔。

## 1.2 基础设施层

### 文件清单

| 路径（`backend/src/`） | 注释 | 联动 |
|---|---|---|
| `prisma/prisma.module.ts` | `@Global()` 模块，提供 `PrismaService` | 被 `AuthModule` / `AiModule` 间接登记 |
| `prisma/prisma.service.ts` | `extends PrismaClient`，构造时用 **Prisma 7 的 driver adapter** `PrismaPg({connectionString})`；`onModuleInit` → `$connect`；`onModuleDestroy` → `$disconnect`；顶部 `import 'dotenv/config'` | 被所有业务 service 注入 |
| `redis/redis.module.ts` | `@Global()` 模块，提供 `RedisService` | 被 `AuthModule` / `VerificationCodeModule` 登记 |
| `redis/redis.service.ts` | ioredis 封装。构造读 `REDIS_HOST/PORT/PASSWORD`；`onModuleInit` 用 `ping()` 探活并打印 `Redis connected`；对外只暴露 `getClient(): Redis` | 被限流、验证码、聊天、AI 调用 |
| `common/interceptors/response.interceptor.ts` | 统一响应包装：`{code:200, msg:'ok', data}` | 被 `main.ts` 注册 |
| `common/filters/http-exception.filter.ts` | `@Catch()` 兜住一切异常，输出 `{code, msg, data:null}` | 被 `main.ts` 注册 |
| `common/decorators/skip-response.decorator.ts` | `@SkipResponse()`，元数据 key `skipResponse` | 被 SSE、文件下载三处使用 |
| `common/response.interface.ts` | `ApiResponse<T>` 类型定义 | **无任何 import 方**（只是契约文档） |
| `common/rate-limit/rate-limit.module.ts` | `@Global()` 模块 | 被 `app.module.ts` 登记 |
| `common/rate-limit/rate-limit.service.ts` | 按 userId 的固定窗口限流。`WINDOW_SECONDS=60`、`DEFAULT_MAX_REQUESTS=10`、`DEFAULT_SCOPE='ai'`；实现是 Redis `INCR` + 首次 `EXPIRE` + `TTL` | 被 `ai.controller.ts`、`chat.controller.ts` 调用 |
| `common/storage/storage.module.ts` | `@Global()` 模块 | 被 `app.module.ts` 登记 |
| `common/storage/storage.service.ts` | 本地磁盘存储。`root` = `UPLOAD_DIR ?? <cwd>/uploads`，`maxSize` = `UPLOAD_MAX_BYTES ?? 20MB`；`save(buffer, originalName)` 生成 `randomUUID()+ext`；`resolvePath()` **越界抛 `NotFoundException`** | 被笔记附件、聊天附件调用 |
| `common/upload/file-guard.ts` | 纯函数工具集（非 Nest 组件）。`ALLOWED_MIME` 白名单；`decodeFilename()` 修 multer 的中文乱码；`assertUploadable(file, maxBytes)` 做「空 → 体积 → MIME」三段校验 | 被笔记附件、聊天附件调用 |
| `common/user-shape.ts` | **用户对外形状的唯一来源**。`USER_PUBLIC_SELECT`（刻意排除 `password`）、`PublicUser`、`toPublicUser(row)` | 被 `auth.service.ts`、`user.service.ts` 调用 |

### 深读「统一响应三件套」：为什么用元数据而不是看 header

成功与失败两条路径**由两处独立代码维持同一个形状**：

```ts
// response.interceptor.ts —— 成功路径
intercept(ctx, next) {
  const skip = this.reflector.getAllAndOverride(SKIP_RESPONSE_KEY, [ctx.getHandler(), ctx.getClass()]);
  if (skip) return next.handle();
  return next.handle().pipe(map((data) => ({ code: 200, msg: 'ok', data })));
}

// http-exception.filter.ts —— 失败路径
@Catch()
catch(exception, host) {
  const status = exception instanceof HttpException ? exception.getStatus() : 500;
  // ...取 message，非 Http 异常回落 500
  res.status(status).json({ code: status, msg, data: null });
}
```

**关键点是放行机制用 `Reflector` 查元数据，而不是判断响应的 `Content-Type`。** 原因是：Nest 的 SSE 响应头是在**拦截器执行之后**才写进 `res` 的 —— 拦截器里看 header 会误判成普通 JSON，从而把 SSE 流包成 `{code,msg,data}`，直接毁掉协议。

`@SkipResponse()` 的实际使用点只有三处，每处都是因为它**不能**被 JSON 包装：

| 使用点 | 原因 |
|---|---|
| `ai.controller.ts` 的 `@Sse('chat/stream')` | SSE 是流，包一层就毁协议 |
| `notes/attachments.controller.ts` 的取流接口 | 二进制流被包成 JSON 会损坏文件 |
| `chat/chat.controller.ts` 的附件取流接口 | 同上 |

> 一个易被忽视的细节：过滤器里 `body.message` 可能是**数组**（class-validator 风格的多条错误），当前直接透传，前端需要自行容错。

### 深读「统一用户形状」：一个安全边界

```ts
export const USER_PUBLIC_SELECT = {
  id: true, email: true, nickname: true, handle: true, bio: true, createdAt: true,
} as const;   // ← 注意：没有 password，也没有 emailVerified
export const toPublicUser = (row) => ({ /* 仅做 null 归一化 */ });
```

`password`（bcrypt 哈希）不能外泄这件事，靠的是**全项目只从这里取用户形状**。`auth.service.ts` 的登录成功响应、`user.service.ts` 的 `getProfile()` 都必须经它收口 —— 少写一次 `select`，就会有哈希泄漏。

### 基础设施的三种「供给模式」

Prisma / Redis / Storage / RateLimit 四个模块**全部标了 `@Global()`**，模式统一为「providers + exports 同名 Service，消费方零 imports」。差异只在注册路径：

- `StorageModule` / `RateLimitModule`：根模块显式登记；
- `PrismaModule` / `RedisModule`：靠 `AuthModule` 间接登记（见 1.1 的隐性耦合）。

另外，`RedisService` 只暴露**原始 ioredis 实例**，业务层直接 `getClient().get/set/incr/del`，没有 Repository 抽象。代价是 key 命名散落在各处（`verify-code:*`、`ai:ticket:*`、`ai:conv:*`、`chat:online:*`、`ratelimit:*`），没有集中登记。

`RedisService.onModuleInit` 用 `ping()` 探活 —— **Redis 不可达会阻塞应用启动，而不是降级运行**。

## 1.3 认证域（auth + verification-code + mail）

### 文件清单

| 路径（`backend/src/`） | 注释 | 联动 |
|---|---|---|
| `auth/auth.module.ts` | 装配认证域。imports `PrismaModule, RedisModule, MailModule, VerificationCodeModule, JwtModule.register({})`（**空配置**，密钥在调用点现取 `process.env`）；providers `AuthService, MailService, PrismaService`（后两个与已 imports 的模块重复）；exports `AuthService` | 被 `app.module.ts` 登记 |
| `auth/auth.controller.ts` | 8 个**公开**端点（不挂守卫）：`POST register`（`@HttpCode(200)`）、`POST login`、`POST send-register-code`、`POST send-login-code`、`POST login-code`、`POST refresh`、`GET test-token`、`POST send-forgot-password-code`、`POST forgot-password` | 调用 `AuthService` 全部方法；依赖 8 个 DTO |
| `auth/auth.service.ts` | 认证核心：注册 / 密码登录 / 验证码登录 / 找回密码 / 双令牌签发与刷新 | 注入 `PrismaService`、`VerificationCodeService`、`MailService`、`JwtService`；调用 `toPublicUser` |
| `auth/guards/jwt-auth.guard.ts` | **通用访问令牌守卫，非全局，逐控制器挂载**。读 `Authorization: Bearer`，`verifyAsync({secret: JWT_ACCESS_SECRET})`，成功后把 `userId` / `userEmail` **直接挂到 express request 上** | 被 `user` / `notes` / `chat` 三个模块 provide 并挂载 |
| `auth/decorators/current-user.decorator.ts` | 参数装饰器 `@CurrentUser()`，取 `req.userId` | 被 4 个 controller 使用 |
| `auth/dto/register.dto.ts` | `RegisterDto`：`@IsEmail` + 密码 `@MinLength(6)` + 昵称 `@Length(2,20)` + 验证码 `@Length(6,6)` | 被 `auth.controller.ts` 的 `@Body()` 标注 |
| `auth/dto/login.dto.ts` | `LoginDto`：`@IsEmail` + `@IsString` | 同上 |
| `auth/dto/login-by-code.dto.ts` | `LoginByCodeDto`：验证码登录 | 同上 |
| `auth/dto/refresh.dto.ts` | `RefreshDto`：`@IsString` + `@IsNotEmpty` | 同上 |
| `auth/dto/send-register-code.dto.ts` | `SendRegisterCodeDto` | 同上 |
| `auth/dto/send-login-code.dto.ts` | `SendLoginCodeDto` | 同上 |
| `auth/dto/send-forgot-password-code.dto.ts` | `SendForgotPasswordCodeDto` | 同上 |
| `auth/dto/forgot-password.dto.ts` | `ForgotPasswordDto` | 同上 |
| —— | ⚠️ **上面 8 个 DTO 的 `class-validator` 装饰器运行时不生效**（全局没有 ValidationPipe），它们只是文档 | 校验实际写在 `auth.service.ts` 里 |
| `auth/auth.controller.spec.ts`、`auth/auth.service.spec.ts` | 脚手架单测，只断言 `toBeDefined()`；`providers: [AuthService]` **未 mock Prisma / Redis / Mail** | 无 |
| `verification-code/verification-code.module.ts` | imports `RedisModule`；controllers `VerificationCodeController`；providers/exports `VerificationCodeService` | 被 `app.module.ts` 登记，也被 `AuthModule` imports |
| `verification-code/verification-code.service.ts` | Redis 版验证码。`generate(type,email)` 写 `verify-code:{type}:{email}`（`EX 300`）与冷却 `verify-code:cooldown:{type}:{email}`（`EX 60`，冷却中抛 `BadRequestException`）；`verify()` 成功后立刻 `del` | 被 `auth.service.ts` 以 `'register' \| 'login' \| 'forgot-password'` 调用 |
| `verification-code/verification-code.controller.ts` | **空壳，无任何路由** | —— |
| `verification-code/dto/create-verification-code.dto.ts` | 空类 `CreateVerificationCodeDto`，无装饰器 | **死代码**，无引用 |
| `verification-code/dto/update-verification-code.dto.ts` | `PartialType(CreateVerificationCodeDto)`（来自 `@nestjs/mapped-types`） | **死代码**，无引用 |
| `verification-code/entities/verification-code.entity.ts` | 空类 `VerificationCode` | **死代码**，无引用 |
| `verification-code/verification-code.controller.spec.ts` | 脚手架单测，只断言 `toBeDefined()` | 无 |
| `verification-code/verification-code.service.spec.ts` | 脚手架单测，只断言 `toBeDefined()` | 无 |
| `mail/mail.module.ts` | controllers `MailController`、providers/exports `MailService` | 被 `app.module.ts` 登记；被 `AuthModule` imports |
| `mail/mail.service.ts` | nodemailer 封装。transporter 在**字段初始化时创建**（不是 `onModuleInit`）；唯一业务方法 `sendRegisterCode(email, code)`，含 HTML 模板 | ⚠️ 登录与找回也复用它，方法名会误导 |
| `mail/mail.controller.ts` | 空壳控制器，无路由 | —— |
| `mail/mail.controller.spec.ts`、`mail/mail.service.spec.ts` | 脚手架单测，只断言 `toBeDefined()` —— 注意 `MailService` 的测试**未 mock transporter**，构造即真连 | 无 |

### 深读 `auth.service.ts`：双令牌链路

```ts
private async generateTokens(user) {
  const payload = { sub: user.id, email: user.email };   // 两枚令牌 payload 完全相同
  const [accessToken, refreshToken] = await Promise.all([
    this.jwt.signAsync(payload, { secret: process.env.JWT_ACCESS_SECRET,  expiresIn: '15m' }),
    this.jwt.signAsync(payload, { secret: process.env.JWT_REFRESH_SECRET, expiresIn: '7d'  }),
  ]);
  return { accessToken, refreshToken };
}
```

| 方法 | 要点 |
|---|---|
| `register()` | `bcrypt.hash(password, 10)`；`emailVerified: true`（当前不强制验证邮箱） |
| `login()` | `bcrypt.compare`；返回 `{ user: toPublicUser(u), ...tokens }` |
| `loginByCode()` | 走 `verification-code` 的 `'login'` 类型 |
| `forgotPassword()` | 走 `'forgot-password'` 类型 |
| `refresh(refreshToken)` | 验 refresh → 按 `payload.sub` 回查用户 → **重签一整套**双令牌 |
| `sendRegisterCode / sendLoginCode / sendForgotPasswordCode` | 三个方法都调 `MailService.sendRegisterCode()`（见下） |

两个必须知道的性质：

**① 刷新是无状态的，令牌不可吊销。** 没有 token 版本号、没有 Redis 黑名单，`refresh` 只是「验签 → 查人 → 重签」。因此**旧 refreshToken 在 7 天内始终可重复使用**，改密码之后已签发的 accessToken / refreshToken 依然有效。要支持「改密即下线」必须引入版本号或黑名单。

**② `refresh` 的错误文案会失真。** 内部抛出的 `UnauthorizedException('用户不存在')` 会被 `try/catch` 一并吞掉，改写成 `'RefreshToken 无效或已过期'`，排查时要留意。

### 守卫怎么挂、公开接口怎么放行

```ts
// jwt-auth.guard.ts
const [scheme, token] = (req.headers.authorization ?? '').split(' ');
if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();
const payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
req.userId = payload.sub;
req.userEmail = payload.email;
```

三个要点：

1. **公开接口的放行机制就是「不挂守卫」** —— 全项目没有 `@Public()` 装饰器。`auth.controller.ts` 与 `app.controller.ts` 不挂，其余四个 controller 用类级 `@UseGuards(JwtAuthGuard)` 挂。要新增公开接口，就是新建一个不挂守卫的 controller。
2. **不走 passport，所以没有 `req.user`，也没有 `JwtStrategy` 文件。** `userId` 直接挂在 express request 上，由 `@CurrentUser()` 读。
3. **每个使用模块都要自己 `imports: [JwtModule.register({})]` + `providers: [JwtAuthGuard]`** —— 没有 `registerAsync` 全局配置，密钥在每个调用点用 `process.env.JWT_ACCESS_SECRET` 现取。这也意味着改密钥名要改多处。

顺带一提：`auth.controller.ts` 的 `test-token` 端点手写了一遍 `verifyAsync`，与守卫是重复逻辑。

### 验证码与邮件

```ts
// verification-code.service.ts
async generate(type, email) {
  const cooldownKey = `verify-code:cooldown:${type}:${email}`;
  if (await redis.exists(cooldownKey)) throw new BadRequestException('发送太频繁，请稍后再试');
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await redis.set(`verify-code:${type}:${email}`, code, 'EX', 300);      // 5 分钟
  await redis.set(cooldownKey, '1', 'EX', 60);                            // 60 秒冷却
  return code;
}
async verify(type, email, code) {
  const saved = await redis.get(key);
  if (!saved) throw new BadRequestException('验证码已过期');
  if (saved !== code) throw new BadRequestException('验证码错误');
  await redis.del(key);                                                   // 一次性
}
```

设计上正确的地方：**冷却与有效期分离**（60 秒防打扰、5 分钟可用）、**验证成功即焚**。另外注意验证码用的是 `Math.random()` 而不是密码学随机 —— 对「发到用户邮箱的 6 位码 + 60 秒冷却 + 5 分钟有效期」这个场景够用，但如果哪天改成短信验证码（有真实成本），建议换成 `crypto.randomInt`。

## 1.4 用户域

| 路径（`backend/src/user/`） | 注释 | 联动 |
|---|---|---|
| `user.module.ts` | imports 只有 `JwtModule.register({})`（**没 import PrismaModule**，靠 `@Global`）；providers `UserService, JwtAuthGuard` | 被 `app.module.ts` 登记 |
| `user.controller.ts` | `@Controller('user')` + 类级 `@UseGuards(JwtAuthGuard)`；唯一端点 `GET /user/profile` | 调 `UserService.getProfile()`；用 `@CurrentUser()` |
| `user.service.ts` | `getProfile(userId)`：`findFirst({where:{id, deletedAt:null}, select: USER_PUBLIC_SELECT})`，查不到抛 `NotFoundException`；导出 `type UserProfile = PublicUser` | 注入 `PrismaService`；用 `common/user-shape.ts` |
| `user.controller.spec.ts`、`user.service.spec.ts` | 脚手架单测，只断言 `toBeDefined()` | 无 |

这是最短的一条链：**token → userId → 查库 → 按 `USER_PUBLIC_SELECT` 收口**。前端 `lib/use-current-user.ts` 依赖它做「只有 token、没有用户资料」时的自愈补齐。

## 1.5 笔记域（notes + attachments）

### 文件清单

| 路径（`backend/src/notes/`） | 注释 | 联动 |
|---|---|---|
| `notes.controller.ts` | `@Controller('notes')` + `@UseGuards(JwtAuthGuard)`。`GET /notes?keyword=`、`POST /notes`、`GET /notes/:id`、`PATCH /notes/:id`、`DELETE /notes/:id` | 调 `NotesService` |
| `notes.service.ts` | **笔记业务核心**。`assertOwned` / `list` / `get` / `depthOf` / `resolveParent` / `create` / `subtreeHeight` / `move` / `update` / `collectSubtree` / `remove`；常量 `MAX_DEPTH = 6`、`LIST_SELECT`、`DETAIL_SELECT` | 被 `NotesController`、`AttachmentsService`、AI 的 `notes.tool.ts` 调用 |
| `notes.module.ts` | imports `JwtModule.register({})` + `StorageModule`；**exports `[NotesService]`** | 被 `AppModule` 与 `AiModule`、`ChatModule` 导入 |
| `attachments.controller.ts` | **独立 `/attachments` 前缀**（避免被 `@Get(':id')` 抢先匹配）；`POST /attachments`（`FileInterceptor('file')`，`limits.fileSize = 20MB`）、`GET /attachments?noteId=`、`GET /attachments/:id/content?download=`、`DELETE /attachments/:id` | 调 `AttachmentsService`；取流标 `@SkipResponse()` |
| `attachments.service.ts` | `assertOwned` / `upload` / `list` / `readContent` / `remove`。库中存 `decodeFilename(originalname)`，磁盘名是 UUID + 扩展名 | 注入 `PrismaService`、`StorageService` |
| `dto/note.dto.ts` | `CreateNoteDto(title≤120, content, parentId)`、`UpdateNoteDto(title, parentId 可 null, content, pinned)`、`UploadAttachmentDto` | 前两个被 controller 用；`UploadAttachmentDto` **未被引用** |

### 深读：Note 的树是怎么维护的

这是笔记模块里最复杂的一段，三个机制叠在一起：

**① 深度限制 `MAX_DEPTH = 6`**

```ts
// 从节点向上走到 parentId 为空，循环上限即 MAX_DEPTH —— 天然防死循环
async depthOf(noteId: string): Promise<number> {
  let depth = 1, cursor = noteId;
  while (depth <= MAX_DEPTH) {
    const row = await prisma.note.findUnique({ where: { id: cursor }, select: { parentId: true } });
    if (!row?.parentId) return depth;
    cursor = row.parentId; depth++;
  }
  return depth;
}
```

注意 `while (depth <= MAX_DEPTH)` 这个上界：**它既做业务限制，又顺手把「数据里已经存在的环」挡住** —— 万一历史数据有环，这个循环会退出而不是死循环。

**② 环检测（`move`）**

```ts
async move(userId, noteId, targetParentId) {
  await this.assertOwned(userId, noteId);
  if (targetParentId === noteId) throw new BadRequestException('不能移动到自己下面');
  if (targetParentId) {
    await this.assertOwned(userId, targetParentId);
    const subtree = await this.collectSubtree(noteId);      // 含自身
    if (subtree.includes(targetParentId)) throw new BadRequestException('不能移动到自己的子页面下');
  }
  const height = await this.subtreeHeight(noteId);
  const newDepth = targetParentId ? await this.depthOf(targetParentId) : 0;
  if (newDepth + height > MAX_DEPTH) throw new BadRequestException(`层级不能超过 ${MAX_DEPTH} 层`);
  await prisma.note.update({ where: { id: noteId }, data: { parentId: targetParentId } });
}
```

三个判断的顺序不能反：**先排除自身子树（`collectSubtree` 含自身，所以「目标是我的子孙」和「目标是我自己」能被同一次判断覆盖），再算高度是否超限**。搬家的代价是「目标父级深度 + 我这棵子树的高度」不能超过 6。

**③ 级联软删（`remove`）**

```ts
async remove(userId, noteId) {
  await this.assertOwned(userId, noteId);
  const ids = await this.collectSubtree(noteId);
  await prisma.note.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } });
  return { deleted: true, count: ids.length };            // 返回影响数量，前端如实提示
}
```

`collectSubtree` 是**逐层 BFS 查询**（每层一次 `findMany`，最多 6 层），不是递归 SQL。返回 `count` 是有意的：删除 12 篇时前端能说「已删除 12 篇」，而不是只说「已删除」。

schema 里 `Note.parent` 的 `onDelete: Cascade` 是**数据库层兜底**，业务上因为走软删除，它永远不会触发。

### 深读：文件上传的四道防线

```ts
// ① MIME 白名单（common/upload/file-guard.ts）
export const ALLOWED_MIME = new Set([
  'application/pdf', 'text/markdown', 'text/plain',
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'application/msword', 'application/vnd.openxmlformats-officedocument.*',
  'application/zip', 'application/x-zip-compressed', 'video/mp4',
]);   // ← 刻意不放行 text/html 与 image/svg+xml

// ② 体积：FileInterceptor 的 limits.fileSize = 20MB，StorageService.maxSize 再兜一道
// ③ 文件名：磁盘名 = randomUUID() + 原扩展名.toLowerCase().slice(0, 16)
// ④ 取流鉴权：findFirst({ id, userId })，不命中统一 404
```

**为什么排除 html 与 svg**：两者都能携带脚本。即使 `Content-Disposition: attachment` 阻止了直接渲染，只要有任何一个路径把附件当页面返回（或用户下载后误开），就是一个存储型 XSS 的入口。不放行是最省事的根治。

**为什么磁盘名要 UUID + 扩展名**：同时解决两件事 —— 同名覆盖（两个用户传 `简历.pdf`）与路径穿越（文件名里带 `../`）。

**中文文件名的坑**：multer 会把 `originalname` 当 latin1 解码，中文会变乱码。所以入库前要 `decodeFilename()`：

```ts
export const decodeFilename = (name: string) => Buffer.from(name, 'latin1').toString('utf8');
```

**下载头要用 RFC 5987**：

```ts
res.setHeader('Content-Disposition',
  `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
res.setHeader('Content-Type', mimeType);
```

用 `filename*=UTF-8''` 而不是 `filename=` 是中文文件名能正确显示的关键。

### 深读：`DETAIL_SELECT` 与那句「不能用 `?? null`」

这两处都是**踩过坑之后留下的防御**，注释在代码里写得很直白。

```ts
const LIST_SELECT = { id: true, title: true, pinned: true, parentId: true, updatedAt: true } as const;
const DETAIL_SELECT = { ...LIST_SELECT, content: true, attachments: { select: ATTACHMENT_META } } as const;
```

**为什么要有 `DETAIL_SELECT`**：早期创建/更新用的是 `{ ...LIST_SELECT, content: true }`，**漏了 `attachments`**。前端 `NoteDetail` 类型把 `attachments` 当必填，于是「新建笔记后读 `.length`」直接 TypeError。把 select 抽成常量共用，就是防止再漏。这类 bug 的教训是：**接口出参的形状必须有单一来源**（和 `USER_PUBLIC_SELECT`、`MESSAGE_SHAPE` 同一个思路）。

**为什么 `update()` 严格区分 `undefined` 与 `null`**：

```ts
if (dto.parentId !== undefined) data.parentId = dto.parentId;   // null = 移到顶层，undefined = 不动层级
```

写成 `data.parentId = dto.parentId ?? null` 会让「只想改标题」的请求把笔记悄悄移到顶层。这是 PATCH 语义的经典坑。

## 1.6 聊天域

### 文件清单

| 路径（`backend/src/chat/`） | 注释 | 联动 |
|---|---|---|
| `chat.module.ts` | 装配聊天域。imports `JwtModule` + **`NotesModule`**；providers 5 个 service + `JwtAuthGuard` + `ChatGateway`；**exports `ConversationsService`、`MessagesService`**；另挂一个 **1 小时周期的孤儿附件清理定时器**（`CLEANUP_INTERVAL_MS=1h`、`ORPHAN_AGE_HOURS=24`） | 被 `AppModule` 登记；依赖 `NotesService` |
| `chat.controller.ts` | `@Controller('chat')` + `@UseGuards(JwtAuthGuard)`，14 个端点（见下）。私有 `assertRateLimit`（发消息 30/min、上传 20/min，超限 429） | 调 5 个 service + `RateLimitService` + `ChatGateway.pushToMembers` |
| `chat.gateway.ts` | socket.io 网关，命名空间 `chat`。握手鉴权、在线状态、入房、typing/read 转发、消息与已读推送 | 用 `JwtService`、`RedisService`、`ConversationsService`；被 controller 调用推送 |
| `conversations.service.ts` | 会话读写与成员鉴权：`assertMember` / `memberIds` / `myConversationIds` / `getOne` / `list` / `create` / `createDirect` / `createGroup` / `updateFlags` / `markRead` | 被 controller、`messages.service`、`share.service`、gateway 调用 |
| `messages.service.ts` | 消息写入与游标分页。`list` / `send` / `createNoteMessage` / `insertMessage` / `writeAttachmentMessage` / `writeNoteMessage`；`clampPageSize`（默认 30，上限 100） | 调 `ConversationsService.assertMember`、`NotesService.get`、`toMessage` |
| `friends.service.ts` | 好友关系：双向写、搜索脱敏、在线状态、断言。`SEARCH_LIMIT=20`；导出 `onlineKey`、静态 `maskEmail` | 被 controller、`conversations.service`、`share.service` 调用 |
| `share.service.ts` | 分享笔记给好友：**逐个好友**复用/建单聊后写笔记卡片；**部分失败不回滚**，全部失败才抛错 | 调 `friends.assertFriends`、`conversations.createDirect`、`messages.createNoteMessage` |
| `chat-attachments.service.ts` | 附件校验/落盘/鉴权读取/孤儿清理。`MAX_BYTES` 默认 50MB；`readContent` **两条准入路径** | 调 `StorageService`、`file-guard`、`toAttachment` |
| `chat.mapper.ts` | **「库行 → 接口出参」的唯一转换点**。导出 `USER_SHAPE` / `ATTACHMENT_SHAPE` / `MESSAGE_SHAPE` / `CONVERSATION_SHAPE` 与 `toAttachment/toMessage/toConversation/toFriend` | 被 4 个 service 调用；出参对齐前端 `types/chat.ts` |
| `dto/conversation.dto.ts` | `CreateConversationDto{kind, friendId, title, memberIds}`、`UpdateConversationDto{pinned, muted}` | 跨字段校验由 service 兜底 |
| `dto/friend.dto.ts` | `AddFriendDto{userId}` | —— |
| `dto/message.dto.ts` | `SendMessageDto{text, attachmentId, noteId}`（收 id 不收对象） | —— |
| `dto/share.dto.ts` | `ShareNoteDto{noteId, toFriendIds, comment}`，**刻意不含 title / childCount** | 防前端伪造快照 |
| `types/chat-events.ts` | 出参与实时事件的形状契约：`Presence` / 各种 DTO / `ChatServerEvent` / `ChatClientEvent` | 与前端 `types/chat.ts` **一一对应** |

### REST 路由表

| 方法 + 路径 | 作用 | 备注 |
|---|---|---|
| `GET /chat/friends` | 我的好友列表 | 带在线状态 |
| `GET /chat/users?keyword=` | 搜索用户 | **空关键词返回空数组**，不返回全量 |
| `POST /chat/friends` | 加好友 | 幂等，双向写两行 |
| `DELETE /chat/friends/:userId` | 删好友 | 两个方向一起删 |
| `GET /chat/conversations` | 会话列表 | 置顶优先 → 最后消息时间，**后端排序** |
| `POST /chat/conversations` | 按 `kind` 分流建单聊 / 建群 | 单聊走 `directKey` 去重 |
| `PATCH /chat/conversations/:id` | 置顶 / 免打扰 | **只改自己那一行**（成员维度） |
| `POST /chat/conversations/:id/read` | 标记已读 | 改库 + 推 `read` 事件 |
| `GET /chat/conversations/:id/messages?before=&limit=` | 历史消息 | 游标分页，返回**时间正序** |
| `POST /chat/conversations/:id/messages` | 发消息 | 三者至少一个；限流 30/min |
| `POST /chat/notes/share` | 分享笔记给好友 | —— |
| `POST /chat/attachments` | 上传附件 | 字段名 `file`；限流 20/min；50MB |
| `DELETE /chat/attachments/:id` | 删除尚未发送的附件 | —— |
| `GET /chat/attachments/:id/content?download=` | 取流 | `@SkipResponse()`，二进制 |

### WebSocket 网关

单通道设计：所有服务端事件都走名为 `event` 的频道，载荷自带 `type` 做区分。

```ts
// 握手鉴权：两种来源，都不走 URL query
const token = client.handshake.auth?.token
           ?? client.handshake.headers.authorization?.replace('Bearer ', '');
const payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
// 失败：client.disconnect()，不留在连接池里

// 入房：连上就 join 自己全部会话 + 以 userId 命名的房间
for (const id of await conversations.myConversationIds(userId)) socket.join(`conv:${id}`);
socket.join(userId);                        // 多端识别用
await redis.set(onlineKey(userId), '1', 'EX', 120);
```

| 方向 | 事件 | 载荷 |
|---|---|---|
| 客户端 → 服务端 | `typing` | `{ conversationId, typing }` |
| 客户端 → 服务端 | `read` | `{ conversationId }` |
| 服务端 → 客户端 | `event` | `{type:'message', message}` |
| 服务端 → 客户端 | `event` | `{type:'typing', conversationId, userId, typing}` |
| 服务端 → 客户端 | `event` | `{type:'read', conversationId, userId}` |
| 服务端 → 客户端 | `event` | `{type:'presence', userId, presence}` |

三个设计点：

1. **令牌不放 URL query。** query 会进访问日志、代理记录、Referer。所以走 `auth` 或 `Authorization` 头。
2. **在线状态用 Redis TTL 120 秒 + engine.io 心跳续期兜底。** 进程崩溃时不会留下「永远在线」的僵尸状态。
3. **`presence` 是唯一走 `broadcast` 的事件**，其余业务事件一律 `pushToMembers`（只推给相关会话成员）。

### 深读：消息写入是一个事务

```ts
// messages.service.ts
private async insertMessage(...) {
  return this.prisma.$transaction(async (tx) => {
    const message = await tx.chatMessage.create({ data: {...}, select: MESSAGE_SHAPE });
    await tx.chatConversation.update({ where: { id: conversationId }, data: { updatedAt: new Date() } });
    await tx.chatConversationMember.updateMany({
      where: { conversationId, userId: { not: senderId } },     // ← 不给发送者自己加未读
      data: { unread: { increment: 1 } },
    });
    return message;
  });
}
```

三件事必须原子：写消息、顶会话时间（让列表按活跃排序）、给**非发送者**累加未读。漏掉 `userId: { not: senderId }` 就会出现「自己发的消息让自己有未读」。

### 深读：未读/置顶/免打扰为什么放在成员维度

放在 `ChatConversationMember` 而不是 `ChatConversation`，是因为它们**是每个人自己的状态**：

```ts
// 群聊里只有我标记已读
async markRead(conversationId, userId) {
  await this.prisma.chatConversationMember.update({
    where: { conversationId_userId: { conversationId, userId } },
    data: { unread: 0, lastReadAt: new Date() },
  });
}
```

如果放会话上，`unread` 就是一个共享计数器 —— A 点开会话会把 B 的未读也清零。这是 IM 数据建模里最容易出错的一处。

更新入口一共三个：`PATCH /chat/conversations/:id`（`updateFlags`）、`POST .../read`（`markRead`）、以及 `insertMessage` 里的 `unread + 1`。

### 深读：单聊去重靠唯一约束，不靠「先查再建」

```ts
// directKey = 两个成员 id 排序后用 ':' 连接
const directKey = [a, b].sort().join(':');
const existing = await prisma.chatConversation.findUnique({ where: { directKey } });
if (existing) {
  // 复用：把两个人的 leftAt 重置、unread 清零
  return existing;
}
return prisma.chatConversation.create({ data: { kind: 'DIRECT', directKey, members: { create: [...] } } });
```

注意这里的 `findUnique` + `create` **看起来**是「先查再建」，但因为有 `directKey @unique`，真正的并发安全由数据库唯一约束保证：两个请求同时创建时，会有一个抛唯一冲突而不是产生两条单聊。（这也是为什么 schema 注释强调「靠唯一约束去重，而不是先查再建 —— 后者在并发下有窗口」。）

复用分支要**重置 `leftAt` 并把 `unread` 清零**：删好友后重新加回、或退出群后又被拉回来的场景。

### 深读：附件取流的两条准入路径

```ts
async readContent(userId, attachmentId) {
  const att = await prisma.chatAttachment.findUnique({ where: { id: attachmentId } });
  if (!att) throw new NotFoundException('附件不存在或无权访问');

  if (att.messageId) {
    // 已挂消息：必须是该消息所属会话的成员
    const msg = await prisma.chatMessage.findUnique({ where: { id: att.messageId } });
    await conversations.assertMember(msg.conversationId, userId);
  } else {
    // 还没发送：只有上传者本人能看
    if (att.uploaderId !== userId) throw new NotFoundException('附件不存在或无权访问');
  }
  return { att, buffer: await storage.read(att.storageKey) };
}
```

这条「已挂消息看会话成员、未挂消息看上传者」的双分支是必要的 —— 上传后立刻预览时消息还不存在，只靠会话成员校验会 404。

### 深读：分享笔记的流程（聊天域 × 笔记域的交界）

```
pages/notes 右键「分享给好友」
  → ShareToFriendDialog（消费 useChatStore 的好友列表）
  → POST /chat/notes/share { noteId, toFriendIds, comment }
  → ShareService.share()
       for 每个 friendId:
         friends.assertFriends(userId, friendId)        // 必须是好友
         conversations.createDirect(userId, friendId)   // 复用或建单聊
         messages.createNoteMessage(...)                // 内部调 NotesService.get() 做归属校验 + 取快照
       → 部分失败不回滚，返回 { conversationCount, messageCount }
```

三个设计决策：

1. **分享给多人 = 每人一条单聊，而不是建一个群。** 否则收件人之间会互相暴露。
2. **快照（标题/类型/子页面数）由服务端按 `noteId` 现取**，`ShareNoteDto` 刻意不收 `title`。这样前端无法伪造一个「标题是 A、实际分享是 B」的卡片。
3. **部分失败照常返回成功部分。** 分享给 5 个人、其中 1 个已删号，其余 4 个应该成功 —— 所以只在**全部失败**时才抛错（且透传 404 原因）。

### 深读：`chat.mapper.ts` 为什么必须存在

`MESSAGE_SHAPE` 在**四处**被复用：会话列表的 `lastMessage`、历史消息、发送后的返回、分享写入时。如果每处各写一份 `select`，必然出现「会话列表里的消息少了个字段、点进去才正常」这类 bug。

所以这里和笔记域的 `DETAIL_SELECT`、身份域的 `USER_PUBLIC_SELECT` 是同一个模式：**出参形状必须有唯一来源**。

其中有一行注释值得单独记住：

```ts
CONVERSATION_SHAPE.members = { where: { leftAt: null }, select: { userId: true }, orderBy: { joinedAt: 'asc' } };
//                                                            ↑ 这一条不能删：前端按下标给群成员分配配色，
//                                                              而 SQL 不保证无 ORDER BY 的顺序
```

## 1.7 AI 域

### 文件清单

| 路径（`backend/src/ai/`） | 注释 | 联动 |
|---|---|---|
| `ai.module.ts` | 装配 AI 域。imports `PrismaModule`、**`NotesModule`**、`JwtModule`；providers `AiService`、`ToolRegistry`、`ConversationRepository`、`StreamTicketGuard`、`ChatModelFactory`；`onModuleInit` 调 `registerAllTools()` | 被 `AppModule` 登记 |
| `ai.controller.ts` | `GET /ai/models`、`POST /ai/chat/ticket`、`@Sse('chat/stream')`、`GET /ai/conversations`、`DELETE /ai/conversations/:id`、`GET /ai/conversations/:id/messages`。常量 `TICKET_TTL_SECONDS = 30` | 调 `AiService`、`ConversationRepository`、`ChatModelFactory`、`RateLimitService`、`createUserScopedTools`、`NotesService` |
| `ai.service.ts` | **Agent Loop 与 SSE 桥接**：把 LLM 流翻译成 `StreamEvent`。`toSse` / `runAgent` / `accumulateUsage` / `logRun` / `invokeTool` / `executeWithRetry` / `toText`；常量 `MAX_ITERATIONS = 8`、`HEARTBEAT_INTERVAL_MS = 15000` | 被 `chatStream` 调用；用 `ChatModelFactory`、`ToolRegistry`、`DEFAULT_SYSTEM_PROMPT` |
| `guards/stream-ticket.guard.ts` | SSE 一次性票据鉴权。Redis key `ai:ticket:${ticket}`，**GET 后立即 DEL** | 挂在 `/ai/chat/stream` |
| `llm/llm.provider.ts` | `ChatModelFactory`：按模型名缓存 `ChatOpenAI` 实例；读 `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `CHAT_MODEL_NAME` / `CHAT_MODEL_OPTIONS` / `CHAT_MODEL_TEMPERATURE` / `CHAT_STREAM_TIMEOUT_MS`；`resolve()` 做**白名单校验** | 被 `AiService`、`AiController` 调用 |
| `memory/conversation.repository.ts` | **双层会话记忆**：Redis 热缓存 + Prisma 持久化。`createConversation` / `updateModelIfChanged` / `listConversations` / `assertOwned` / `appendMessage` / `loadHistory` / `softDeleteConversation`；`HISTORY_LIMIT=20`、`CACHE_TTL_SECONDS=1800`、key `ai:conv:${id}` | 被 `AiController` 调用 |
| `prompts/system.prompt.ts` | `DEFAULT_SYSTEM_PROMPT` 常量（回答风格 / 工具使用 / 身份说明 / 笔记操作四段） | 被 `runAgent` 用作 SystemMessage |
| `tools/tool.registry.ts` | 工具注册表。`register` / `list` / `get` / `policy`；`ToolPolicy{timeoutMs, retries, roles?, write?}`；默认 `timeoutMs=15000`、`retries=1` | 被 `ai.module.ts`、`tools/index.ts`、`AiService` 调用 |
| `tools/index.ts` | 工具总出口。`registerAllTools()`（**只注册全局的 `query_user`**）+ `createUserScopedTools(prisma, userId, notes)`（9 个**请求级**工具） | 被 `ai.module.ts.onModuleInit` 与 `ai.controller.ts` 调用 |
| `tools/notes.tool.ts` | 笔记类工具工厂，**全部走 `NotesService`** 以复用归属校验。`CONTENT_LIMIT = 4000` | 被 `tools/index.ts` 调用 |
| `tools/conversation.tool.ts` | 会话类工具工厂，**闭包注入 userId** | 被 `tools/index.ts` 调用 |
| `tools/user-info.tool.ts` | 全局示例工具 `query_user` | 被 `registerAllTools` 调用 |
| `dto/chat.dto.ts` | `ChatDto{question, conversationId}` | **未被引用**（死代码） |
| `types/stream-event.ts` | SSE 事件协议类型：`start` / `token` / `reasoning` / `tool_call` / `tool_result` / `error` / `done` | 与前端 `types/agent.ts` **镜像同构** |

### 深读：SSE 为什么要两段式换票

**问题的起点**：浏览器的 `EventSource` 不能自定义请求头，所以无法带 `Authorization`。而把 JWT 直接放进 URL query 会泄漏到访问日志、代理记录和 Referer。

**解法**：先用正常的 axios 请求（可以带 Bearer）换一张**一次性票据**，再用票据开流。

```ts
// ① 发票（AiController.createTicket）—— 走 JWT 守卫
const payload = await this.jwt.verifyAsync(token, { secret: process.env.JWT_ACCESS_SECRET });
await this.rateLimit.check(payload.sub);                                  // scope 'ai'
const ticket = randomUUID();
await redis.set(`ai:ticket:${ticket}`, JSON.stringify({ userId: payload.sub, allowWrite }),
                'EX', 30);                                                // TICKET_TTL_SECONDS = 30
return { ticket, allowWrite: body?.allowWrite === true };

// ② 验票（StreamTicketGuard）—— 取完即焚
const raw = req.query.ticket;
const value = await redis.get(`ai:ticket:${raw}`);
await redis.del(`ai:ticket:${raw}`);                                      // ← 关键：一次性
req.userId = parsed.userId;
req.allowWrite = parsed.allowWrite;
```

三个设计点：

1. **票据 30 秒、且取完即焚。** 即使票据泄漏（比如被日志记下），它也只在极短窗口内有效、且只能用一次。
2. **`allowWrite` 随票签发。** 写操作的授权状态不在 URL 里，而是在票据的值里 —— 客户端无法在开流时篡改。
3. 守卫还兼容早期「票就是纯 userId 字符串」的格式（用 `raw.startsWith('{')` 判断），属于向后兼容。

### 深读：Agent Loop

```ts
async *runAgent({ userId, history, question, tools, allowWrite, signal }) {
  const messages = [new SystemMessage(DEFAULT_SYSTEM_PROMPT), ...history, new HumanMessage(question)];

  for (let i = 0; i < MAX_ITERATIONS; i++) {           // MAX_ITERATIONS = 8
    const stream = await model.stream(messages, { signal });
    let text = ''; const toolCalls = [];

    for await (const chunk of stream) {
      text += this.toText(chunk);                       // 兼容 string 与分片数组
      const reason = chunk.additional_kwargs?.reasoning_content;
      if (reason) yield { type: 'reasoning', content: reason };   // 思维链单独成事件
      toolCalls.push(...(chunk.tool_call_chunks ?? []));
    }
    if (text.trim()) yield { type: 'token', content: text };       // 简化示意：实际是逐 chunk yield

    if (!toolCalls.length) { yield { type: 'done', finishReason: 'stop' }; return; }

    messages.push(assistantWithToolCalls);              // 把这次的工具调用意图回灌
    for (const call of toolCalls) {
      yield { type: 'tool_call', id: call.id, name: call.name, args: call.args };
      const result = await this.invokeTool(call, { userId, tools, allowWrite });
      yield { type: 'tool_result', id: call.id, name: call.name, ...result };
      messages.push(new ToolMessage({ content: result.result, tool_call_id: call.id }));
    }
  }
  yield { type: 'error', code: 'MAX_ITERATIONS', message: '...' };
  yield { type: 'done', finishReason: 'max_iterations' };
}
```

几个关键设计：

**① 工具策略与写保护**

```ts
// tool.registry.ts 默认策略
{ timeoutMs: 15000, retries: 1 }

// invokeTool 里的写保护
const policy = this.registry.policy(name);
if (policy.write && !allowWrite) {
  return { ok: false, result: '当前会话未获得用户授权，无法修改数据，请告知用户开启「允许 AI 修改数据」' };
}
```

注意这里**不是抛错，而是返回一段文本**。因为抛错会中断整轮对话，而返回文本能让**模型自己转告用户**「你需要先授权」—— 体验好得多。

**② 写工具的 `retries` 必须是 0**

```ts
// 写操作一律 retries: 0
{ timeoutMs: 15000, retries: 0 }
```

原因写在注释里：超时是用 `Promise.race` 实现的，**它不会取消底层已经发起的写入**。如果重试，一次超时会变成「保存成两篇笔记」。这是一个很实际的坑。

**③ 删除工具的第二道闸**

```ts
delete_my_note 的参数里要求 confirmedByUser: boolean
```

即使 `allowWrite` 已开，删除也需要模型显式声明「用户已确认」。防止「一句话就把笔记删了」。

### 工具清单（10 个）

| 工具名 | 作用 | 参数 | 写? |
|---|---|---|---|
| `query_user` | 按邮箱/昵称查用户 | `{keyword}` | —— 全局注册 |
| `list_my_conversations` | 列最近会话 | `{limit? 1–20，默认 5}` | |
| `read_my_conversation` | 读某会话历史 | `{conversationId, limit? 1–50，默认 20}` | |
| `rename_my_conversation` | 改会话标题 | `{conversationId, title 1–60}` | ✅ |
| `list_my_notes` | 列笔记树（缩进文本），**兼作查 id 入口** | `{keyword?, limit? 1–100，默认 50}` | |
| `read_my_note` | 读笔记正文/子页/附件（**正文截断 4000**） | `{noteId}` | |
| `create_my_note` | 新建笔记 | `{title 1–120, content, parentId?}` | ✅ |
| `write_my_note` | 写入正文，**默认 append** | `{noteId, content, mode? 'append'\|'replace'}` | ✅ |
| `update_my_note` | 改标题/置顶/移动 | `{noteId, title?, pinned?, parentId?}` | ✅ |
| `delete_my_note` | 删除（含子树） | `{noteId, confirmedByUser}` | ✅ |

**「注册」这件事有个容易误解的地方**：`ai.module.ts` 的 `onModuleInit` 调 `registerAllTools()`，名字像是「注册全部工具」，实际上**只注册全局的 `query_user`**。9 个会话/笔记类工具全部由 `createUserScopedTools(prisma, userId, notes)` **每次请求新建**。

这是有意的：这些工具必须把 `userId` 注入闭包，才能从源头做到数据隔离 —— 模型即使在参数里编一个别人的 `noteId`，工具内部的 `NotesService.assertOwned(userId, ...)` 也会把它挡掉。

```ts
// notes.tool.ts 的写法
export const createUpdateNoteTool = (notes: NotesService, userId: string) =>
  tool(async ({ noteId, title, pinned }) => {
    // ① 归属校验在 NotesService 里（404 而非 403）
    // ② 不直接 prisma.note.update —— 否则会绕过全部业务规则（层级、软删、数量返回）
    const note = await notes.update(userId, noteId, { title, pinned });
    return JSON.stringify({ success: true, noteId: note.id });
  }, { name: 'update_my_note', ... });
```

**为什么工具内部走 `NotesService` 而不直接用 Prisma**：复用归属校验（`assertOwned`）、层级规则、软删语义。直接 Prisma 会让 AI 绕过所有业务规则，也能越权改别人的笔记。

### 深读：SSE 的桥接与心跳

```ts
toSse(source: AsyncGenerator<StreamEvent>, signal: AbortSignal): Observable<MessageEvent> {
  return new Observable((subscriber) => {
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) subscriber.next({ data: ':ping' } as MessageEvent);   // 冒号开头 = SSE 注释行
    }, HEARTBEAT_INTERVAL_MS);                                           // 15000

    (async () => {
      try {
        for await (const event of source) {
          if (signal.aborted) break;
          subscriber.next({ data: JSON.stringify(event) });
        }
      } catch (err) {
        // 注意：不用 subscriber.error —— 那样会被全局异常过滤器接管，
        // 把已经发了一半的流替换成 JSON 错误体
        subscriber.next({ data: JSON.stringify({ type: 'error', message: ... }) });
      } finally {
        clearInterval(heartbeat); closed = true; subscriber.complete();
      }
    })();

    return () => { signal.aborted ? null : controller.abort(); };         // 客户端断开 → 中止 LLM
  });
}
```

四个要点：

1. **心跳用 `:ping`（SSE 注释行）**，不是协议事件。前端解析时 `if (line.startsWith(':')) continue`。它的作用是穿过中间的代理/网关（它们会掐掉长时间无数据的连接）。
2. **异常走 `next` 而不是 `error`。** 这是为了不让全局异常过滤器介入 —— 流已经开始发送了，如果此时 `error`，Nest 会尝试再写一个 JSON 响应，结果就是一个坏掉的流。
3. **客户端断开时 `controller.abort()` 中止 LLM 请求** —— 这是**真正停止计费**的地方，不只是前端停止渲染。
4. `signal` 一路从 controller 透传到 `model.stream()`。

### 深读：双层会话记忆

```ts
// conversation.repository.ts
const CACHE_TTL_SECONDS = 1800;   // 30 分钟热区
const HISTORY_LIMIT = 20;         // 最近 20 条

async loadHistory(conversationId) {
  const key = `ai:conv:${conversationId}`;
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const rows = await prisma.message.findMany({
    where: { conversationId }, orderBy: { createdAt: 'asc' }, take: -HISTORY_LIMIT,
  });
  await redis.set(key, JSON.stringify(rows), 'EX', CACHE_TTL_SECONDS);    // 回填
  return rows;
}

async appendMessage(conversationId, msg) {
  await prisma.message.create({ data: { conversationId, ...msg } });
  // 写穿缓存：读 → push → trim 到 20 → setex
}
```

**落库时机的四种情况**（这块最容易出错）：

| 情况 | 时机 | 原因 |
|---|---|---|
| 用户消息 | 开流时先 `appendMessage({role:'user'})`，**再** yield `start` | 保证 `start` 事件拿到 `messageId` 时用户消息已在库 |
| 助手最终回复 | 收到结束信号时 `await persistAssistant()` —— **先落库、再下发 `done`** | 否则客户端收到 `done` 立刻发下一轮，那一轮读到的历史里还没有这一轮的回复，多轮记忆会随机失效 |
| 异常 / 中断 | `finally` 兜底落库，用 `persisted` 标志保证幂等 | 中途断流也要保住已生成的部分 |
| 工具轨迹 | `tool_call` / `tool_result` 以 `role:'tool'` **fire-and-forget** 落库 | 仅用于审计，不阻塞主流程 |

**Redis 异常时静默降级**：`loadHistory` 的缓存读写包了 try/catch，失败就直查 DB。这是对的 —— 缓存不该成为可用性的单点。

另一个细节：`chatStream` 在组装历史时**过滤掉了 `tool` 角色**，只保留 `user` 与「有内容的 assistant」。因为工具轮次依赖 `tool_calls` 配对，单独把 tool 消息塞进上下文会破坏配对关系，导致上游 API 报错。

### 深读：LLM 提供方

```ts
// llm.provider.ts —— 一个工厂通吃所有 OpenAI 兼容端点
private get(modelName: string) {
  if (this.cache.has(modelName)) return this.cache.get(modelName);
  const model = new ChatOpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    configuration: { baseURL: process.env.OPENAI_BASE_URL },   // ⚠️ 不要自带 /v1，SDK 会补 /chat/completions
    model: modelName,
    temperature: Number(process.env.CHAT_MODEL_TEMPERATURE ?? 0.3),
    streaming: true,
    maxRetries: 1,
    timeout: Number(process.env.CHAT_STREAM_TIMEOUT_MS ?? 120000),
  });
  this.cache.set(modelName, model);
  return model;
}

resolve(requested?: string) {
  const names = this.availableModelNames();                  // CHAT_MODEL_OPTIONS
  if (requested && names.includes(requested)) return this.get(requested);
  if (requested) console.warn(`未知模型 ${requested}，回落默认`);
  return this.get(this.defaultModelName());
}
```

要点：

1. **`baseURL` 不能带 `/v1`** —— LangChain 的 OpenAI SDK 会自动拼 `/chat/completions`，带了会变成 `/v1/v1/...`。
2. **白名单校验不能省**：`resolve()` 只接受 `CHAT_MODEL_OPTIONS` 里的名字。否则客户端传任意 `model` 参数就成了「探测上游有哪些模型」。命中不了就回落默认 + warn。
3. **实例按模型名缓存**，复用连接池。
4. **`reasoning_content` 的处理**：DeepSeek-R1 / QwQ 这类推理模型会把思维链放在 `chunk.additional_kwargs.reasoning_content`，代码单独抽出成 `reasoning` 事件下发。前端目前**不渲染**它（见 2.8），但采集是完整的。
5. **usage 累加**同时兼容两个位置（LangChain v1 的 `usage_metadata` 与 `response_metadata.token_usage`），跨轮累加。

### 深读：系统提示词

`prompts/system.prompt.ts` 的 `DEFAULT_SYSTEM_PROMPT` 分四段：**回答风格 / 工具使用 / 身份说明 / 笔记操作**。这是决定「助手像不像样」的核心杠杆，比换模型影响更大。

值得注意的写法约束：提示词里明确要求「先查 id 再操作」。这解释了一个现象 —— 让模型改一篇笔记时，它通常会先调 `list_my_notes` 再调 `update_my_note`。**这是设计意图，不是模型跑偏**（`list_my_notes` 在设计上就兼作「查 id」入口）。写测试断言时不要要求它一步到位。

---

# Part 2　前端逐文件详解

## 2.1 入口与全局装配

| 路径（`frontend/`） | 注释 | 联动 |
|---|---|---|
| `src/main.tsx` | 应用入口。`createRoot`；`import './index.css'` 与副作用 `import './request/setup'`；`StrictMode` **被注释掉了** | 引入 `index.css`、`request/setup.ts`、`App.tsx` |
| `src/App.tsx` | 应用根组件。渲染 `<RequestFeedback/>`、`<Toaster/>`、`<RouterProvider router={router}/>` | 用 `router/index.tsx` |
| `src/index.css` | 全局样式与**两套设计令牌**（见下） | 被 `main.tsx` 引入 |
| `src/App.css` | 遗留样式文件（基本未使用） | —— |
| `vite.config.ts` | `plugins: [react(), tailwindcss()]`；别名 `@` → `src`（用 `fileURLToPath(new URL('.', import.meta.url))` 解析，避免 `__dirname` 在 ESM 下不存在） | 全站 `@/` 导入都依赖它 |
| `components.json` | shadcn/ui 配置：style `new-york`、baseColor `slate`、`cssVariables: true` | 指向 `tailwind.config.ts` 与 `src/index.css` |

### 深读 `index.css`：两套令牌并存

这是全站视觉的单一来源，也是**踩坑最多的地方**。

**① 两套令牌**

| 体系 | 变量 | 用途 | 生成的工具类 |
|---|---|---|---|
| shadcn HSL | `--background` / `--foreground` / `--primary` / `--border` / `--radius` … | 全站默认（暖白 + indigo） | `bg-background` / `text-foreground` … |
| Telegram 主题 | `--tg-brand` / `--tg-bubble-out` / `--tg-surface` / `--tg-border` … | **只作用于 `/chat`** | `bg-tg-surface` / `border-tg-border` … |

两者都写在 `:root`，并通过 `@theme inline` 注册成 `--color-*` / `--color-tg-*`，从而得到具名工具类。

**② 为什么 `--tg-*` 放 `:root` 而不是 `.tg-app`**

因为 shadcn 的 Dialog 走 Radix Portal **渲染到 body**，挂在聊天页 DOM 上的变量在弹窗里取不到 —— 弹窗会拿到空值。这是「为什么不能按页面作用域收窄」的答案。

**③ 三个 Tailwind v4 的静默失效**（都已经修掉了，但必须记住，否则会重犯）

| 坑 | 现象 | 成因 | 解法 |
|---|---|---|---|
| 未分层 CSS 压掉工具类 | 全站所有 `border-<color>` 都渲染成同一个默认灰 | `index.css` 里 `* { @apply border-border }` 写在**最外层**；Tailwind v4 把工具类放进 `@layer utilities`，而**未分层 CSS 的优先级高于任何分层 CSS**（与选择器权重无关，`*` 也能压住 `.border-red-500`） | 收进 `@layer base` |
| `border-[color:var(--x)]` 不生成规则 | 描边色回落到默认值，**不报错** | Tailwind v4 下 `bg-` / `text-` 的这个写法可以，`border-` / `ring-` 不行 | 把令牌注册进 `@theme inline`，改用具名工具类 `border-tg-border` |
| 变量插值进类名 | 类名不生成，气泡直接透明 | Tailwind 构建期扫**源码文本**，看不见 `` `bg-tg-bubble-${cond?'out':'in'}` `` 这种拼接 | 两个分支写成完整字面量 |

**④ 其余全局层**：`.md-body`（手写 Markdown 排版）、`.tg-wallpaper`（渐变 + 涂鸦壁纸）、`.tg-app`（选区与光标色）、`html:has(.no-scrollbar-page)`（首页隐藏滚动条）。

> 排查手法：DOM 里 class 名是对的，但 `getComputedStyle` 的值是「没生效的样子」→ 就是工具类没被生成或被压掉。**只看截图容易误判成样式冲突。**

## 2.2 请求层（16 个文件，项目里最讲究的一块）

### 文件清单

| 路径（`frontend/src/request/`） | 注释 | 联动 |
|---|---|---|
| `index.ts` | 创建并导出全局 axios 实例。`axios.create({baseURL: VITE_BASE_API, timeout: REQUEST_TIMEOUT})`。**只创建、不挂拦截器** | 被其余全部文件导入 |
| `types.ts` | 请求层类型契约。`RequestConfig`（`loading` / `cache` / `retry` / `cancelRepeat` / `ignoreToken` / `ignoreError` / `ignoreResultCode` / `bypassRefresh` / `metadata` …）、`ApiResult<T>`、`CacheData<T>` … | 被 `index` / `interceptor` / `api` / `pending` / `cache` / `logger` 导入 |
| `constant.ts` | 集中常量。`REQUEST_TIMEOUT=15000`、`SUCCESS_CODE=200`、`TOKEN_EXPIRE_CODE=401`、`CACHE_PREFIX='REQUEST_CACHE'`、`RETRY_COUNT=3`、`RETRY_DELAY=1000` | 被多处引用 |
| `interceptor.ts` | **双拦截器总装**：元信息、loading、缓存、token 注入、pending、日志、401 刷新、重试 | 被 `setup.ts` 调 `setupRefreshHandler` |
| `storage.ts` | token 存取（localStorage）。`TOKEN_KEY='TOKEN'`、`REFRESH_TOKEN_KEY='REFRESH_TOKEN'` | 被 `interceptor` / `api` / `setup` / `chat` / `ai-stream` / `ProtectedRoute` / `AuthCard` / `logout` / `use-current-user` 调用 |
| `refresh.ts` | **双令牌无感刷新的队列与并发控制**。模块级 `refreshing` 布尔 + `queue` 数组；`_retry` 防死循环 | 被 `interceptor`（401 时）与 `setup` 使用 |
| `setup.ts` | **副作用注册文件**：顶层执行 `setupRefreshHandler(async () => { await refreshToken(); setToken(...); setRefreshToken(...); return accessToken })` | 被 `main.tsx` 以 `import './request/setup'` 引入 |
| `pending.ts` | 重复请求取消。`generateRequestKey(method&url&params&data)`、`pendingMap: Map<string, AbortController>` | 被 `interceptor` 使用（仅 `cancelRepeat: true` 时生效） |
| `loading.ts` | 全局 loading 计数发布订阅（引用计数） | 被 `interceptor` 与 `RequestFeedback` 使用 |
| `error.ts` | 全局错误消息发布订阅（框架无关） | 被 `interceptor` 与 `RequestFeedback` 使用 |
| `logger.ts` | 仅开发环境的日志。三个函数开头都是 `if (import.meta.env.PROD) return` | 被 `interceptor` 调用 |
| `cache.ts` | 内存 Map + localStorage 双层缓存，带 TTL（默认 5 分钟） | 被 `interceptor` 读写 |
| `api.ts` | 认证类接口层（页面只调这里）：`register` / `login` / `loginByCode` / `getUserProfile` / `sendRegisterCode` / `sendLoginCode` / `refreshToken` / `sendForgotPasswordCode` / `forgotPassword` | 被 `AuthCard` / `profile` / `agent` / `use-current-user` / `setup` 调用 |
| `notes.ts` | 笔记与附件接口层：`listNotes` / `createNote` / `getNote` / `updateNote` / `moveNote` / `deleteNote` / `uploadAttachment` / `deleteAttachment` / `fetchAttachmentBlob` / `downloadAttachment` | 被 `useNotesStore` 全量调用 |
| `chat.ts` | **聊天唯一数据出入口：REST（axios）+ 实时事件（socket.io）双通道**。15 个函数，末尾 `subscribeChatEvents` 用 `io(BASE/chat, {transports:['websocket'], auth: cb => cb({token})})` | 被 `useChatStore` 调用 |
| `ai-stream.ts` | AI 流式接口层。换票/会话 CRUD 走 axios；**开流走原生 fetch** | 被 `useAgentStore` 调用 |

### 深读：一个请求的完整流水线

```ts
// interceptor.ts —— 请求拦截器（顺序即执行顺序）
config.metadata = { ...config.metadata, requestId, retryCount: config.metadata?.retryCount ?? 0 };

if (config.loading && !config.metadata.loadingShown) {
  showLoading();                                   // ① 引用计数 +1
  config.metadata.loadingShown = true;             //    打标记，重放时不再重复 +1
}

if (config.cache) {
  const cached = getCache(cacheKey);
  if (cached) return config.adapter!(fakeResponse(cached));   // ② 命中缓存：伪造响应，不发网络
}

if (!config.ignoreToken) config.headers.Authorization = `Bearer ${getToken()}`;   // ③ 注入 token
logRequest(config);                                            // ④ 开发环境日志
if (config.cancelRepeat) addPending(config);                   // ⑤ 同键请求先 abort 旧的
```

```ts
// 响应拦截器
removePending(config); hideLoading(); logResponse(config, 耗时);
if (config.cache) setCache(cacheKey, raw);
if (raw.code === SUCCESS_CODE) return raw.data;      // ⑦ 统一解包 {code,msg,data} → data
notifyRequestError(msg);                             // ⑧ 业务错误 → 发布订阅 → 全局 Toast
```

四个非显然的写法：

1. **缓存命中用 `config.adapter` 返回伪响应，而不是提前 `return`。** 这样响应拦截器链路（解包、日志、`hideLoading`）仍然完整走一遍，不会出现「缓存命中时 loading 不消失」。
2. **`index.ts` 不挂拦截器，由 `setup.ts` 副作用注册。** 目的是避开 `index ↔ interceptor` 的循环依赖（`interceptor` 需要 axios 实例，而实例又需要拦截器）。代价是：**`main.tsx` 里那行 `import './request/setup'` 删掉，全站的 token 注入和刷新就都没了**，而且不会报错。
3. **`loadingShown` 标记 + 引用计数**，保证「401 → 刷新 → 重放」整个过程遮罩不闪断。
4. `interceptor.ts` 里残留了几处 `console.log` 调试输出（包括打印 token），属于待清理项。

### 深读：双令牌无感刷新 + 并发去重

```ts
// refresh.ts
let refreshing = false;
const queue: QueueItem[] = [];

export async function runRefreshQueue(retryRequest) {
  if (refreshing) {
    // 不是第一个 401：入队等着，不重复刷新
    return new Promise((resolve, reject) => queue.push({ resolve, reject }));
  }
  refreshing = true;
  try {
    const newToken = await refreshHandler();        // 由 setup.ts 注入，内部调 /auth/refresh
    retryRequest(newToken);                          // 第一个请求自己重放
    queue.forEach(({ resolve }) => resolve(newToken));   // 唤醒其余
    return newToken;
  } catch (err) {
    queue.forEach(({ reject }) => reject(err));      // 刷新失败 → 全部失败
    throw err;
  } finally {
    refreshing = false; queue.length = 0;
  }
}
```

三个关键点：

- **刷新接口自身必须带 `ignoreToken: true` + `bypassRefresh: true`** —— 否则刷新失败（401）会再触发刷新，无限递归。
- **`_retry` 标记**：用新 token 重放后如果还是 401，直接失败，不再进入刷新队列。
- **刷新成功的处理**：`setToken` + `setRefreshToken` + `setAuthorization(原 config)`（因为重放时 config 上还挂着旧 token）。

前端「只刷新一次」的语义和传统方案的区别：不是用锁阻塞，而是**用「第一个请求负责刷新 + 其余入队」**的结构，避免刷新风暴，也避免「旧令牌覆盖新令牌」。

### 深读：为什么 SSE 和附件必须走原生 fetch

这不是风格选择，是能力限制：

| 场景 | 为什么不能用 axios | 为什么不能用直链 |
|---|---|---|
| SSE 流式 | axios 基于 XHR，浏览器端拿不到**增量**数据 | `<EventSource>` 不能自定义请求头（带不了 Authorization） |
| 聊天图片 | 接口需要 Authorization | `<img src>` 带不上请求头 |
| 附件预览/下载 | 同上 | `<a download>` 同样带不上 |

所以统一手法是「**先 fetch 成 Blob → `URL.createObjectURL` → 用完 `revokeObjectURL`**」。聊天一屏几十张图，不释放就是持续泄漏。

```ts
// ai-stream.ts 的 SSE 解析
const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const frames = buffer.split('\n\n');             // SSE 以空行分帧
  buffer = frames.pop()!;                          // 最后一段可能不完整，留到下次
  for (const frame of frames) {
    for (const line of frame.split('\n')) {
      if (line.startsWith(':')) continue;          // ← 跳过 :ping 心跳
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5).trim()) as StreamEvent;
      dispatch(event);
    }
  }
}
```

> 注意 `buffer = frames.pop()` 这一行：SSE 帧可能被 TCP 切在半路，不保留尾巴就会出现「JSON 解析到一半报错」。

## 2.3 状态层（4 个 zustand store）

| 路径（`frontend/src/stores/`） | 注释 | 持久化 | 联动 |
|---|---|---|---|
| `useAppStore.ts` | 用户身份。**文件名叫 AppStore，实际导出 `useUserStore`**。只有 `userId/username/email/isLoggedIn` + `displayName(user)` | ✅ **唯一使用 persist 的**，key `wisora-user-storage`，`partialize` 排除 token | 被 `AuthCard` / `Header` / `agent` / `chat` / `use-current-user` / `logout` 使用 |
| `useNotesStore.ts` | 笔记树 + 编辑器 + 自动保存。导出纯函数 `flattenNotes`（树→虚拟列表行）、`subtreeIds`；`AUTOSAVE_DELAY_MS = 800`；`SaveState` 状态机 | ❌ 纯内存 | 被 `pages/notes` 使用；**被 `useAgentStore` 反向调用 `loadNotes()`** |
| `useChatStore.ts` | 好友 / 会话 / 消息分桶 / 草稿 / typing / 上传。派生函数 `conversationTitle` / `conversationPeer` / `visibleConversations`；内部 `reconcileMessage`（去重乐观气泡） | ❌ 纯内存 | 被 `pages/chat` 与 `components/chat/*` 使用；`ShareToFriendDialog` 也用它 |
| `useAgentStore.ts` | AI 流式对话：消息流、会话列表、模型、`allowWrite`。模块级 `controller: AbortController`；`NOTE_WRITE_TOOLS` 集合 | ❌ 纯内存（**`allowWrite` 刻意不持久化**） | 被 `pages/agent` 使用；**调用 `useNotesStore`** |

### 深读：笔记自动保存的两个陷阱

```ts
// useNotesStore.ts
const AUTOSAVE_DELAY_MS = 800;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

editContent(content) {
  set((s) => ({ active: { ...s.active, content }, saveState: 'dirty' }));
  scheduleSave();
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void doSave(), AUTOSAVE_DELAY_MS);
}
```

**陷阱 1：切换笔记前必须先落盘。** 否则「在 A 里打了字、立刻点 B」会让防抖定时器在 B 打开后才触发，把 A 的内容写进 B。所以切笔记的路径要 `cancelPending()` + `flush()`（取消定时器 + 立刻保存），再切。

**陷阱 2：`SaveState` 必须是状态机而不是布尔。** `idle / dirty / saving / saved / error` —— 用 `isSaving` 布尔会出现「保存失败后界面仍显示已保存」。

### 深读：四种数据的获取容错模式

| 位置 | 手法 | 原因 |
|---|---|---|
| `pages/profile` 的计数 | `Promise.allSettled([listFriends(), listNotes()])` | 一路失败不该让整页白屏，失败那行直接不渲染 |
| Agent 页补齐用户资料 | 令牌在、资料缺 → 调 `getUserProfile` 自愈 | 「只有 TOKEN、没有用户资料」是真实存在的状态 |
| `ShareToFriendDialog` 打开 | `if (!meId) ensureInit(currentUserId, { autoSelect: false })` | 用户可能从没进过聊天页，好友列表是空的 |
| `lib/logout.ts` | 先 `reset()` 三个 store，再删 token | 只删 token 的话，换账号会看到上一个人的笔记与聊天记录 |

## 2.4 路由与守卫

```tsx
// router/index.tsx
const lazyLoad = (imp) => { const C = lazy(imp); return <Suspense fallback={...}><C/></Suspense>; };

export const router = createBrowserRouter([
  { path: '/auth', element: lazyLoad(() => import('@/pages/auth/login')) },     // 唯一公开路由
  {
    path: '/', element: <ProtectedRoute><Layout/></ProtectedRoute>,
    children: [
      { index: true,     element: lazyLoad(() => import('@/pages/Home')) },
      { path: 'about',   element: lazyLoad(() => import('@/pages/About')) },
      { path: 'agent',   element: lazyLoad(() => import('@/pages/agent')) },
      { path: 'notes',   element: lazyLoad(() => import('@/pages/notes')) },
      { path: 'chat',    element: lazyLoad(() => import('@/pages/chat')) },
      { path: 'profile', element: lazyLoad(() => import('@/pages/profile')) },
      { path: '*',       element: lazyLoad(() => import('@/pages/NotFound')) },
    ],
  },
]);
```

**`ProtectedRoute` 极薄 —— 它只做一件事**：

```tsx
export function ProtectedRoute({ children }) {
  if (!getToken()) return <Navigate to="/auth" state={{ from: location }} replace />;
  return children;
}
```

`replace` 防止产生无效历史（否则登录后按返回又回到守卫）；`state.from` 供登录后跳回原地址。**注意它是 `Layout` 的父节点** —— 守卫在下、布局在上。

**`Layout` 决定要不要显示全局导航**：

```tsx
const hideHeader = pathname === '/agent' || pathname.startsWith('/notes') || pathname.startsWith('/chat');
const headerTransparent = pathname === '/';
```

三个整屏工作区隐藏 Header（否则会挤压它们的工作区），首页用透明变体让导航叠在视差场景上。

## 2.5 通用库（`lib/`）

| 路径（`frontend/src/lib/`） | 注释 | 联动 |
|---|---|---|
| `chat-utils.ts` | 聊天纯函数：时间格式化（`formatClock` / `formatDayDivider` / `formatListTime`）、`formatBytes`、`initials`、`avatarTone`、**成员配色**（`PEER_AVATAR_CLASS` 7 色 + `peerIndex` / `peerAvatarClass` / `peerIndexIn` / `peerAvatarClassIn`）、`fileKind` / `FILE_KIND_LABEL` / `CHAT_FILE_MAX_BYTES=50MB` / `isPreviewableImage` | 被 `components/chat/*` 与 `request/chat.ts` 使用 |
| `html-to-markdown.ts` | **自研浏览器端 HTML→Markdown 转换**（不引 turndown）。`htmlToMarkdown` / `extractHtmlTitle`；内部 `inline` / `block` / `list` / `table` / `pre` / `tidy` / `escapeLineStart`；`SKIP_TAGS` / `CONTAINER_TAGS`；基于 `DOMParser` | 被 `import-note.ts` 调用 |
| `import-note.ts` | 导入文件识别与读取。`detectImportKind` / `readNoteFile`；`MAX_IMPORT_BYTES = 2MB`、`MAX_TITLE_LENGTH = 80`；`titleFromMarkdown` / `fallbackTitle` | 被 `useNotesStore.importFiles` 调用 |
| `logout.ts` | **退出登录**：先断 WS、reset 三个内存 store，再清令牌与用户态 | 被 `Header` 等调用 |
| `use-current-user.ts` | 取当前用户 id；缺失时按令牌回查 `/user/profile` 补齐。内含 `cancelled` 竞态守卫与空令牌短路 | 被 `Header` / `chat` / `ShareToFriendDialog` 使用 |
| `utils.ts` | shadcn 标准 `cn()` = `twMerge(clsx(inputs))` | 全站 shadcn 组件 |

### 深读：群成员配色为什么分两套

```ts
export function peerIndex(id: string): number {          // 稳定哈希 → 7 个槽位
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 100_000;
  return hash % PEER_AVATAR_CLASS.length;
}

export const peerAvatarClass = (id: string) => PEER_AVATAR_CLASS[peerIndex(id)];

// 会话内版本：按下标取色
export const peerAvatarClassIn = (memberIds: string[] | undefined, id: string) => {
  const list = [...(memberIds ?? [])].sort();            // 排序保证同一集合稳定
  const i = list.indexOf(id);
  return i < 0 ? peerAvatarClass(id) : PEER_AVATAR_CLASS[i % PEER_AVATAR_CLASS.length];
};
```

| | id 哈希（旧） | 会话内下标（现，群聊） |
|---|---|---|
| 「全不撞色」概率 | 4 人小群 **约 35%**（生日问题：7·6·5·4 / 7⁴） | 成员 ≤7 人**保证不撞** |
| 同一人的颜色 | 任何地方都一致 | **仅群内稳定**；不同群可能不同 |

**职责划分**：群聊用下标版（可读性优先 —— 你永远不会把两个群并排比较），**单聊退回哈希版**（DM 里只有一个对方，没有撞色语境；用下标会让所有 DM 的对方都变成同一个颜色）。列表与头部显示的是**会话本身的图标**（群聊显示群图标），不属于成员，也不改。

### 深读：`html-to-markdown.ts`（自研转换器）

```ts
const SKIP_TAGS = new Set(['script', 'style', 'nav', 'noscript', 'iframe']);
const CONTAINER_TAGS = new Set(['div', 'section', 'article', 'main']);

export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  SKIP_TAGS.forEach((t) => doc.querySelectorAll(t).forEach((el) => el.remove()));
  return tidy(block(Array.from(doc.body.childNodes)));   // block → inline 递归
}
```

覆盖的语法：标题 / 嵌套列表 / 表格 / 代码块 / 引用 / 行内强调与链接。

**为什么要自研而不是引 `turndown`**：这是唯一需要它的功能点，为它引一个运行时依赖不值得（还要考虑包体积与供应链）。代价是要自己维护边界情况 —— 所以 `escapeLineStart` 这类函数是为「正文里本身就有 `#` 或 `-` 开头」准备的。

注意它与渲染侧的对称性：**渲染用 `marked`，反向用自研** —— 引入方向是「必须的依赖」（生产环境渲染），导出方向是「可选的便利功能」。

## 2.6 类型契约（`types/`）

| 路径（`frontend/src/types/`） | 注释 | 对应后端 |
|---|---|---|
| `auth.tsx` | `AuthMode` / `LoginMethod` / `ViewDevice` / `UserProfile` / `RegisterParams` / `LoginParams` / `LoginByCodeParams` / `SendCodeParams` / `RefreshTokenResult` / `ForgotPasswordParams`。**后缀是 `.tsx` 但里面没有 JSX** | `auth/dto/*` + `PublicUser` |
| `note.ts` | `NoteSummary` / `AttachmentMeta` / `NoteChildSummary` / `NoteDetail` / `SaveState` / `NoteTreeRow` | `notes/dto/note.dto.ts` + `DETAIL_SELECT` |
| `chat.ts` | `Presence` / `Friend` / `Conversation` / `Message` / `ChatAttachment` / `ChatEvent` / `SendMessagePayload` / `ShareNotePayload` / … 时间统一 ISO 字符串、可空关系用 `\| null` | **与 `chat/types/chat-events.ts` 一一对应** |
| `agent.ts` | `AgentRole` / `AgentMessage` / `StreamEvent`(7 种) / `ConversationSummary` / `HistoryMessage` | **与 `ai/types/stream-event.ts` 镜像同构** |

这三组「前后端同名同构类型」是**人工维护的契约**（没有代码生成）。改后端事件类型时，必须同步改前端，`tsc` 不会跨仓库报错。

## 2.7 页面层

| 路径（`frontend/src/pages/`） | 注释 | 数据来源 |
|---|---|---|
| `Home.tsx` | 首页。`useState(immersive)`；渲染 `ImmersiveScenes` 并接 `onImmersiveChange`；底部固定 CTA「进入 AI 助手」在沉浸态淡出。**能力卡片区已被整段注释** | 无请求 |
| `About.tsx` | 静态介绍页 | —— |
| `NotFound.tsx` | 404 | —— |
| `auth/login.tsx` | 认证页容器。管 Toast 与「登录成功 → 工作台」切换；`viewDevice` 是写死的 `'auto'` | 渲染 `AuthCard` / `WorkspaceDashboard` / `ForgotPasswordModal` |
| `notes/index.tsx` | **笔记工作区**（最复杂的一页，见下） | `useNotesStore` 全量 |
| `agent/index.tsx` | **AI 助手页**（见下） | `useAgentStore` |
| `chat/index.tsx` | **聊天工作区**（见下） | `useChatStore` |
| `profile/index.tsx` | 个人资料 + 退出登录。`Promise.allSettled` 取两个计数；`logout()` 后 `navigate('/auth', {replace:true})` | `api` / `chat` / `notes` |

### 深读 `pages/notes/index.tsx`

四个机制值得单独记住：

**① 大文档预览闸门**

```tsx
const PREVIEW_MAX_CHARS = 100_000;
const isHuge = (active?.content.length ?? 0) > PREVIEW_MAX_CHARS;
const [forcePreview, setForcePreview] = useState(false);
const deferred = useDeferredValue(active?.content);

// 切换笔记时复位 forcePreview（否则上一篇的「放行」会被带过来）
useEffect(() => { setForcePreview(false); }, [activeId]);

{isHuge && !forcePreview
  ? <Notice>约 {kb} KB，已暂停实时预览 <Button onClick={() => setForcePreview(true)}>仍然渲染预览</Button></Notice>
  : <MarkdownView content={deferred} />}
```

闸门拦的是什么，有实测数字：**强制渲染 10 万字符的正文后打字，每个字符产生约 280ms 的长任务**（`PerformanceObserver` 观察 longtask）；同一文档在编辑态是 **0 长任务**。

**② 目录树 = 树 + 虚拟列表**

```ts
// flattenNotes(notes, expanded, keyword) → NoteTreeRow[]
// 把树按展开状态摊平成一维，交给 VirtualList；搜索时走扁平行
// （避免「父级没命中却被迫出现」）
```

**③ 拖拽：`dragDepth` 计数**

```tsx
// 监听挂在根容器（覆盖标题区、侧边栏、空页面）
onDragEnter: (e) => { dragDepth.current++; if (hasFiles(e)) setDragging(true); }
onDragLeave: () => { if (--dragDepth.current === 0) setDragging(false); }
onDrop:      () => { dragDepth.current = 0; setDragging(false); ... }
const hasFiles = (e) => e.dataTransfer?.types.includes('Files');   // ← 过滤内部拖拽
```

用**计数器**而不是布尔，是因为 `dragenter` / `dragleave` 会在子元素间反复触发；用 `types.includes('Files')` 过滤，是为了不把「拖动笔记节点排序」误判成「拖入文件」。

**④ 移动的两条路径 + 非法落点排除**

触屏上 HTML5 拖拽不可用，所以要同时提供「拖拽移动」与「移动到…弹窗」。前端用 `subtreeIds` 排除非法落点（防止把父节点拖进自己的子树导致子树整片消失），**后端另有一道环检测** —— 前端那道是体验，后端那道是正确性。

### 深读 `pages/agent/index.tsx`

**① 工具气泡的中文映射**

```tsx
const TOOL_LABELS: Record<string, string> = {
  list_my_notes: '查看笔记列表', read_my_note: '读取笔记', create_my_note: '新建笔记', …
};
```

放在**模块顶层**。放组件里会导致每次渲染重建对象（虽然对 `Record` 影响小，但这个项目统一遵守「常量与子组件一律提到模块顶层」）。

**② 模块顶层的子组件**

`ModelSwitcher` / `VoiceInputButton` / `InputBar` / `ConversationRow` 全部定义在模块顶层并显式传 props。**在组件内部定义子组件会让每次渲染产生新的组件类型，React 会卸载并重挂整棵子树** —— 表现为「输入框一次只能输一个字符」「动画每次重播」。

**③ 语音输入**

用浏览器 Web Speech API（`webkitSpeechRecognition`），用 ref 持有回调以防被重新绑定打断。不支持的浏览器**按钮禁用**，而不是「点了没反应」。

**④ 「保存到笔记」与 AI 工具是两条路**

页面上的「保存到笔记」直接 `POST /notes`，**不走 AI 工具、也不受写入授权开关限制**。授权开关管的是「AI 自主改数据」，用户手动点的保存是用户自己的操作。

### 深读 `pages/chat/index.tsx`

**移动端两态 + 桌面自适应**

```tsx
const isDesktop = window.matchMedia('(min-width: 768px)').matches;   // 与 Tailwind md 对齐
useEffect(() => { void init(currentUserId, { autoSelect: isDesktop }); return () => dispose(); }, [...]);
```

**冷启动不自动选中会话**这件事只在移动端做：

- 桌面布局是「左列表 + 右消息」，自动选中能避免右侧空白，是**对的**；
- 移动端布局是**两个整屏视图的切换**（列表 ↔ 会话），一进来自动选中会**直接进某个会话**，用户连列表都没看到；而且自动选中的是列表第一个（置顶/最近活跃），**排在下面的未读会话完全看不到**。

配套的显隐与宽度：

| 状态 | `aside` | 宽度 |
|---|---|---|
| 没有选中会话（列表是根视图） | 显示 | `w-full` |
| 选中了会话、用户点了「返回」 | 显示 | `w-full` |
| 选中了会话、在看会话 | 隐藏 | —— |

`!activeId || sidebarOpen` 是显隐条件；**宽度一律占满屏**（`w-full md:w-[320px]`），
桌面由 `md:` 接管成 320px 固定左栏。

**不加遮罩、不做 320px 抽屉**的原因是 2026-09-28 调整的：抽屉形态在 390px 屏上会露出
70px 被压暗的会话，看着像布局坏了；而且「要从侧边栏里挑好友」正是抽屉范式给人的印象 ——
需求要的是「先进列表、点一条进会话」。列表头部的关闭按钮只在**已经打开会话**时渲染，
没有打开会话时它是死控件（点了不会有任何反应）。

**不做这件事的代价**：把「要不要自动选中」放 store 里读 `matchMedia` 是错的做法 —— store 拿不到布局语义，`resize` 时还会飘。正确做法是把决定权交给**页面**（页面才知道当前是不是移动端）。

## 2.8 组件层

### 业务组件（`components/`）

| 路径（`frontend/src/components/`） | 注释 | 被谁用 |
|---|---|---|
| `Layout.tsx` | 按 `pathname` 决定是否渲染 `Header`；`<Outlet/>` | `router` |
| `Header.tsx` | 全局导航。`variant: default \| transparent`；`NAV_ITEMS` 5 项；移动端 `Sheet` 抽屉（路由变化自动收起）；头像入口 → `/profile` | `Layout` |
| `ProtectedRoute.tsx` | 路由守卫 | `router` |
| `RequestFeedback.tsx` | **全局遮罩 + 错误 Toast**。订阅 `loading` 与 `error`；`SHOW_DELAY=300ms` + `MIN_DURATION=400ms` 防闪 | `App` |
| `AuthCard.tsx` | 登录/注册二合一卡片。`authMode` × `loginMethod` 状态机；60 秒倒计时；成功后写 token + `setUser` | `pages/auth` |
| `ForgotPasswordModal.tsx` | 忘记密码弹窗 | `pages/auth` |
| `IllustrationGraphic.tsx` | 认证页装饰插画（数据全为写死的演示文案） | `AuthCard` |
| `WorkspaceDashboard.tsx` | 登录后工作台 —— **当前是本地 mock 演示，无任何网络请求** | `pages/auth` |
| `ImmersiveScenes.tsx` | **首页 GSAP 视差**（真正的视差逻辑在这里，不在 Home）。4 张整屏 webp；`ScrollTrigger pin` + `scrub:1`；`end = innerHeight*(n-1)*1.15`；`useReducedMotion()` 时降级为普通纵向四屏 | `Home` |
| `Avatar.tsx` | 首字母头像，**跨模块复用**。`size` / `presence` / `group` / **`fill`**（聊天页传 `peerAvatarClass` 覆盖成 Telegram 纯色块，导航与资料页保持项目渐变） | Header / agent / chat / profile / 全部 chat dialog |
| `ContextMenu.tsx` | **手写**右键菜单（项目只装了 Radix 的 dialog/tabs/label）。`useLayoutEffect` 先量尺寸再视口收缩；Esc / 外部点击 / scroll / resize / blur 全关；方向键 + Enter + Tab 键盘可达 | notes / chat / ChatHeader |
| `MarkdownView.tsx` | 渲染管线：`marked.parse`（`gfm:true` + `breaks:true`）→ `DOMPurify.sanitize` → `dangerouslySetInnerHTML`，外层 `.md-body`。`useMemo` 缓存 | `pages/notes` |
| `VirtualList.tsx` | **定行高轻量虚拟滚动**（自研）。`ROW_HEIGHT=44`、`OVERSCAN=6`、`ResizeObserver` 测高；占位 div 撑总高 + `translateY` 偏移 | notes 目录树 / agent 会话 / chat 会话列表（72） |

### 深读 `VirtualList`：两条硬约束

```tsx
const OVERSCAN = 6;
const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
const end   = Math.min(count, Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN);
// 占位撑高 + 内容位移
<div style={{ height: count * rowHeight }}><div style={{ transform: `translateY(${start * rowHeight}px)` }}>…</div></div>
```

**约束 1：`rowHeight` 必须等于真实行高**（否则滚动会漂移、点击错位）。所以调用方传的是精确值（44 / 72），而不是估算。

**约束 2：滚动容器必须常驻。** 空态要放在容器内部，而不是 `count === 0 ? <Empty/> : <List/>`。原因写在文件注释里：分支渲染会让 `ref.current` 为 `null`，且 effect 依赖为空不再重跑，导致 `viewportHeight` 永远是 0。

> 这两条都是「用错不会报错，只会表现为诡异的滚动行为」的类型。

### 深读 `MarkdownView`：XSS 的唯一防线

```tsx
const html = useMemo(() => {
  const raw = marked.parse(content, { async: false }) as string;
  return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
}, [content]);
return <div className="md-body" dangerouslySetInnerHTML={{ __html: html }} />;
```

**`marked` 本身不转义 HTML**，`DOMPurify` 是唯一防线。当前内容都来自用户自己（自己的笔记），但只要有任何一个来源变成「别人的 .md」，这里就是安全边界。这也是「上传白名单排除 html / svg」的同一思路。

### shadcn/ui 基础组件（`components/ui/`，9 个）

全部是 Radix 封装 + `class-variance-authority`，**无业务逻辑**，属于脚手架生成物。下表的使用方是实际 grep 出来的，不是推测：

| 路径（`frontend/src/components/ui/`） | 导出 | 被谁用（实测） |
|---|---|---|
| `button.tsx` | `Button`、`buttonVariants`（含 `variant="brand"` / `destructive`） | **9 处**：`AuthCard`、`ForgotPasswordModal`、`WorkspaceDashboard`、`chat/AddFriendDialog`、`chat/NewChatDialog`、`chat/ShareToFriendDialog`、`pages/agent`、`pages/notes`、`pages/profile` |
| `input.tsx` | `Input` | `AuthCard`、`ForgotPasswordModal`、`WorkspaceDashboard`、`pages/agent`、`pages/notes` |
| `label.tsx` | `Label` | `AuthCard`、`ForgotPasswordModal` |
| `dialog.tsx` | `Dialog` + `DialogPortal` / `DialogOverlay` / `DialogTrigger` / `DialogClose` / `DialogContent` / `DialogHeader` / `DialogFooter` / `DialogTitle` / `DialogDescription` | `chat/AddFriendDialog`、`chat/NewChatDialog`、`chat/ShareToFriendDialog`、`ForgotPasswordModal`、`pages/notes`、`pages/profile` |
| `sheet.tsx` | `Sheet` + `SheetTrigger` / `SheetClose` / `SheetContent` / `SheetTitle` / `SheetDescription` | **只有** `components/Header.tsx`（移动端导航抽屉） |
| `tabs.tsx` | `Tabs`、`TabsList`、`TabsTrigger`、`TabsContent` | `AuthCard`（登录方式切换）、`chat/NewChatDialog`（单聊 / 群聊） |
| `badge.tsx` | `Badge`、`badgeVariants` | **只有** `WorkspaceDashboard` —— 也就是说它只用得到 `/auth` 页（Part 4 里那条 `border-transparent` 影响面就靠这个界定） |
| `card.tsx` | `Card` + `CardHeader` / `CardFooter` / `CardTitle` / `CardDescription` / `CardContent` | **只有** `RequestFeedback` |
| `sonner.tsx` | `Toaster` | **只有** `App.tsx`（全局挂载）。另外 `RequestFeedback` 与 `pages/agent` 是直接 `import { toast } from 'sonner'` 用底层 API，不经过这个文件 |

> 一个实际影响：项目里的 import 风格**不统一** —— `@/components/ui/x`、`./ui/x` 都有，单双引号混用。按 `@/components/ui/` 搜索会漏掉 `AuthCard` 与 `WorkspaceDashboard`（它们用相对路径），这也是我核对使用方时踩到的。

## 2.9 聊天页的六个组件

| 路径（`frontend/src/components/chat/`） | 注释 | 被谁用 |
|---|---|---|
| `ConversationList.tsx` | 左侧会话列表。`ROW_HEIGHT=72`；`VirtualList` 承载；`messagePreview` 按 kind 生成 `[文件]`/`[图片]`/`[笔记]` 摘要；选中行实底 `bg-tg-brand-deep`（子元素要逐个换色 —— 父级 `color` 继承不到 `text-*` 工具类）；免打扰未读只画小圆点；右下角悬浮新建按钮 | `pages/chat` |
| `ChatHeader.tsx` | 会话头部。群聊副标题取前 3 名成员 + 「等 N 人」；单聊显示在线/离开/离线；「更多」复用 `ContextMenu`；返回键 `md:hidden` | `pages/chat` |
| `MessageList.tsx` | **消息流**。`GROUP_WINDOW_MS=5min`（5 分钟内同一人的连续消息合并成组）、`BOTTOM_THRESHOLD=80`、`TAIL_W/H=7/16`；`items` 在 `useMemo` 里预处理出日期分隔与 `startOfGroup`/`endOfGroup`；`BubbleTail`（SVG 贝塞尔弧）；**只在用户本来就在底部时才自动滚**；时间戳用 `float-right` 浮进末行 | `pages/chat` |
| `Composer.tsx` | 输入区。`MAX_TEXTAREA_HEIGHT=160` 自增高有上限；**用 `e.nativeEvent.isComposing \|\| keyCode === 229` 防中文输入法提前发送**；`dragDepth` 拖拽计数；上传中整行换成进度条 | `pages/chat` |
| `NewChatDialog.tsx` | 新建单聊 / 群聊二合一。`Tabs` 切换；群聊需至少 1 人（禁用态体现约束） | `pages/chat` |
| `AddFriendDialog.tsx` | 搜索并添加好友。**按需搜索**（空关键词不发请求）；`searched` 区分「未搜」与「没结果」 | `pages/chat` |
| `ShareToFriendDialog.tsx` | **属于笔记页流程**（不属于聊天页） | `pages/notes` 的右键菜单 |
| `ChatImage.tsx` | 聊天图片。走 `fetchChatAttachmentBlob` 取 Blob（接口需要 Authorization，`<img src>` 带不上头）；本地 `objectUrl` 优先；`useEffect` 清理 `revokeObjectURL` | `MessageList` |

### 深读 `MessageList` 里的四个「不显然」

**① 气泡尾巴只在组尾出现。** `endOfGroup` 为真时才渲染 `BubbleTail`，且圆角那一侧归零 —— 四个角要分开写（`rounded-tl/tr/br/bl`），因为「先 `rounded-xl` 再覆盖某一个角」在 Tailwind 下不可靠。

**② 时间戳浮进末行**

```tsx
<p className="whitespace-pre-wrap break-words">
  {message.text}
  <span className="float-right relative top-[3px] ml-2.5">{meta}</span>
</p>
```

做成独立一行会让每个气泡多出一条几乎空白的行，整屏立刻变松散。卡片类消息（图片/文件/笔记）不适用 —— 卡片占满宽度，时间只能另起一行。

**③ 「本来在底部才自动滚」**

```tsx
if (list.scrollHeight - list.scrollTop - list.clientHeight < BOTTOM_THRESHOLD) list.scrollTop = list.scrollHeight;
```

不做这个判断，用户往上翻历史记录时会被新消息强行拽到底部。

**④ 已读状态与重发**

`status: sending | sent | read | failed`。失败态保留消息并给「重发」入口（红色，用 `--tg-danger`）。

### 群聊配色的渲染落点

`MessageList` 里对每条消息取色：

```tsx
<Avatar fill={peerAvatarClassIn(conversation.memberIds, message.senderId)} />
<span className={peerNameClassIn(conversation.memberIds, message.senderId)}>{senderName}</span>
```

**头像底色与昵称颜色共用同一个下标**，所以同一个人的头像和名字是同色系 —— 这是「不读名字也能分辨谁是谁」的完整实现。前提是后端把 `members` 按 `joinedAt` 排序返回（见 1.6），否则下标会飘。

---

# Part 3　模块之间如何联动

前面按模块讲完了「各自有什么」，这一部分回答「它们怎么串起来」。四条主干链路 + 三类横切关注点 + 五处隐性耦合。

## 3.1 链路 A：注册 / 登录 / 无感刷新

```
[前端] AuthCard
  ├─ 发送验证码 → POST /auth/send-register-code
  │     → AuthService.sendRegisterCode()
  │         → VerificationCodeService.generate('register', email)   ← Redis 写入 + 60s 冷却
  │         → MailService.sendRegisterCode(email, code)             ← nodemailer 发信
  └─ 提交注册   → POST /auth/register
        → AuthService.register()
            → prisma.user.create({ password: bcrypt.hash(pw, 10) })
            → generateTokens(user)  ← Promise.all 并发签 accessToken(15m) + refreshToken(7d)
            → toPublicUser(user)     ← 排除 password 的唯一出口
        ← { user, accessToken, refreshToken }
  └─ AuthCard 写 storage.setToken / setRefreshToken + useUserStore.setUser → navigate('/')

[刷新链路] 任意请求返回 401
  interceptor 构造 retryRequest → refresh.runRefreshQueue()
    ├─ 第一个 401：refreshing = true → setup.ts 注入的 handler
    │     → POST /auth/refresh（带 ignoreToken + bypassRefresh，防递归）
    │     → AuthService.refresh(refreshToken)：验签 → 回查用户 → 重签一整套
    │     → setToken(new) + setAuthorization(原 config) → 重放原请求
    └─ 其余 401：入队等待 → 拿到新 token 各自重放
```

**联动要点**：`auth` 域通过 `verification-code`（Redis）与 `mail`（nodemailer）两个外部能力完成注册；令牌的**存储**在前端 `request/storage.ts`，**注入**在 `request/interceptor.ts`，**刷新编排**在 `request/refresh.ts`，三者由 `request/setup.ts` 的副作用粘合。这条链路上任何一环缺失都不会编译报错，只会表现为「登录后所有接口 401」。

## 3.2 链路 B：AI 流式对话 → 工具写入笔记（跨 3 个域）

这是全项目最长的一条链，**跨越了 ai、notes、chat 无关但同构的两套记忆**：

```
[前端] pages/agent → useAgentStore.send()
   │
   ├─① 换票       request/ai-stream.createChatTicket(allowWrite)
   │              → POST /ai/chat/ticket
   │              → ai.controller：verifyAsync → rateLimit.check → Redis SET ai:ticket:<uuid> EX 30
   │              ← { ticket, allowWrite }
   │
   ├─② 开流       fetch GET /ai/chat/stream?ticket&q&conversationId&model   （原生 fetch，非 axios）
   │              → stream-ticket.guard：GET → DEL（取完即焚）→ req.userId / req.allowWrite
   │              → ai.controller.chatStream：
   │                   rateLimit.check → conversations.assertOwned（IDOR 防护）
   │                   → repository.loadHistory（Redis 命中或回查 DB 并回填）
   │                   → appendMessage({role:'user'})        ← 用户消息先落库
   │                   → createUserScopedTools(prisma, userId, notes)   ← 9 个请求级工具
   │                   → aiService.toSse(runAgent(...), signal)
   │
   ├─③ Agent Loop （见 1.7 深读）
   │    runAgent：SystemMessage + history + HumanMessage
   │      ↻ model.stream() → token / reasoning
   │        ├─ tool_call: create_my_note
   │        │    → invokeTool → policy.write && !allowWrite ? 拦截返回文本 : 执行
   │        │    → notes.tool.ts:createCreateNoteTool → NotesService.create(userId, ...)
   │        │         ↳ 用 NotesService 而非 Prisma：复用 assertOwned / 层级 / 软删语义
   │        └─ tool_result → 回灌 messages → 下一轮（MAX_ITERATIONS = 8）
   │
   ├─④ 下发       AI 最终回复：**先 appendMessage 落库，再 yield done**
   │              工具轨迹：role:'tool' fire-and-forget 落库（审计用）
   │              SSE 每 15s 插 ":ping"
   │
   └─⑤ 前端渲染   ai-stream 按 \n\n 分帧 → StreamEvent
                   useAgentStore 按 type 派发：
                     token        → 追加到「当前」助手气泡
                     tool_call    → 当前气泡为空则删、有内容则保留，置 needNewAssistant
                                    新气泡延后到真有内容时才建（避免空气泡）
                     tool_result  → 命中写操作 → useNotesStore.getState().loadNotes()  ← 跨 store
                     done         → 收尾
```

**四个关键的跨模块设计**：

| 设计 | 为什么 |
|---|---|
| 工具内部走 `NotesService` 而不是 Prisma | 复用归属校验（404 而非 403）、深度/环规则、软删语义 —— 直接用 Prisma 会让 AI 绕过所有业务规则 |
| `NotesModule` 被 `AiModule` imports 且 exports `NotesService` | 这是 AI 域唯一被允许触碰笔记的方式，边界很清楚 |
| 工具用闭包注入 `userId`（`createUserScopedTools`） | 模型即使编一个别人的 `noteId`，工具内部也会被 `assertOwned` 挡掉 |
| `tool_result` 触发 `loadNotes()` | AI 写完笔记，左侧目录树要立刻反映 —— 这是**两套 store 之间唯一的耦合点** |

**这里也是 `NeedsNewAssistant` 那段逻辑的由来**：工具气泡必须落在「工具前的话」和「工具后的答案」之间。

```
期望：  [用户] → [助手:我来查一下] → [工具卡片] → [助手:这是结果]
实现：  send() 时建一个助手气泡 → onToolCall 到达时：
          - 当前气泡为空（模型直接调工具、没说话）→ 删掉它
          - 当前气泡有内容（模型先说了话）         → 保留
        并置 needNewAssistant，新气泡延后到真有内容时才创建
```

判空**只看 `content`、不看 `reasoning`** —— `reasoning`（思维链）被采集但页面**不渲染**，把它算作有内容，会在工具上方留下一个「看不见任何东西」的空壳气泡。

## 3.3 链路 C：聊天实时消息

```
[发送]
[前端] useChatStore.send()
  → request/chat.sendMessage()          → POST /chat/conversations/:id/messages
      → chat.controller（限流 30/min）
          → messages.service.send() → assertMember → insertMessage（$transaction）
                ① 写 ChatMessage
                ② 顶 ChatConversation.updatedAt
                ③ 给非发送者的成员 unread + 1
          → chat.controller 调 gateway.pushToMembers(memberIds, null, {type:'message'})
              → socket.io 房间 conv:<id> 推送

[接收（自己发的也要收 → 多端同步）]
[前端] subscribeChatEvents 收到 {type:'message'}
  → useChatStore.reconcileMessage(message)     ← 用 tempId 去重乐观气泡
      ├─ 命中的乐观消息 → 替换（去掉「发送中」）
      └─ 未命中         → 直接追加到 messagesByConversation[conversationId]
    注：按会话分桶存储，所以「非当前会话」的消息也能正确累加未读

[已读]
[前端] openConversation → markConversationRead
  → POST /chat/conversations/:id/read
      → conversations.markRead（改成员行：unread=0, lastReadAt=now）
      → gateway.pushToMembers(memberIds, 触发者, {type:'read'})   ← 排除自己
  → 其他端收到 read → 把对应的「已发送」改成「已读」勾

[在线状态]
ChatGateway.connect：Redis SET chat:online:<userId> EX 120 → broadcast presence
  → 前端 friends 里的 presence 字段更新 → 头像上的在线小点
```

**联动要点**：

- **`ChatModule` imports `NotesModule`** —— 因为 `messages.createNoteMessage` 要用 `NotesService.get()` 做归属校验并取快照。这是聊天域与笔记域的**唯一交界**。
- **网关不注入到 service 里**，推送职责上移到 `chat.controller.ts`。目的是**避开 `service ↔ gateway` 的循环依赖**（gateway 要调 `conversations.assertMember`，service 要调 gateway 推送 —— 互相依赖）。
- **`ChatModule` 里那个 1 小时的定时器**清理「传了没发」的孤儿附件，是 `ChatAttachment.messageId` 可空这个设计的配套代价。

## 3.4 链路 D：笔记保存、附件与分享

```
[自动保存]
pages/notes 编辑 → useNotesStore.editContent → scheduleSave（800ms 防抖）
  → PATCH /notes/:id → notes.service.update
      注意：dto.parentId !== undefined 才写 parentId（null = 移到顶层，不传 = 不动层级）
  切换笔记 / 离开页面 → cancelPending() + flush()  ← 不落盘会把 A 的内容写进 B

[附件]
拖拽/选择文件 → import-note.detectImportKind 分流
  ├─ md/html/txt → readNoteFile（HTML 走自研 html-to-markdown）→ importFiles → POST /notes
  └─ 其它        → uploadFile → POST /attachments（FileInterceptor 20MB）
                    → attachments.service.upload
                        → file-guard.assertUploadable（空 → 体积 → MIME 白名单）
                        → storage.save(buffer, name)  → storageKey = UUID + ext
                        → prisma.attachment.create({ filename: decodeFilename(originalname) })

[附件预览]
AttachmentPreview → request/notes.fetchAttachmentBlob
  → 原生 fetch 带 Authorization → Blob → URL.createObjectURL
  → 清理时 revokeObjectURL
  为什么不直链：GET /attachments/:id/content 挂 JwtAuthGuard，<img src> 带不上请求头

[分享到聊天]  ← 笔记域 × 聊天域
pages/notes 右键「分享给好友」→ ShareToFriendDialog
  → useChatStore.friends（打开时 ensureInit(autoSelect:false) 自愈）
  → POST /chat/notes/share { noteId, toFriendIds, comment }
      → share.service：逐个好友 → assertFriends → createDirect → createNoteMessage
          → 内部 NotesService.get(userId, noteId)  ← 归属校验 + 取快照（服务端取，不信前端）
      → 部分失败不回滚，只在全部失败时抛错
```

## 3.5 三类横切关注点怎么贯穿

| 横切能力 | 后端落点 | 前端落点 | 贯穿方式 |
|---|---|---|---|
| **鉴权** | `JwtAuthGuard`（逐 controller 挂）+ `StreamTicketGuard`（仅 SSE） | `request/interceptor` 注入 Bearer；`ProtectedRoute` 管路由 | 后端「不挂守卫即公开」；前端「无 token 跳 /auth」 |
| **统一响应** | `ResponseInterceptor` + `HttpExceptionFilter` + `@SkipResponse()` | `interceptor.ts` 的 `raw.code === 200 ? raw.data : …` | 形状 `{code,msg,data}` 由两处独立代码维持，靠约定而非类型约束 |
| **限流** | `RateLimitService`（Redis `INCR` + `EXPIRE`） | 无（超限只表现为 429 错误 Toast） | 只在 AI 换票/开流、聊天发消息/上传四处启用 |
| **错误呈现** | 过滤器统一 `{code,msg,data:null}` | `error.ts` 发布订阅 → `RequestFeedback` Toast | 前端「发布订阅」而非全局 state，避免请求层依赖 React |
| **加载反馈** | 无 | `loading.ts` 引用计数 + 300ms/400ms 防闪 | 请求层与 UI 解耦 |

## 3.6 五处隐性耦合（重构时最容易踩）

| # | 耦合 | 风险 |
|---|---|---|
| 1 | `UserModule` / `NotesModule` 能用 `PrismaService`，靠 `AuthModule` 把 `PrismaModule` 带进依赖图 | 摘掉 `AuthModule` → `UserService` 启动失败 |
| 2 | `NotesModule.exports [NotesService]` 同时被 `AiModule` 与 `ChatModule` 依赖 | 改名/改签名会影响两个域 |
| 3 | 前端 `useAgentStore` 调 `useNotesStore.getState().loadNotes()` | 两个 store 之间唯一的直接依赖 |
| 4 | `request/setup.ts` 靠 `main.tsx` 的一行副作用 import 生效 | 删掉那行 → 全站 token 注入与刷新静默失效（不报错） |
| 5 | `CONVERSATION_SHAPE.members` 的 `orderBy: joinedAt` 是**前端配色的前提** | 去掉它 → 群成员颜色会飘（表现随机、难定位） |

另外还有两条「文档级契约」，靠人工维护：`ai/types/stream-event.ts` ↔ `types/agent.ts`、`chat/types/chat-events.ts` ↔ `types/chat.ts`。后端改事件类型，前端不改也不报错，只会在运行时收到无法识别的 `type`。

---

# Part 4　文档与代码对照

## 4.1 `docs/` 里的五份文档

| 文档 | 体量 | 定位 | 与代码的关系 |
|---|---|---|---|
| `wisora-modules-guide.md` / `.html` | 54K / 64K | **AI 与笔记两个模块的深度指南**（Part I AI、Part II 笔记） | 与代码高度一致，是本文 Part 1 的重要参照 |
| `chat-backend-implementation.md` | 98K | **聊天模块后端的实现包**（逐文件完整代码 + 落地顺序 + 依赖安装结论） | 属于「施工图」，代码落地后部分内容成了历史快照 |
| `chat-module-design.md` | 39K | 聊天模块设计文档 + §8 落地记录（含 §8.6 视觉层还原 Telegram、§8.7 遗留） | §8 是与代码同步的，§1–§7 是设计意图 |
| `ai-notes-agent-plan.md` | 48K | 「让 AI 能操作笔记」的实现方案 + §9 落地记录 | §9 已回填 |

**建议的使用方式**：查模块设计意图看前两份；查聊天后端逐文件代码看第三份（但它有历史快照属性）；查 AI 工具系统看第四份，再对照 `wisora-modules-guide.md` 的 Part I 与本文 1.7。

## 4.2 一致性核对：文档与代码的差异清单

逐项核对下来，**设计文档与代码在架构层面高度一致**，差异集中在两类：文档记录的「待办」已被实现、以及文档尚未记录的后续改动。

**① 文档里标注为「未完成 / 待改」，实际已经完成**

| 位置 | 文档说法 | 代码现状 |
|---|---|---|
| `ai-notes-agent-plan.md` §9 | 「工具气泡显示在助手回答下方」列为已知观感问题（未改） | **已修复**（`currentAssistantId` 轮换成可轮换变量 + `needNewAssistant`），§9 已回填 |
| `chat-module-design.md` §8.7 | 视觉层遗留项 | §8.6 记录了 Telegram 视觉层落地，§8.7 遗留已更新 |
| `chat-backend-implementation.md` §5.1 | WebSocket 依赖安装结论 | 已安装（`socket.io` / `socket.io-client`），网关已上线 |

**② 代码里有、文档尚未记录的部分**

| 代码事实 | 说明 |
|---|---|
| `--tg-*` 令牌注册进 `@theme inline` 得到具名工具类 | 起因是 Tailwind v4 的 `border-[color:var(--x)]` 静默不生效。`chat-module-design.md` §8.6 有记录，其余文档未提 |
| `index.css` 的 `* { @apply border-border }` 收进 `@layer base` | **全站性修复**：修好之前所有 `border-<color>` 都渲染成同一个默认灰 |
| 群成员配色改为「群聊按下标 / 单聊按哈希」 | 后端为此加了 `orderBy: { joinedAt: 'asc' }`。这是两条改动之间的依赖，文档未记录 |
| `useChatStore.init(id, { autoSelect })` | 移动端冷启动不自动选中会话；列表是**整屏根视图**（`!activeId \|\| sidebarOpen`，宽度 `w-full md:w-[320px]`，不做遮罩/抽屉） |
| `CHAT_COLUMN`（`lib/chat-utils.ts`） | 头部 / 消息列 / 输入区共用的列宽；`.chat-scroll`（`index.css`）让消息区滚动条不占布局宽度 —— 两者一起才让三块左右都对齐 |
| `GET /ai/conversations/:id/messages` 走 `listAllMessages` | 与 SSE 用的 `loadHistory` **刻意分开**：后者只有最近 20 条且优先读 Redis 热缓存，界面复用会被截断 |
| `chat-attachments.service.cleanupOrphans` + 定时器 | `chat-module-design.md` 提过孤儿附件问题，实现细节在代码里 |
| 前端 lockfile 曾缺 3 个运行时依赖 | 已补（`dompurify` / `marked` / `socket.io-client`）。这类问题文档不会记，但 `--frozen-lockfile` 会暴露 |

**③ 文档与代码的「符号级」对照（抽查一致）**

| 文档提到 | 代码实际 | 结论 |
|---|---|---|
| `MAX_ITERATIONS = 8` | `ai.service.ts` 一致 | ✅ |
| 票据 30 秒 | `TICKET_TTL_SECONDS = 30` | ✅ |
| Redis 热缓存 30 分钟 / 最近 20 条 | `CACHE_TTL_SECONDS = 1800`、`HISTORY_LIMIT = 20` | ✅ |
| 笔记深度上限 6 层 | `MAX_DEPTH = 6` | ✅ |
| 笔记预览闸门 | 前端 `PREVIEW_MAX_CHARS = 100_000` | ✅ |
| 限流 10 次 / 60 秒 | `DEFAULT_MAX_REQUESTS = 10`、`WINDOW_SECONDS = 60` | ✅ |
| 聊天游标分页默认 30 上限 100 | `clampPageSize` 一致 | ✅ |
| 附件 20MB（笔记）/ 50MB（聊天） | 两处常量各自一致 | ✅ |
| 头像配色 7 色 | `PEER_AVATAR_CLASS` 长度 7 | ✅ |

## 4.3 代码里值得处理的问题清单

按性质分三级。**这些都是「能跑但不干净」，不是运行时 bug** —— 列出来是为了下次重构时心里有数。

### A 级：影响正确性或安全性的隐式行为

| # | 问题 | 位置 | 建议 |
|---|---|---|---|
| A1 | **refreshToken 不可吊销**：改密码后旧令牌 7 天内仍有效 | `auth.service.ts` | 引入 `tokenVersion` 字段或 Redis 黑名单；至少「改密后清空 refreshToken」 |
| A2 | **刷新令牌是「重签一整套」**，没有刷新令牌轮换（rotation） | `auth.service.ts` | 若要防重放，需返回新的 refresh 并作废旧的那个 |
| A3 | `refresh()` 的 catch 吞掉真实原因，统一成「无效或已过期」 | `auth.service.ts` | 区分「令牌过期」与「用户不存在」，便于排查 |
| A4 | `notes/attachments.service.ts` **import 了 `assertUploadable` 却没调用**，校验被手写重复了一遍 | `attachments.service.ts` | 收敛到 `file-guard`，避免两处白名单不同步 |
| A5 | `Message.usage` 列存在但从不写入 | `conversation.repository.ts` | 要么写入（便于统计 token 成本），要么删列 |
| A6 | `verification-code` 用 `Math.random()` 生成验证码 | `verification-code.service.ts` | 换 `crypto.randomInt`（成本低，收益是消除一类质疑） |

### B 级：死代码与命名误导

| # | 问题 | 位置 |
|---|---|---|
| B1 | `verification-code.controller.ts` 无任何路由 | 该模块 |
| B2 | `verification-code/dto/create-*.ts`、`dto/update-*.ts`、`entities/*.ts` 无引用 | 该模块 |
| B3 | `ai/dto/chat.dto.ts` 的 `ChatDto` 无引用（ticket 用的是内联类型） | `ai/dto` |
| B4 | `notes/dto/note.dto.ts` 的 `UploadAttachmentDto` 无引用（controller 直接 `@Query('noteId')`） | `notes/dto` |
| B5 | `mail.service.ts` 的 `sendRegisterCode` 被登录与找回复用，**方法名与用途不符** | `mail.service.ts` |
| B6 | `common/response.interface.ts` 的 `ApiResponse<T>` 无任何 import 方 | `common/` |
| B7 | `frontend/src/App.css` 基本未使用（样式都在 `index.css`） | 前端 |
| B8 | `types/auth.tsx` 后缀是 `.tsx` 但无 JSX | 前端 types |

### C 级：一致性与可维护性

| # | 问题 | 位置 |
|---|---|---|
| C1 | `AuthModule` 的 providers 重复提供 `MailService` / `PrismaService`（与已 imports 的模块重复） | `auth.module.ts` |
| C2 | `PrismaModule` / `RedisModule` 未在根模块显式登记（靠间接依赖） | `app.module.ts` |
| C3 | `auth.controller.ts` 的 `test-token` 手写 `verifyAsync`，与守卫重复 | `auth.controller.ts` |
| C4 | JWT 密钥在每个挂守卫的模块里现取 `process.env`，改名要改多处 | 多个 module |
| C5 | Redis key 命名散落各处，无集中登记 | 多处 |
| C6 | `useAppStore.ts` 文件名叫 AppStore，导出的是 `useUserStore` | 前端 stores |
| C7 | `request/interceptor.ts` 残留多处 `console.log`（含打印 token） | 前端 request |
| C8 | 脚手架 `.spec.ts` 只断言 `toBeDefined()`，多数未 mock 依赖（等于没测） | 多个模块 |
| C9 | `main.tsx` 的 `StrictMode` 被注释掉 | 前端入口 |
| C10 | 前后端类型契约（`stream-event` / `chat-events`）靠人工同步，无代码生成 | 两侧 types |

## 4.4 面试/复习时的自查清单

如果要用这个项目回答技术问题，下面这些问题都能在本文里找到答案（且都能指到具体文件）：

1. `EventSource` 为什么不能用？票据鉴权解决了什么？为什么票据要「取完即焚」？（→ 1.7）
2. SSE 出异常时为什么不调 `subscriber.error`？心跳为什么用 `:ping`？（→ 1.7）
3. Agent Loop 的轮次上限是多少？写工具为什么 `retries: 0`？超时的实现方式会导致什么后果？（→ 1.7）
4. 工具为什么用闭包注入 `userId`，而不是从参数取？（→ 1.7）
5. 会话记忆的双层结构是什么？用户消息与助手回复分别在哪一刻落库，为什么？（→ 1.7）
6. 单聊去重为什么不用「先查再建」？（→ 1.6）
7. 未读/置顶/免打扰为什么放在成员表而不是会话表？（→ 1.6）
8. 「不存在」与「无权」为什么都返回 404？（→ 1.6，`assertMember` / `assertOwned`）
9. 笔记树的环检测怎么做？为什么 `while (depth <= MAX_DEPTH)` 这个上界同时防了死循环？（→ 1.5）
10. 上传白名单为什么排除 html/svg？下载头为什么用 `filename*=UTF-8''`？（→ 1.5）
11. 并发 401 如何保证只刷新一次？刷新接口自己 401 怎么办？（→ 2.2）
12. 缓存命中为什么用 adapter 伪响应而不是提前 return？（→ 2.2）
13. 聊天图片为什么不能直接用 `<img src>`？（→ 2.8）
14. 虚拟列表为什么「空态必须放在容器内」？（→ 2.8）
15. 群成员配色为什么群聊用下标、单聊用哈希？代价是什么？（→ 2.5）
16. 移动端冷启动为什么不自动选中会话？决定权为什么不能放 store？（→ 2.7）
17. 工具气泡的顺序是怎么保证的？为什么判空只看 `content`？（→ 3.2）
18. Tailwind v4 那三个静默失效分别是什么？（→ 2.1）
19. `main.tsx` 里 `import './request/setup'` 删掉会怎样？（→ 3.6，答案：静默失效）
20. 全局没有 `ValidationPipe` 意味着什么？（→ 1.1，DTO 装饰器只是文档）
