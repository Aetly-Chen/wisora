# chat 模块 —— 待落地清单

> 完整代码与逐条说明见 **`docs/chat-backend-implementation.md`**。
> 本文件只是索引 + 勾选表，落地完成后可删除。

## 前置决策（做完再动手）

- [ ] 确认模型命名：本模块统一 `Chat*` 前缀（`Conversation` / `Message` 已被 AI 模块占用）
- [ ] 确认 §2 的 common 层搬迁：**推荐**搬到 `common/`，或走「最小改动」（导出 + import NotesModule）
- [ ] 阶段五要上 WebSocket 的话，先解决 3 个依赖（**不要直接 pnpm add**）

## 文件清单

### 本目录（`backend/src/chat/`）

- [ ] `chat.module.ts`
- [ ] `chat.controller.ts`
- [ ] `chat.gateway.ts`（先放 §5.4 空壳，阶段五再换实现）
- [ ] `chat.mapper.ts`
- [ ] `friends.service.ts`
- [ ] `conversations.service.ts`
- [ ] `messages.service.ts`
- [ ] `share.service.ts`
- [ ] `chat-attachments.service.ts`
- [ ] `dto/friend.dto.ts`
- [ ] `dto/conversation.dto.ts`
- [ ] `dto/message.dto.ts`
- [ ] `dto/share.dto.ts`
- [ ] `types/chat-events.ts`

### 公共层（按 §2 选定的路线）

- [ ] `common/storage/storage.module.ts`（+ 从 notes 迁入 `storage.service.ts`）
- [ ] `common/upload/file-guard.ts`
- [ ] `common/rate-limit/rate-limit.module.ts`（+ 从 ai 迁入 `rate-limit.service.ts`）

### 既有文件改动

- [ ] `prisma/schema.prisma`：`User` 加 `handle` / `bio` 与 4 个反向关系；追加 5 个 `Chat*` 模型与 3 个枚举
- [ ] `src/app.module.ts`：注册 `ChatModule` / `StorageModule` / `RateLimitModule`
- [ ] `src/notes/notes.module.ts` 与 `notes/attachments.service.ts`：改 import 来源
- [ ] `src/ai/ai.module.ts` 与 `ai.controller.ts`：改 `RateLimitService` 的 import 路径
- [ ] （可选，行为变更）`src/main.ts`：注册全局 `ValidationPipe`
- [ ] `src/main.ts` / `chat.gateway.ts`：WS 的 CORS 只能在网关装饰器里配（`enableCors()` 不管 WS）

## 必须记住的四个坑

1. `ChatAttachment.messageId` **必须可空** —— 上传与发送是两步，非空约束会让第一步插不进去。
2. `exports` 只能导出当前模块 `providers` 里有的东西 —— 别往 `AppModule` 的 `exports` 里塞 `ChatService`。
3. 全局**没有** `ValidationPipe`，DTO 装饰器不生效 —— 校验一律在 service 里另做一遍。
4. 前端 `MessageList.tsx:323` 的 `<img src={previewUrl}>` 接真实接口后**会 401**，
   要先取 Blob 再转 objectURL（照搬 `request/notes.ts` 的 `fetchAttachmentBlob`）。

## 验证

```bash
# 后端编译
cd D:/项目/wisora-web/backend && pnpm run build

# 前端全链路（需后端在跑）
cd D:/项目/_verify && node test-chat-module.js
```

阶段 3 建议补的后端断言清单见文档 §7。
