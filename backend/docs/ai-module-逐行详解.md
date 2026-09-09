# Wisora AI 流式 Agent 模块 · 逐行代码详解

> 覆盖范围：`src/ai/` 全部 **13 个文件、957 行**
> 设计来源：根目录《ai-stream-agent-方案.md》
> 本文档逐目录、逐文件、逐行讲解，并标注【为什么这么做】与【坑点】

---

## 目录

- [一、模块总览](#一模块总览)
- [二、ai.module.ts（模块装配）](#二aimodule模块装配)
- [三、ai.controller.ts（控制器）](#三aicontrollerts控制器)
- [四、ai.service.ts（Agent 核心）](#四aiservicetsagent-核心)
- [五、types/stream-event.ts](#五typesstream-eventts)
- [六、decorators/skip-response.decorator.ts](#六decoratorsskip-responsedecoratorts)
- [七、llm/llm.provider.ts](#七llmllmproviderts)
- [八、tools/ 目录](#八tools-目录)
- [九、memory/conversation.repository.ts](#九memoryconversationrepositoryts)
- [十、guards/stream-ticket.guard.ts](#十guardsstream-ticketguardts)
- [十一、rate-limit.service.ts](#十一rate-limitservicets)
- [十二、dto/chat.dto.ts](#十二dtochatdts)
- [十三、坑点与关键设计](#十三坑点与关键设计)
- [十四、本模块之外的必要协同改动](#十四本模块之外的必要协同改动)

---

## 一、模块总览

这是 Wisora 后端实现**流式 AI 对话 / Agent（能调用工具的对话）**的模块。它的价值不止是调大模型，而是把 **SSE 推送、多轮上下文、工具调用、鉴权、限流、成本统计**串成一条完整、健壮、可控的链路。

### 架构分层

```
前端 (React) → fetch 读 SSE → zustand 逐字渲染
        ↓ GET /ai/chat/stream?ticket=xxx&q=...&conversationId=...
AiController（@Sse + @SkipResponse + ticket 鉴权 + 限流）       ← 只负责 HTTP 协议
  chatStream()（控制器私有生成器）                              ← 落库、拼接历史、包装事件
    AiService.toSse()                                          ← AsyncGenerator ⟶ Observable，心跳/中断/错误兜底
      AiService.runAgent()                                     ← Agent Loop 核心：流式生成 + 工具调度 + token 统计
        ToolRegistry + 具体工具                                 ← AI 的"手"（model.bindTools 注入）
        ConversationRepository                                 ← Redis 短期热缓存 + Prisma 长期持久化
        RateLimitService                                       ← 按 userId 限流
    LlmProvider(chatModelProvider)                             ← ChatOpenAI(baseURL)，模型可替换
        ↓ DeepSeek / 通义 / 豆包 / Kimi（OpenAI 兼容）
```

### 一条请求的完整旅程

1. **换票**　前端带 JWT → `POST /ai/chat/ticket` → 后端验 JWT 得 userId，Redis 存一次性 ticket（30s）→ 返回 ticket
2. **开流**　前端拿 ticket → `GET /ai/chat/stream?ticket=&q=&conversationId=`
3. **鉴权+限流**　`StreamTicketGuard` 校验 ticket（取完即焚）→ 控制器按 userId 限流（10 次/分钟）
4. **取历史**　若带 conversationId，从 Redis 热缓存（miss 则查库回填）取最近 20 条
5. **生成**　`runAgent` 把「系统提示 + 历史 + 新问题」发给模型 → 流式返回 token / reasoning → 有 tool_call 就执行工具、把结果塞回消息再问一轮
6. **落库**　用户问题、助手回复写入 Prisma（user→assistant 成对），并写穿 Redis 缓存
7. **收尾**　done 事件带 usage（token 统计）→ 客户端断开时 AbortController 中断 LLM

### 目录树

```
src/ai/
├── ai.module.ts                 # Nest 模块定义 + 启动时注册工具
├── ai.controller.ts             # HTTP 层：换票 / SSE 流 / 会话 CRUD
├── ai.service.ts                # 核心：toSse + Agent Loop + 工具执行
├── rate-limit.service.ts        # 按 userId 限流
├── dto/chat.dto.ts              # 请求参数校验
├── llm/llm.provider.ts          # CHAT_MODEL 提供者（模型解耦）
├── tools/
│   ├── tool.registry.ts         # 工具注册表（策略：超时/重试/权限）
│   ├── user-info.tool.ts        # 示例工具：查用户
│   └── index.ts                 # registerAllTools 统一注册
├── memory/conversation.repository.ts  # Redis+Prisma 双层记忆
├── guards/stream-ticket.guard.ts      # SSE 一次性票据鉴权
├── decorators/skip-response.decorator.ts  # 让 SSE 绕过全局包装
└── types/stream-event.ts        # SSE 事件协议（JSON 信封）
```

---

## 二、ai.module.ts（模块装配）

> 作用：把该模块用到的依赖声明给 Nest 容器，并在应用启动瞬间注册所有 AI 工具。
> **它是模块的"总装车间"**——其它所有文件都在这里被装配。

### 逐行讲解

- **L1-2**　导入 `Module`（模块装饰器）与 `OnModuleInit`（生命周期钩子接口）。`OnModuleInit` 让类在模块初始化完成后自动执行一次 `onModuleInit()`。
- **L3-12**　导入本模块及外部的各种提供者/控制器：`JwtModule`（JWT 支持，控制器换票时验 token 用）、`AiController`、`AiService`、`chatModelProvider`（模型）、`ToolRegistry`、`registerAllTools`（注册函数）、`ConversationRepository`、`RateLimitService`、`StreamTicketGuard`、`PrismaModule`、`PrismaService`。
- **L14-20**　`imports`：引入 `PrismaModule`（提供 PrismaService）和 `JwtModule.register({})`（无配置注册，因为控制器换票时**用 process.env 显式传 secret**验签，不需要模块级固定配置）。注释强调：`RedisModule` 是 `@Global()`，全局可见，**无需重复 import**——Nest 会自动注入其导出的 RedisService。
- **L21**　`controllers`：声明本模块提供的 HTTP 控制器，仅 `AiController`。
- **L22-29**　`providers`：向容器注册本模块的服务，Nest 才能自动完成依赖注入（DI）：
  - `AiService`：会被 `AiController` 注入
  - `ToolRegistry`：被 `AiService`、`AiModule` 注入
  - `ConversationRepository` / `RateLimitService` / `StreamTicketGuard`：控制器需要
  - `chatModelProvider`：以 token `CHAT_MODEL` 提供 ChatOpenAI 实例，被 `AiService` 用 `@Inject('CHAT_MODEL')` 注入
- **L30**　`exports: [AiService]`：允许其它模块 import 本模块后使用 AiService。
- **L32-37**　类实现 `OnModuleInit`。构造函数注入 `ToolRegistry` 与 `PrismaService`——后者在工具工厂里查库用。这里用的是**字段参数属性**语法（`private readonly` 在构造参数前），TS 自动生成并赋值同名私有字段。
- **L39-42**　`onModuleInit()`：应用启动时调用 `registerAllTools(this.tools, this.prisma)`，把工具实例塞进 `ToolRegistry`。
  - **为什么在模块而非工具文件里 new？** 因为工具需要 Nest 管理的单例 Service（Prisma），只有在此刻能拿到容器里的实例并注入闭包。

> 💡 **记忆点**：Nest 的装配三件套 = `controllers`（暴露 HTTP）+ `providers`（可被注入的 Bean）+ `imports`（依赖的模块）。缺任何一环都会启动报错 "Nest can't resolve dependencies"。

---

## 三、ai.controller.ts（控制器）

> 作用：HTTP 入口。**只关心"协议"**（收到什么、返回什么格式），把具体业务交给 Service 与 Repository。
> 包含 4 个对外接口 + 1 个私有编排生成器。

### 对外接口一览

| 方法 & 路径 | 鉴权 | 作用 |
|---|---|---|
| POST /ai/chat/ticket | JWT (Bearer) | 换 30s 一次性 ticket |
| GET /ai/chat/stream | ticket | SSE 流式对话（核心） |
| GET /ai/conversations | JWT | 会话列表 |
| DELETE /ai/conversations/:id | JWT | 软删除会话 |

### 逐行讲解

- **L1-15**　从 `@nestjs/common` 导入 HTTP 相关装饰器/类：`Controller/Delete/Get/Post`（路由）、`HttpException`（抛错）、`Injectable`、`Logger`（日志）、`Param/Query/Req`（取参数）、`Sse`（SSE 流接口装饰器，重要）、`UnauthorizedException`（401）、`UseGuards`（挂守卫）。
- **L16-26**　导入外部依赖与兄弟文件：`JwtService`（验 JWT）、`randomUUID`（生成 ticket）、`Request`（express 类型）、LangChain 的 `AIMessage/HumanMessage`、本模块的类型与各类 Service。
- **L28-29**　`TICKET_TTL_SECONDS = 30`：ticket 仅 30 秒有效。时间太短怕用户来不及点开流，太长则易被重放，30s 是平衡点。
- **L31-34**　`@Injectable() @Controller('ai')`：声明可注入的服务类，并把路由前缀定为 `/ai`。`Logger(AiController.name)` 用于打印带类名的日志。
- **L36-42**　构造函数 DI：注入 `AiService`（驱动对话）、`JwtService`（验 JWT）、`RedisService`（存取 ticket）、`ConversationRepository`（存取会话/消息）、`RateLimitService`（限流）。

#### getUserId() — JWT 解析（L45-59）

- **L45-49**　取 `Authorization` 头，若不以 `Bearer ` 开头则抛 401「缺少访问令牌」。
- **L50-55**　用 `verifyAsync<{sub:string}>` 校验并解析 token（去掉 `Bearer ` 前缀），用 `process.env.JWT_ACCESS_SECRET` 验签。token 是注册/登录时签发的，payload 里 `sub` 就是 userId。**返回 `payload.sub`**。
- **L56-58**　校验失败则抛 401「访问令牌无效或已过期」。

> 📌 **为什么手写解析而不是用全局 JwtAuthGuard？** 项目当前没有全局 JWT 守卫/中间件把 user 挂到 request，所以这里在每个需要 JWT 的方法内手动解析一次，保持一致。

#### createTicket() — POST /ai/chat/ticket（L62-80）

- **L64**　解析出 userId。
- **L67-73**　**顺带限流**：每次换票也调用 `rateLimit.check(userId)`，防止恶意刷票耗尽 Redis / 反复触发 LLM。`limit.allowed` 为 false 时抛 429。
- **L75-78**　用 `randomUUID()` 生成 ticket，写入 Redis：键 `ai:ticket:${ticket}`，值 userId，过期 30s（`setex` = SET + EXPIRE）。
- **L79**　返回 `{ ticket }` 给前端（会被全局 ResponseInterceptor 包成 `{code,msg,data:{ticket}}`）。

#### stream() — GET /ai/chat/stream（L85-122）

- **L85**　🔑 **必须用 `@Sse('chat/stream')` 而非 `@Get`**。@Sse 会让 Nest 正确地把返回的 Observable 逐项输出为 `text/event-stream`；若用 @Get，Nest 把 Observable 当普通响应只取最后一个值发 JSON（见"坑 1"）。
- **L86**　🔑 `@SkipResponse()`：让该接口绕过全局 ResponseInterceptor，不套 `{code,msg,data}` 壳，否则 SSE 数据会被包装而失效。
- **L87**　`@UseGuards(StreamTicketGuard)`：进入方法前先校验 ticket，守卫会把 `req.userId` 写上去。
- **L88-92**　方法参数：`req`（断言带 userId）、`@Query('q') question`（问题）、`@Query('conversationId')`（会话，可选）。
- **L93-95**　若没有 `q` 参数，抛 400「缺少参数 q」。
- **L97**　从守卫写好的 `req.userId` 取 userId（这里不再验 JWT，ticket 已证明身份）。
- **L99-106**　再次限流：对话比换票更烧钱（每次真调 LLM），同样 10 次/分钟，超限抛 429。
- **L108-110**　若带了 conversationId，调用 `conversations.loadHistory` 取历史上下文，作为 Agent 的"记忆"；否则空数组（全新对话）。
- **L112-121**　🔑 构造并返回 SSE 的 Observable。`aiService.toSse(...)` 接收一个"生成器工厂" `(signal) => chatStream({...})`。这里把 `signal` 一路传下去，目的：**客户端断开时由 toSse 调用 abort，中断底层 LLM 请求**。

#### listConversations() / deleteConversation()（L125-137）

- **L125-129**　`GET /ai/conversations`：JWT 解析 userId，返回该用户所有未删除会话（Repository 已按 updatedAt 倒序）。
- **L132-137**　`DELETE /ai/conversations/:id`：软删除（不是物理删），置 `deletedAt`，并同步清掉该会话的 Redis 缓存。

#### chatStream() — 私有编排生成器（L140-209）

> 本控制器真正的"导演"。

- **L140-146**　定义为 `async *chatStream()`——一个**异步生成器**，逐条 `yield` 出 `StreamEvent`。它接收一个含 `signal` 的参数对象。返回值类型是 `AsyncGenerator<StreamEvent>`。
- **L147**　解构取 userId、question、conversationId。
- **L149-156**　若没传 conversationId（新对话），创建会话：标题取问题的前 30 字，记录所用模型；否则复用既有会话。
- **L158-162**　**先把用户问题落库**（写入 Message，role=user），拿到 `userMessage.id`。
- **L164**　🔑 立即 `yield {type:'start', conversationId, messageId}`——通知前端"会话已建立"，让前端能立刻拿到 `conversationId`（用于后续新一轮时携带）。
- **L166-167**　`fullText`：累积助手回复文本；`persisted`：幂等标志，防止重复落库。
- **L169-178**　定义内部函数 `persistAssistant()`：把累积的助手文本写入 Message（role=assistant）。**幂等**——`persisted` 为 true 就直接返回，避免 done 和 finally 各写一次。写库失败只打 warn，不阻断流。
- **L180-187**　把历史转成 LangChain 需要的 `BaseMessage[]`。**只保留 user / assistant 且非空的轮次**，跳过 tool 轮次（工具轮次的语义依赖 tool_call_id 配对，简单拼接会误导模型）。`role==='user'` → `new HumanMessage`，否则 `new AIMessage`。
- **L189-204**　进入 `try`：`for await` 消费 `aiService.runAgent({question, history, signal})` 流出的每个事件。`runAgent` 内部完成"问模型 → yield token/reasoning → 执行工具 → 再问"的循环，这里只是透传。
- **L195**　若是 `token` 事件，把文本累加到 `fullText`（供最终落库）。
- **L197-201**　⚠️ **坑点已修**：遇到 `done` 事件时，**先落库助手消息，再 yield done**。否则客户端收到 done 后立刻发起下一轮，会读到尚未写入的历史 → 多轮记忆"随机失效"（见"坑 3"）。
- **L203**　把事件透传给 toSse 去推给前端。
- **L205-208**　`finally`：无论正常结束、被中断还是抛异常，都再调一次 `persistAssistant()` 兜底——避免中断时助手半截回答没落库（幂等确保不会重复写）。

---

## 四、ai.service.ts（Agent 核心）

> 作用：真正的"大脑"。包含三块——①把生成器桥接成 SSE 的 `toSse`；②Agent 循环 `runAgent`；③工具执行 / token 统计等私有辅助。

### 4.1 toSse() — AsyncGenerator ⟶ SSE Observable（L42-92）

- **L15-19**　两个常量：`MAX_ITERATIONS=8`（Agent 最多 8 轮，防工具死循环烧钱）、`HEARTBEAT_INTERVAL_MS=15000`（心跳间隔）。
- **L21-28**　类与构造：注入 token 为 `CHAT_MODEL` 的 ChatOpenAI（模型）与 `ToolRegistry`（工具表）。
- **L42-48**　`toSse(genFactory)` 接收一个**生成器工厂**函数，返回 `Observable`。每次订阅时：`cancelled=false` 标记；`new AbortController()` 建立中断句柄；**现在才调用工厂创建生成器**（传入 `controller.signal`）——这样 signal 在生成器生命期内可用。用 `new Observable(subscriber=>...)` 把"逐条事件"推给 Nest 的 SSE 通道。
- **L50-52**　启动 `setInterval` 心跳，每 15s 推一个 `:ping` 注释行。**作用**：很多代理/网关有"空闲超时"，若长时间没数据会掐断连接；心跳让连接保持活跃。
- **L54**　`void (async()=>{...})()`：立即开始一个"驱动生成器"的异步任务。用 void 忽略其 Promise，避免 unhandled rejection。
- **L56-59**　用 `for await` 逐个消费生成器产出的事件，只要没被取消就 `JSON.stringify` 后推给 subscriber。**为什么不直接传对象？** SSE 要求 payload 是字符串，前端再 parse。
- **L60**　生成器正常走完且未取消 → `subscriber.complete()` 结束流。
- **L61-77**　`catch`：若生成期间抛错：**先判断 cancelled**——若是客户端断开导致的中断，属预期，直接 return（不打 error、不下发事件）；否则记 error 日志，并推一个 `{type:'error',code:'STREAM_FAILED'}` 事件给前端提示，然后 `complete()`。
  - 🔑 用 `complete` 而非 `error`——`error` 会被全局 HttpExceptionFilter 转成 JSON，反而污染已建立的 SSE 流。
- **L78-80**　`finally`：无论成败都清掉心跳计时器。
- **L83-90**　🔑 **teardown（清理）回调**。Observable 在 `unsubscribe`（= 客户端断开）时执行：置 cancelled、清心跳、**`controller.abort()` 中断底层 LLM**（停止计费）、`gen.return?.(undefined)` 让生成器走 finally 释放资源。这是"点停止按钮能真的省钱"的机制所在。

### 4.2 runAgent() — Agent Loop（L95-195）

> **Agent Loop 思想**：让模型反复"想(推理)→做(调工具)→看(拿结果)→再想"，直到模型认为不再需要工具、给出最终自然语言回复。这正是从"只会闲聊的 LLM"升级为"能调用系统能力的 Agent"的核心。

- **L95-100**　方法签名：接收 `{question, history?, systemPrompt?, signal?}`，返回 `AsyncGenerator<StreamEvent>`。解构并给 history/systemPrompt 默认值。
- **L103-110**　组装首轮消息数组 `messages`：先是 `SystemMessage`（系统设定：若无自定义则用默认"你是 Wisora 的智能助手…用中文回答"），然后拼历史，最后一条是当前问题的 `HumanMessage`。
- **L112-118**　🔑 把注册的工具**绑给模型**：`this.tools.list()` 拿所有工具，若非空就 `this.model.bindTools(tools)` 得到"带工具能力的模型"。**不做这步模型就看不到工具定义，tool_calls 恒为空、Agent 永不调工具**（见"坑 2"）。
- **L120-122**　`startedAt` 记录开始时间（算耗时）；`usage` 累积 token（跨多轮工具调用要累加）。
- **L124**　`for (iter=0; iter<MAX_ITERATIONS; iter++)`：最多 8 轮。每轮 = 一次"问模型 + 可能执行工具"。
- **L125-128**　每轮开头检查 `signal?.aborted`，若已中断，yield `done(finishReason:'aborted')` 并 return。
- **L130**　`full` 用于累积这一轮流式 chunk 拼成完整一条消息。
- **L132**　`model.stream(messages, {signal})`：发起流式请求，signal 传入让请求可中断。
- **L134-146**　逐 chunk 消费：`concat` 把分片拼回 `full`；把 chunk 文本（用 `toText` 兼容不同 content 形状）yield 成 `token` 事件（打字机效果来源）；从 `additional_kwargs.reasoning_content` 读思维链（DeepSeek-R1/QwQ 的思考过程），yield 成 `reasoning` 事件。
- **L148-150**　这一轮结束：若无内容则 break；否则把完整 `full` 推入 `messages`（作为历史），并累计 token。
- **L152-157**　看这一轮模型是否要求调工具（`full.tool_calls`）。**若为空 → 模型给出了最终文字回答，收工**：打日志、yield `done(finishReason:'stop', usage)`、return。
- **L159-185**　若有工具调用：逐个执行。对每个 `call`：先 yield `tool_call` 事件（前端可展示"正在调用某工具"）；调 `invokeTool` 执行；yield `tool_result` 事件（含 ok 与结果文本）；再把结果包装成 `ToolMessage` 塞回 messages（**tool_call_id 必须回填**，模型才能把工具结果和调用对上）。处理完所有工具调用后，循环回到 L124 再问一轮。
- **L188-194**　若 8 轮都在调工具（没收敛到纯文本），打日志并 yield `error(MAX_ITERATIONS)` + `done(finishReason:'max_iterations')` 兜底退出——防止无限烧钱。

### 4.3 私有辅助方法

- **L197-223 `accumulateUsage`**　从 chunk 里提取 token 用量。**LangChain 版本不同字段位置不同**：新版在 `usage_metadata`，部分厂商仍在 `response_metadata.token_usage`，所以遍历两处候选，把数值字段逐项累加进 usage 对象。
- **L225-237 `logRun`**　打印一次请求的耗时与 token 总量（`usage.total_tokens` 或 `totalTokens`），供成本核算排查。
- **L239-272 `invokeTool`**　带**超时 + 重试**地执行单个工具：查注册表拿工具与策略；用 `Promise.race` 让工具调用和"超时定时器"赛跑，超时即 reject；失败按 `retries` 重试，最终仍失败则返回 `{ok:false, output:错误信息}`。**统一返回 {ok,output} 字符串**，避免异常泄漏到 Agent 流里崩掉整个连接。
- **L274-285 `toText`**　LLM content 可能是纯字符串，也可能是分片数组 `[{type:'text',text:'..'}]`。此函数兼容两种，只取 text 部分拼接；其它（如图片）忽略。

---

## 五、types/stream-event.ts

> 作用：SSE 推送给前端的每一种事件的**数据结构约定**。只定义类型、不含逻辑，前端依赖它做 UI 分支。

- **L1-6**　文档注释：SSE 事件用统一 JSON 信封；事件名固定为 `message`，靠 `type` 字段区分；另有 `:ping` 心跳注释行（不属于本协议，前端应跳过）。
- **L7-22**　用 TypeScript **可辨识联合（discriminated union）**定义 `StreamEvent`，每种都带一个字面量 `type` 作为判别字段：

| type | 含义 | 字段 |
|---|---|---|
| `start` | 流开始，前端拿到会话 ID | conversationId, messageId |
| `token` | 正文增量（打字机） | content |
| `reasoning` | 思维链（R1/QwQ 思考） | content |
| `tool_call` | 模型决定调用某工具 | id, name, args(JSON 串) |
| `tool_result` | 工具执行完毕 | id, name, ok, result |
| `error` | 出错了（可控错误） | code, message |
| `done` | 流结束 | finishReason, usage? |

**前端靠 type 分支渲染**；tsc 还能在 `ev.type==='token'` 时自动收窄出 `content` 字段，写代码更安全。

---

## 六、decorators/skip-response.decorator.ts

> 作用：提供 `@SkipResponse()` 装饰器，标记某个接口**不要被全局响应包装**。这是让 SSE 能在该项目"全局统一 JSON 壳"体系下正常工作的关键开关。

- **L1-3**　从 `@nestjs/common` 导入 `SetMetadata`（给处理器/类挂元数据），定义元数据键常量 `SKIP_RESPONSE_KEY='skipResponse'`——两个模块必须引用同一个 key 才能对上。
- **L5-11**　注释说明用途：用于 SSE / 文件下载 / 健康检查等需要"原样透出响应体"的场景。
- **L12**　导出装饰器工厂 `SkipResponse = () => SetMetadata(SKIP_RESPONSE_KEY, true)`——用法是在接口上写 `@SkipResponse()`，给该处理器挂上 `skipResponse:true`。

> 💡 **它与 ResponseInterceptor 怎么协作？** 全局 `ResponseInterceptor` 会用 `Reflector.getAllAndOverride(SKIP_RESPONSE_KEY, [handler, class])` 读取这个标记：若为 true 就 `return next.handle()` 原样放行（不做 `{code,msg,data}` 包装）；否则正常包壳。之所以用元数据而非判断 Content-Type，是因为 Nest 的 SSE 响应头在拦截器之后才写入，拦截器里看不到。

---

## 七、llm/llm.provider.ts

> 作用：以 Nest 依赖注入的方式提供"当前使用的语言模型"，并**通过 baseURL 做到模型无关**——换模型只改环境变量，不改代码。

- **L1-2**　导入 `Provider`（自定义 provider 的类型）与 `ChatOpenAI`（LangChain 的 OpenAI 兼容客户端）。
- **L4-8**　注释点明设计：用 `ChatOpenAI + configuration.baseURL` 通吃 DeepSeek/通义/豆包/Kimi/智谱等所有 OpenAI 兼容接口。
- **L9**　定义注入令牌常量 `CHAT_MODEL='CHAT_MODEL'`——AiService 用它 `@Inject('CHAT_MODEL')` 取实例。
- **L11-26**　定义 `chatModelProvider: Provider`，用 `useFactory` 工厂函数创建模型实例：`new ChatOpenAI({...})`，各配置项均读环境变量：

| 字段 | 来源 | 说明 |
|---|---|---|
| model | CHAT_MODEL_NAME | 默认 deepseek-chat |
| apiKey | OPENAI_API_KEY | 到平台控制台申请 |
| temperature | CHAT_MODEL_TEMPERATURE | 默认 0.3，工具/结构化场景低些更稳 |
| streaming | 固定 true | 必须流式 |
| maxRetries | 固定 1 | 减少重复计费 |
| timeout | CHAT_STREAM_TIMEOUT_MS | 默认 120s，防挂死 |
| configuration.baseURL | OPENAI_BASE_URL | **注意别加 /v1**，SDK 自动补 /chat/completions |

> 💡 **为什么不依赖 Nest ConfigModule？** 项目当前没引入 @nestjs/config，全站统一直接读 `process.env`（配合根目录 .env 由 dotenv 加载），此处保持一致。

---

## 八、tools/ 目录

### 8.1 tool.registry.ts（注册表）

> 作用：统一存放"AI 能调用的所有工具"及其**执行策略（超时/重试/权限）**。AiService 调工具前从这里取实例和策略。

- **L1-2**　导入 `Injectable` 与 `StructuredToolInterface`（LangChain 结构化工具接口类型，含 name/description/schema/invoke）。
- **L4-11**　定义 `ToolPolicy` 接口：`timeoutMs`（单次执行超时）、`retries`（失败重试）、`roles?`（允许调用的角色，权限预留，暂未用）。
- **L13-19**　注释点出**核心设计**：工具用**工厂函数**创建（不是直接 new），才能在闭包里使用 Nest DI 的 Service。
- **L20-23**　`@Injectable() class ToolRegistry`，内部维护两个 Map：`tools`（name→工具实例）、`policies`（name→策略）。
- **L25-32**　`register(tool, policy?)`：注册工具，同时用默认值(15s 超时、1 次重试)合并传入的策略后存进 policies。
- **L34-36**　`list()`：返回全部工具数组（供 model.bindTools 用）。
- **L38-40**　`get(name)`：按名字取工具，未注册返回 undefined。
- **L42-44**　`policy(name)`：按名字取执行策略。

### 8.2 user-info.tool.ts（示例工具）

> 作用：演示"如何写一个能访问数据库的 AI 工具"。名字 `query_user`，功能是按邮箱/昵称关键词查用户。

- **L1-3**　导入 `tool`（LangChain 的建工具函数）、`z`（zod，参数 schema，必须 v3 兼容）、`PrismaService`。
- **L5-7**　定义参数 schema `queryUserArgsSchema = z.object({keyword: z.string().describe('...')})`——声明工具需要 `keyword` 字符串参数。LangChain 会据此生成 JSON Schema 描述给模型，并自动校验/解析模型传来的参数。
- **L9-14**　注释强调工厂函数模式：接收 `prisma` 参数，返回工具。**这是让工具能访问 DB 的关键**——闭包捕获了注入进来的 PrismaService。
- **L15**　函数 `createQueryUserTool(prisma)`。
- **L16-32**　调用 `tool(执行函数, {name, description, schema})`：
  - 执行函数接收解构后的 `{keyword}`，用 Prisma 查用户：`where` 排除已删除(`deletedAt:null`)且 `email 或 nickname` 含关键词（`mode:'insensitive'` 忽略大小写）；`select` 只取 id/email/nickname；`take:5` 限 5 条防刷屏。
  - 无结果返回 `{"found":false}`，否则返回 `{"found":true, users:[...]}`。统一用 JSON 字符串返回，模型好解析。
- **L33-37**　给工具起名 `query_user`、写清楚 description（模型据此判断何时调用）与 schema。

### 8.3 index.ts（统一注册）

> 作用：模块出口 + 应用启动时把所有工具实例注册进 ToolRegistry 的**总入口**。

- **L1-4**　导入所需类型/Service/注册表/建工具函数。
- **L6-7**　`export * from './tool.registry'`、`export * from './user-info.tool'`：把注册表类与工具工厂"再导出"，其它文件可统一从 tools 目录引。
- **L9-12**　注释：新加工具就在 tools/ 下建 xxx.tool.ts，然后在这里登记即可。
- **L13-25**　`registerAllTools(registry, prisma)`：定义一个数组，每项 `{tool, policy}`。当前只有一个 `query_user` 工具（policy：10s 超时、1 次重试）。用 `createQueryUserTool(prisma)` 现场创建并传入刚注入的 PrismaService。
- **L27-29**　`for...of` 逐个 `registry.register(tool, policy)`。此函数由 AiModule 的 `onModuleInit()` 调用，保证应用一启动工具就绪。

---

## 九、memory/conversation.repository.ts

> 作用：封装会话与消息的存取。采用**双层记忆**——Redis 做短期热缓存（快、省 DB 压力），PostgreSQL(Prisma) 做长期持久化（稳、可回看）。Repository 对外是"读历史/写消息"的统一入口。

### 类型与常量（L5-19）

- **L5-14**　定义 `ChatMessage` 接口：一条消息的**统一形状**（无论来自内存/缓存/DB），字段含 id、role、content、toolCalls、toolCallId、name、createdAt。
- **L16-19**　常量：`HISTORY_LIMIT=20`（上下文窗口：只保留最近 20 条，防长对话爆 token）、`CACHE_TTL_SECONDS=1800`（Redis 缓存半小时）。

### 类与构造（L21-37）

- **L21-33**　`@Injectable() ConversationRepository`，DI 注入 `PrismaService` 与 `RedisService`；`logger` 打日志。
- **L35-37**　私有 `cacheKey(conversationId)` 返回 `ai:conv:${conversationId}`——Redis key 统一加 `ai:` 前缀，便于区分/清理。

### createConversation / listConversations（L39-50）

- **L39-43**　建会话：Prisma 插入 Conversation 行，userId/title/model（title 或 model 为空则写 null）。返回新记录（含 id）。
- **L45-50**　列会话：查该 userId 且未删除(`deletedAt:null`)的会话，按 `updatedAt` 倒序（新的在前）。

### appendMessage（L52-83）

- **L52-55**　签名：往某会话插入一条消息（入参用 `Omit<ChatMessage,'id'>` 排除 id，因为 id 由 DB 生成），返回完整 `ChatMessage`。
- **L56-65**　**先写库（持久化保证）**：Prisma 插入 Message（role/content/toolCalls/toolCallId/name），undefined 字段不写。拿到自增 `saved.id`。
- **L67-80**　**再写穿缓存（热数据）**：读现有缓存数组（`JSON.parse`，空则 []），把新消息 push 进去，`slice(-HISTORY_LIMIT)` 只留最近 20 条，`setex` 写回(带过期)。**整个 try/catch**：缓存失败只打 warn，不阻断主流程——因为 DB 已写成功，历史丢不了，顶多下次走 DB 回源。
- **L82**　返回带 id 的完整消息。

### loadHistory（L85-121）

- **L86-87**　先取缓存 key。
- **L89-94**　**Cache-first**：读 Redis，命中直接 `JSON.parse` 返回；catch 里若 Redis 异常则静默降级到下一步（注释：降级直查数据库）。
- **L96-100**　未命中则查库：Prisma 按 `conversationId`、`createdAt` 升序取，`take: -HISTORY_LIMIT` 是 Prisma 的"**从末尾取 N 条**"语法（取最近的 20 条）。
- **L102-110**　把 DB 行映射成 `ChatMessage[]`（role 强转、可空字段转 undefined、带上 createdAt）。
- **L112-118**　**回填缓存**：把查到的列表写回 Redis（setex）。同样 catch 兜底，缓存失败不阻断。
- **L120**　返回历史列表。

### softDeleteConversation（L123-129）

- **L124-127**　软删除：Prisma `updateMany` 把符合条件的会话(该用户 + 未删 + id 匹配)的 `deletedAt` 置为当前时间。
- **L128**　顺手 `del` 掉该会话的 Redis 缓存，避免脏数据残留。

> 💡 **为什么软删除？** 保留数据便于审计/恢复，删会话时不物理清 Message。且 Message 表外键是 `onDelete: Cascade`，若将来要物理删会话，消息会级联清除。

---

## 十、guards/stream-ticket.guard.ts

> 作用：保护 SSE 流接口。**EventSource 不支持自定义请求头**，无法带 JWT，因此用"一次性 ticket"代替——前端先 JWT 换票，再用票开流。

- **L1-7**　导入 `CanActivate`(守卫接口)、`ExecutionContext`(上下文)、`Injectable`、`UnauthorizedException`(401)、`RedisService`。
- **L9-15**　注释讲清背景：EventSource 不支持 Authorization 头 → 用 `POST /ai/chat/ticket` 拿一次性 ticket（30s）→ ticket 取完即焚，**避免 JWT 泄露在 URL 被重放**。
- **L16-18**　`@Injectable() class StreamTicketGuard implements CanActivate`，注入 RedisService。
- **L20-21**　`async canActivate(ctx)`：守卫核心方法，返回 boolean/Promise。取 HTTP 请求对象（类型断言含 url 与可选 userId）。
- **L24-25**　从 URL 解析 `ticket` 查询参数（SSE 走 GET，票放 query）。**用 `new URL(req.url,'http://localhost')`** 安全解析，避免手动字符串截取。
- **L26**　无 ticket 直接抛 401「缺少 ticket」。
- **L28-29**　去 Redis 用 `ai:ticket:${ticket}` 查它对应的 userId；查不到(票不存在或已过期)抛 401「ticket 无效或已过期」。
- **L31-33**　🔑 **取完即焚**：`del` 删掉这个 ticket——一次性，杜绝重放。把 `userId` 写到 `req.userId`，后续控制器直接用。
- **L34**　返回 true，放行进入 stream 方法。

---

## 十一、rate-limit.service.ts

> 作用：防止单用户刷接口烧钱。按 userId 用 Redis 计数限流（10 次/分钟）。方案的生产化检查清单要求按用户限流。

- **L4-7**　常量：`WINDOW_SECONDS=60`、`MAX_REQUESTS=10`（每分钟 10 次）。
- **L9-15**　定义返回结构 `RateLimitResult`：`allowed`(是否放行)、`remaining`(窗口剩余)、`resetSeconds`(多少秒后重置)。
- **L17-22**　注释：说明是"固定窗口计数"，简单够用；要更平滑可换令牌桶/Lua。
- **L23-27**　类，注入 RedisService。
- **L29-31**　私有 `key(userId)` 返回 `ai:ratelimit:${userId}`。
- **L33-42**　`check(userId)`：`client.incr(key)` 让计数 +1 并返回当前值（**原子操作，Redis 保证并发安全**）；若首次命中(count===1)就 `expire` 设 60s 过期，避免 key 永久堆积；再取 ttl 用于告诉调用方还剩多久。
- **L44-49**　判定：`count <= MAX_REQUESTS` 即放行；超限时打 warn 日志（含当前次数与重置剩余秒数），便于排查谁在刷。
- **L51-55**　组返回对象：remaining 用 `Math.max(0, MAX-count)` 保证非负；resetSeconds 用 ttl，若 ttl 已 <0 则回退到完整窗口。

---

## 十二、dto/chat.dto.ts

> 作用：定义请求体的**校验规则**（用 class-validator 装饰器）。这里目前实际是被换票接口 `createTicket` 预留使用（本版 stream 走 GET query，没走 body），是对话请求体的规范定义。

- **L1-7**　从 class-validator 导入校验装饰器：`IsNotEmpty`(非空)、`IsOptional`(可选)、`IsString`(字符串)、`IsUUID`(UUID 格式)、`MaxLength`(最大长度)。
- **L9**　注释：作用于 POST /ai/chat/ticket 的请求体。
- **L10-15**　`question` 字段：必须是字符串、非空、最长 4000 字。`!:` 是 TS 的明确赋值断言(在此类初始化时不检查未赋值)。配合 ValidationPipe 可自动拦截非法输入。
- **L18-20**　`conversationId`：可选；若提供了则必须符合 UUID 格式（校验会话 ID 合法性）。

---

## 十三、坑点与关键设计

> 以下均为**本次实测中真跑挂后修掉的 bug 与验证过的关键设计**，非臆测。

### ⚠️ 坑 1：流式接口必须用 `@Sse`，不能用 `@Get`

若用 `@Get` 返回 Observable，Nest 会把 Observable 当"普通异步值"解析，只取最后一个发出的值，把整个流拍平成单个 JSON → 响应头变 `application/json`，前端一个 token 事件都收不到。

而**最阴险的是后端其实照常调了 LLM 并把完整回答落库了**——看着像"前端没渲染"实则后端协议错了。

判别标志：看响应 `content-type` 是否为 `text/event-stream`。

### ⚠️ 坑 2：不 `bindTools` 模型永远不调工具

注册工具到 ToolRegistry 只解决"后端有工具"；必须 `this.model.bindTools(tools)` 把工具 schema 传给模型（放入请求的 `tools` 字段），模型才知道有哪些工具可调、`tool_calls` 才会有值。

否则 Agent 永远直接给文字答案，看似正常其实退化成了普通聊天。

### ⚠️ 坑 3：done 事件要在落库之后发

助手消息若在 `finally`（done 之后）才写库，客户端收到 done 立刻开下一轮会读到旧历史 → 多轮记忆"随机失效"。

修复：在 `done` 事件前先 `await persistAssistant()`，并用幂等标志避免 finally 重复写。

### ⚠️ 坑 4：SSE 错误要走 complete 而非 error

流中途若直接 `subscriber.error()`，会被全局 HttpExceptionFilter 捕获转成 JSON 响应，破坏已经建立的 SSE 通道。

正确做法是推一个 `{type:'error'}` 事件文本后 `complete()`。

### ✅ 关键 5：心跳防"半死连接"

代理/网关常设空闲超时，长时间无数据会误杀连接；每 15s 推 `:ping` 保活。

部署时 Nginx 还需 `proxy_buffering off` + `proxy_read_timeout` > 模型超时。

### ✅ 关键 6：中断要真 abort LLM

用户点"停止" → Observable unsubscribe → teardown 里 `controller.abort()` → signal 一路传到 `model.stream(messages,{signal})` → 底层请求真正取消，停止继续计费。

若只在 JS 层 return 而不断底层请求，token 照扣。

### ✅ 关键 7：Agent Loop 上限与工具兜底

`MAX_ITERATIONS=8` 兜死循环；工具执行 `Promise.race` 超时 + retries 重试 + 统一 `{ok,output}` 返回，避免单个工具异常让整条流崩掉；超轮/工具错都以 `error` 事件而非抛异常告知前端。

### ✅ 关键 8：双层记忆 & 上下文窗口

Redis 热缓存(最近 20 条, 30min TTL)让多轮取历史零 DB 压力；Prisma 持久化保底。缓存层全部 try/catch——缓存失败降级 DB，绝不因缓存问题丢掉用户数据。

### ✅ 关键 9：一次性 ticket 防重放

EventSource 无法带 Header，改用"JWT 换 30s 一次性票"，守卫取完即焚(`del`)，即使票被截获也无法二次使用。

---

## 十四、本模块之外的必要协同改动

AI 模块能跑通，还依赖下面几处跨文件改动（需一起理解）：

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/common/interceptors/response.interceptor.ts` | 注入 `Reflector`，读到 `SKIP_RESPONSE_KEY` 时原样放行 | 否则全局 `{code,msg,data}` 壳会包住 SSE 数据 |
| `src/main.ts` | `new ResponseInterceptor(app.get(Reflector))` 注册 | 拦截器现在需要 Reflector 构造参数 |
| `src/app.module.ts` | imports 里加入 `AiModule` | 让模块被应用加载 |
| `prisma/schema.prisma` | 新增 `Conversation`、`Message` 模型，User 补反向关联 | 提供持久化表；已跑迁移 `20260902141354_add_ai_conversation` |
| `package.json` | 装 @langchain/core、@langchain/openai、zod@^3 | Agent 与工具运行时依赖（项目实际为 langchain 1.x） |

接口验收脚本已放 `test/e2e-ai-check*.mts`（test 目录被构建排除），可用 `npx tsx test/e2e-ai-check2.mts` 复验。

---

*文档基于 2026-09-02 完成 P3 加固（中断链路 / 限流 / token 统计）后的代码生成。*
