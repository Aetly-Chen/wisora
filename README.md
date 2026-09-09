# Wisora

多端响应式智能工作台，前后端分离，以 monorepo 方式管理。

## 目录结构

```
wisora/
├── backend/    后端 API · NestJS 11 + Prisma 7 + PostgreSQL + Redis + JWT
└── frontend/   前端 Web · React 19 + Vite 8 + TypeScript 6 + Tailwind 4 + shadcn/ui
```

两个工程各自独立安装依赖、独立启动，互不影响。

## 快速开始

### 后端

```bash
cd backend
pnpm install
pnpm prisma migrate deploy
pnpm prisma generate
pnpm start:dev     # http://localhost:3000
```

### 前端

```bash
cd frontend
pnpm install
pnpm dev
```

前端通过 `VITE_BASE_API` 指向后端地址（默认 `http://localhost:3000`）。

## 后端要点

内置 AI 流式 Agent 模块（`backend/src/ai`）：

- **SSE 一次性票据鉴权**：原生 `EventSource` 无法携带 `Authorization` 头，
  故先用 JWT 换取 30 秒有效的一次性 ticket 再开流，避免令牌泄露在 URL 与日志中
- `@Sse` 流式出口，配合 `@SkipResponse` 绕过全局响应包装
- **Agent Loop**：模型绑定工具，`tool_calls` 驱动多轮调用，`MAX_ITERATIONS=8` 防死循环
- 客户端断开时在 teardown 内 `abort()`，中断 LLM 请求，停止继续计费
- **工具分两类**：全局注册与按请求创建（闭包注入 `userId`，防越权）
- **写操作授权**：写工具需客户端换票时声明 `allowWrite` 才执行，否则拦截并由模型转告用户
- **归属校验** `assertOwned`：凡接收外部 `conversationId` 的入口必须先校验，防 IDOR
- **双层记忆**：Redis 热缓存（30 分钟，最近 20 条）+ PostgreSQL 持久化
- 按 `userId` 限流（10 次/分钟）
- 模型走 OpenAI 兼容协议，换厂商只需改环境变量

## 前端要点

- 首页：GSAP 四层联动视差滚动（单个 ScrollTrigger 驱动一条时间线，各层 `yPercent` 不同）
- AI 助手页（`/agent`）：流式对话，支持会话列表、历史回显与软删除
- 请求层：axios 统一实例（token 自动注入 / 401 刷新重放 / 重复请求取消），
  SSE 开流单独走 fetch（axios 基于 XHR 拿不到流式增量）
- 约定：**禁止在组件内部定义组件**，会导致每次 state 更新重挂子树、输入框失焦

## 环境变量

密钥一律通过各子项目的 `.env` 注入，已 gitignore，不进版本库。

后端需配置 `DATABASE_URL`、`REDIS_HOST`、`REDIS_PORT`、`JWT_ACCESS_SECRET`、
`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CHAT_MODEL_NAME`；

前端需配置 `VITE_BASE_API`。
