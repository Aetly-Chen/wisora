# Wisora

多端响应式智能工作台，前后端分离。后端基于 NestJS，内置 AI 流式 Agent 模块。

## 仓库结构

本仓库用分支区分前后端两个工程：

| 分支 | 工程 | 技术栈 |
| --- | --- | --- |
| `main` | 后端 API | NestJS 11 + Prisma 7 + PostgreSQL + Redis + JWT |
| `frontend` | 前端 Web | React 19 + Vite 8 + TypeScript 6 + Tailwind 4 + shadcn/ui |

两个工程在本地是平级目录（`wisora` 与 `wisora-web`），各自推送各自分支。

## 功能

### 业务模块

- `auth` — 注册、登录（密码 / 邮箱验证码）、刷新令牌、忘记密码
- `user` — 用户资料
- `verification-code` — 邮箱验证码
- `mail` — 邮件发送
- `redis` / `prisma` — 基础设施

### AI Agent（`src/ai`）

- **SSE 一次性票据鉴权**：原生 `EventSource` 无法携带 `Authorization` 头，
  故先用 JWT 换取 30 秒有效的一次性 ticket 再开流，避免令牌泄露在 URL 与日志中
- `@Sse` 流式出口，配合 `@SkipResponse` 绕过全局响应包装
- **Agent Loop**：模型绑定工具，`tool_calls` 驱动多轮调用，`MAX_ITERATIONS=8` 防死循环
- 客户端断开时在 teardown 内 `abort()`，中断 LLM 请求，停止继续计费
- **工具分两类**：全局注册（如 `query_user`）与按请求创建（闭包注入 `userId`，防越权）
- **写操作授权**：写工具需客户端换票时声明 `allowWrite` 才执行，否则拦截并由模型转告用户
- **归属校验** `assertOwned`：凡接收外部 `conversationId` 的入口必须先校验，防 IDOR
- **双层记忆**：Redis 热缓存（30 分钟，最近 20 条）+ PostgreSQL 持久化
- 按 `userId` 限流（10 次/分钟）
- 模型走 OpenAI 兼容协议，换厂商只需改环境变量

## 快速开始

```bash
pnpm install

# 配置环境变量（见下方）
pnpm prisma migrate deploy
pnpm prisma generate
pnpm start:dev
```

服务默认监听 `http://localhost:3000`。

## 环境变量

密钥一律通过 `.env` 注入，已 gitignore，不进版本库。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `REDIS_HOST` / `REDIS_PORT` | Redis 地址 |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 令牌签名密钥 |
| `MAIL_*` | 邮件服务配置 |
| `OPENAI_API_KEY` | 模型服务密钥 |
| `OPENAI_BASE_URL` | 模型服务地址（如 `https://api.deepseek.com`） |
| `CHAT_MODEL_NAME` | 模型名称（如 `deepseek-v4-flash`） |
| `CHAT_MODEL_TEMPERATURE` | 采样温度，默认 `0.3` |

## 常用命令

```bash
pnpm start:dev    # 开发
pnpm build        # 构建
pnpm test         # 测试
pnpm lint         # 代码检查
```

## 测试

`test/e2e-ai-check*.mts` 是 AI 模块的端到端验证脚本，
其中包含「收到 done 后立即发起下一轮」的竞态复现用例。
需先启动服务与依赖（PostgreSQL、Redis）后运行。
