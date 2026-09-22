# 聊天模块后端实现包

> 配套文档：`docs/chat-module-design.md`（设计意图）→ 本文（可直接落地的代码）。
> 前端聊天模块已完成并离线实测 40/40，数据来自 `frontend/src/request/chat.ts` 的内存 mock。
> 本文给出补齐后端的**全部新增文件与既有文件改动**，落在仓库里就能编译。

**当前状态**：本文的所有代码**尚未写入仓库**（`backend/src/chat/` 目前是空目录）。
落地方式：按 §7 的阶段顺序逐段粘贴，每段跑一次 `pnpm run build`。

---

## 0. 开工前必须先知道的 6 件事

这 6 条里前 5 条是**与设计文档不一致、或设计文档没写到的**，直接照设计文档写会踩：

### 0.1 ⚠️ 模型重名冲突：`Conversation` / `Message` 已被 AI 模块占用

`prisma/schema.prisma` 里已经有：

```prisma
model Conversation { ... }   // AI 助手会话
model Message { ... }        // AI 对话消息
```

设计文档 §3 提议的 `Conversation` / `Message` **与它们同名**。Prisma 不允许重名，直接写会报 `Duplicate model`。

**处理：整个聊天模块的模型统一加 `Chat` 前缀。**

| 设计文档里叫 | 本包采用 | 理由 |
| --- | --- | --- |
| `Friendship` | `ChatFriendship` | 统一前缀，`grep "^model Chat"` 一次拿到本模块全部模型 |
| `Conversation` | `ChatConversation` | **必须**改名（冲突） |
| `ConversationMember` | `ChatConversationMember` | 统一前缀 |
| `Message` | `ChatMessage` | **必须**改名（冲突） |
| `ChatAttachment` | `ChatAttachment` | 不冲突，保留 |

枚举同理：`ChatConversationKind` / `ChatMessageKind` / `ChatMessageStatus`（Prisma 的 enum 是全局命名空间）。

### 0.2 ⚠️ `ChatAttachment.messageId` 必须可空（修正设计文档）

设计文档写的是 `messageId String`（非空）。**那样两步上传根本走不通**：

```
① POST /chat/attachments  → 落盘、写库   ← 此刻还没有 messageId
② POST /conversations/:id/messages { attachmentId }  → 才建立关联
```

第 ① 步非空约束就插不进去。所以：

```prisma
messageId String? @unique      // 可空 = 尚未挂到任何消息上（待发送）
```

代价：会产生「传了但没发出去」的孤儿附件。**这是必须的**，且要配一个清理任务（见 §7 阶段二附注）。

### 0.3 ⚠️ WebSocket 依赖缺失

`package.json` 里**没有** `@nestjs/websockets` / `@nestjs/platform-socket.io` / `socket.io`。要上阶段五必须新装 3 个包。

⚠️ **不要在这个项目里直接跑 `pnpm add`** —— 历史上被沙箱 safe-delete 拦过，且**会先把顶层目录删掉**（曾导致 `Cannot find module 'sonner'`）。稳妥做法见 §5.1。

### 0.4 ⚠️ 全局没有 `ValidationPipe`，DTO 装饰器目前不生效

我实测确认过：

```
$ grep -rn "ValidationPipe\|useGlobalPipes" backend/src/
（无输出）

$ curl -X POST localhost:3000/notes -d '{"title":123}'
{"code":401,"msg":"缺少访问令牌"}      # 换成合法令牌也不会因为 title 不是字符串而被拒
```

也就是说，现有 `auth`、`notes` 模块 DTO 上的 `@IsString()` 这类装饰器**只是文档，没有运行时约束**。

**本包的处理**：DTO 仍按项目既有风格写装饰器（保持一致、日后开了管道立刻生效），但**所有校验在 service 里另做一遍**，不依赖 DTO。这也是下面每个 service 里看起来"校验有点啰嗦"的原因 —— 不是冗余。

要真正启用需要一行改动（见 §4.11.3），但那是**行为变更**（原本能过的请求可能被拒），建议单独一个提交、跑一遍回归再上。

### 0.5 ⚠️ `User` 表缺 `handle` / `bio` 两列

前端 `Friend` 形状要求 `handle`（唯一账号标识，`@handle` 展示与搜索）和 `bio`（个性签名）。现有 `User` 只有 `id / email / password / nickname / emailVerified / createdAt / updatedAt / deletedAt`。

需要给 `User` 加两列：

```prisma
handle String? @unique     // 可空：老用户没有，展示时回退到邮箱前缀
bio    String?
```

**`handle` 必须可空**：表里已有数据，非空加唯一约束会直接迁移失败。Postgres 的唯一索引允许多个 NULL，所以不影响唯一性。

### 0.6 三处既有代码需要小改（因为 chat 要复用）

| 要复用的东西 | 现状 | 为什么必须动 |
| --- | --- | --- |
| `StorageService` | 在 `notes/` 下，`NotesModule` 只 `exports: [NotesService]` | chat 拿不到它。**两种处理**见 §2.1 |
| MIME 白名单 + `decodeFilename` | 写在 `notes/attachments.service.ts` 内部（未导出） | 安全白名单不该有两份，抽到 `common/upload/` |
| `RateLimitService` | 在 `ai/` 下，`AiModule` 未导出；`key` 前缀与阈值都写死 | chat 要限流。**两种处理**见 §2.3 |

§2 给出**推荐做法（搬到 common）** 和**最小改动做法**，二选一。

---

## 1. 目录结构（已创建）

```
backend/src/chat/                          ← 已建（当前为空目录 + .gitkeep）
├── chat.module.ts
├── chat.controller.ts
├── chat.gateway.ts                        ← 阶段五，需先装依赖
├── chat.mapper.ts                         ← 形状映射集中一处
├── friends.service.ts
├── conversations.service.ts
├── messages.service.ts
├── share.service.ts
├── chat-attachments.service.ts
├── dto/
│   ├── friend.dto.ts
│   ├── conversation.dto.ts
│   ├── message.dto.ts
│   └── share.dto.ts
└── types/
    └── chat-events.ts

backend/src/common/storage/                ← 已建（推荐路线，最小路线可删）
├── storage.service.ts
└── storage.module.ts

backend/src/common/upload/                 ← 已建
└── file-guard.ts

backend/src/common/rate-limit/             ← 已建（推荐路线，最小路线可删）
├── rate-limit.service.ts
└── rate-limit.module.ts
```

**为什么要多一个 `chat.mapper.ts`**（设计文档里没有）：`Message` 这个形状在 4 个 service 里都要拼（会话列表的最后一条、历史消息、发送返回、分享写入）。散着写的话，前端字段一旦变动就得改 4 处 —— 这正是笔记模块当初「create 漏了 `attachments` 字段」那类 bug 的成因。集中在一个文件，前后端对齐只在一处维护。

---

## 2. 前置：Common 层三处搬迁

> 想先跑起来、不想动既有文件的话，可以跳到 §2 末尾的「最小改动做法」。

### 2.1 `StorageService` 搬到 `common/storage/`（推荐）

**理由**：`AiModule` 与 `NotesModule` 之间已经有先例 —— 通用关注点不该由业务模块提供。而且 `NotesModule` 并没有导出它，chat 想用只能反向依赖 notes（日后想单独拆 chat 就拆不动）。

**操作**：

```bash
cd D:/项目/wisora-web/backend
git mv src/notes/storage.service.ts src/common/storage/storage.service.ts
```

文件内容**一行都不用改**（它没有依赖 notes 里的任何东西）。

新建 `src/common/storage/storage.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * 附件实体存储。
 *
 * 标 @Global() 与 PrismaModule / RedisModule 保持同一风格：
 * 它是基础设施，多个业务模块（notes / chat）都要用，
 * 让每个模块都 imports 一遍只是样板代码。
 *
 * 从 notes 模块搬到这里，是因为 chat 也要用它 ——
 * 留在 notes 里会让 chat 反向依赖 notes 模块。
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
```

然后两处改动：

```diff
  // src/notes/notes.module.ts
  import { AttachmentsService } from './attachments.service';
- import { StorageService } from './storage.service';
  import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
+ import { StorageModule } from '../common/storage/storage.module';

  @Module({
-   imports: [JwtModule.register({})],
+   imports: [JwtModule.register({}), StorageModule],
    controllers: [NotesController, AttachmentsController],
-   providers: [NotesService, AttachmentsService, StorageService, JwtAuthGuard],
+   providers: [NotesService, AttachmentsService, JwtAuthGuard],
    exports: [NotesService],
  })
```

```diff
  // src/notes/attachments.service.ts
- import { StorageService } from './storage.service';
+ import { StorageService } from '../common/storage/storage.service';
```

也要把 `StorageModule` 加进 `app.module.ts` 的 `imports`（`@Global()` 模块仍需在根模块挂一次）：

```diff
  import { NotesModule } from './notes/notes.module';
+ import { StorageModule } from './common/storage/storage.module';

  @Module({
    imports: [
      ...
      AiModule,
      NotesModule,
+     StorageModule,
    ],
```

> **最小改动做法**：不动 storage.service.ts 的位置，只把 `StorageService` 加进
> `NotesModule` 的 `exports`，然后 `ChatModule` 里 `imports: [NotesModule]`。
> 可行（chat 本来就为了分享功能要 import NotesModule），但等于承认
> "存储是笔记模块的能力"，日后第三个模块要用时还得再抄一遍。

### 2.2 抽出 `common/upload/file-guard.ts`

`notes/attachments.service.ts` 里的 `decodeFilename()` 和 `ALLOWED_MIME` 目前是文件私有。chat 需要**同一套**规则 —— MIME 白名单是安全边界，有两份实现早晚会不一致（而且不一致的那份通常是宽松的那份）。

新建 `src/common/upload/file-guard.ts`：

```ts
import { BadRequestException } from '@nestjs/common';

/**
 * multer 上传文件的形状。
 *
 * 本地声明而不是依赖 @types/multer：项目里 multer 只是
 * @nestjs/platform-express 的传递依赖，为一个类型引入新的 types 包不划算。
 */
export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * 允许上传的类型白名单。
 *
 * 刻意不做通配放行：上传目录同源可访问，若放任 .html / .svg 等
 * 可执行脚本的类型落盘，等于给自己开了个存储型 XSS 的口子。
 * text/html、image/svg+xml、application/x-msdownload 一律不放行。
 */
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'text/markdown',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  // Office 文档：支持上传与下载，前端不做在线预览
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 聊天场景额外放行的两类（笔记那边用不到）
  'application/zip',
  'application/x-zip-compressed',
  'video/mp4',
]);

/**
 * 还原文件名编码。
 *
 * multer 对 multipart 里的文件名按 latin1 解码，中文名会变成
 * "æµè¯ææ¡£.pdf" 这样的乱码 —— 字节本身没错（仍是 UTF-8 序列），
 * 只是被当成了单字节字符。这里按 latin1 读回字节再解成 UTF-8。
 *
 * 加两道判断是因为存在两种情况：
 *   1. 名字含 0x80–0xFF 的高位字符 → 属于 latin1 误读，需要还原
 *   2. 客户端已正确按 UTF-8 传（字符码 > 0xFF）→ 原样返回
 * 还原结果若含替换字符 U+FFFD，说明本就不是误读，同样保持原样。
 */
export function decodeFilename(name: string): string {
  if (!/[\u0080-\u00ff]/.test(name)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

/**
 * 校验上传文件：非空 → 体积 → MIME 白名单。
 *
 * 注意校验顺序是「先小后大」：体积检查是纯计算，
 * MIME 检查要看集合，先做便宜的。
 */
export function assertUploadable(
  file: UploadedFileLike,
  maxBytes: number,
): void {
  if (file.size === 0) {
    throw new BadRequestException('文件为空，无法上传');
  }
  if (file.size > maxBytes) {
    throw new BadRequestException(
      `单个文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB`,
    );
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new BadRequestException(`不支持的文件类型：${file.mimetype}`);
  }
}
```

然后 `notes/attachments.service.ts` 改成引用它（删掉文件内的私有实现）：

```diff
- import { StorageService } from './storage.service';
+ import { StorageService } from '../common/storage/storage.service';
+ import {
+   ALLOWED_MIME,
+   assertUploadable,
+   decodeFilename,
+   type UploadedFileLike,
+ } from '../common/upload/file-guard';
```

> `UploadedFileLike` 原先定义在 `notes/attachments.service.ts` 并导出，被
> `attachments.controller.ts` 引用。搬迁后要保留一行 re-export 以免动到控制器：
>
> ```ts
> // notes/attachments.service.ts 末尾
> export type { UploadedFileLike } from '../common/upload/file-guard';
> export { ALLOWED_MIME };
> ```
>
> 或者干脆把控制器的 import 也改成指向 common —— 更干净，但多改一个文件。

### 2.3 `RateLimitService` 通用化（推荐）

现状：`ai/rate-limit.service.ts` 里 `key` 写死 `ai:ratelimit:${userId}`、阈值写死 `MAX_REQUESTS = 10`，且 `AiModule` 没有导出它。

**做法**：移到 `common/rate-limit/`，给它加 `scope` 与 `max` 两个可选参数，**默认值保持原样**，这样 `ai` 那边的调用点行为完全不变。

新建 `src/common/rate-limit/rate-limit.service.ts`：

```ts
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';

/** 默认窗口：60 秒 */
const WINDOW_SECONDS = 60;
/** 默认窗口内允许的请求数（沿用 ai 模块原来的阈值） */
const DEFAULT_MAX_REQUESTS = 10;
/** 未指定 scope 时用的命名空间，与搬迁前保持一致，避免计数器被重置 */
const DEFAULT_SCOPE = 'ai';

export interface RateLimitOptions {
  /** 命名空间。同一个人在不同业务下的配额互相独立 */
  scope?: string;
  /** 窗口内允许的请求数 */
  max?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 窗口内剩余可用次数 */
  remaining: number;
  /** 距离窗口重置的剩余秒数 */
  resetSeconds: number;
}

/**
 * 按 userId 的固定窗口限流（Redis INCR + 过期时间）。
 *
 * 说明：实现简单、够用；若要更平滑可换令牌桶或 Lua 脚本。
 *
 * 从 ai 模块搬到 common：聊天模块发消息也要限流，
 * 而 AiModule 没导出它。加 scope 参数是为了让两个业务的配额互不干扰 ——
 * 共用一个 key 的话，用户狂发 AI 消息会把聊天配额一起吃掉。
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  private key(userId: string, scope: string) {
    return `${scope}:ratelimit:${userId}`;
  }

  async check(
    userId: string,
    options: RateLimitOptions = {},
  ): Promise<RateLimitResult> {
    const scope = options.scope ?? DEFAULT_SCOPE;
    const max = options.max ?? DEFAULT_MAX_REQUESTS;

    const client = this.redis.getClient();
    const key = this.key(userId, scope);

    const count = await client.incr(key);
    // 首次命中时设置过期时间，避免 key 永久留存
    if (count === 1) {
      await client.expire(key, WINDOW_SECONDS);
    }
    const ttl = await client.ttl(key);

    const allowed = count <= max;
    if (!allowed) {
      this.logger.warn(
        `user ${userId} 触发限流 [${scope}]：${count}/${max}（${ttl}s 后重置）`,
      );
    }

    return {
      allowed,
      remaining: Math.max(0, max - count),
      resetSeconds: ttl > 0 ? ttl : WINDOW_SECONDS,
    };
  }
}
```

`src/common/rate-limit/rate-limit.module.ts`：

```ts
import { Global, Module } from '@nestjs/common';
import { RateLimitService } from './rate-limit.service';

/**
 * 限流是横切关注点，与 PrismaModule / RedisModule 同风格标 @Global()。
 */
@Global()
@Module({
  providers: [RateLimitService],
  exports: [RateLimitService],
})
export class RateLimitModule {}
```

改动 `ai` 模块（**行为不变**）：

```diff
  // src/ai/ai.module.ts
- import { RateLimitService } from './rate-limit.service';
+ import { RateLimitService } from '../common/rate-limit/rate-limit.service';
```

```diff
  // src/ai/ai.controller.ts
- import { RateLimitService } from './rate-limit.service';
+ import { RateLimitService } from '../common/rate-limit/rate-limit.service';
```

然后删掉 `src/ai/rate-limit.service.ts`：

```bash
git rm src/ai/rate-limit.service.ts
```

> **若想让服务真正生效**，`RateLimitModule` 也要挂进 `app.module.ts` 的 `imports`
> （和 `StorageModule` 一样，`@Global()` 不代表不用挂）。
> 或者嫌 `AiModule` / `ChatModule` 里 `providers` 已经有它，也可以不标 `@Global()`
> 而改成每个模块各自 `imports: [RateLimitModule]` —— 二选一，别混用。

---

## 3. Prisma 数据模型

### 3.1 `User` 增加两列与四个反向关系

```diff
 model User {
   id            String    @id @default(cuid())
   email         String    @unique
   password      String
   nickname          String?

   emailVerified Boolean   @default(false)

   createdAt     DateTime  @default(now())
   updatedAt     DateTime  @updatedAt
   deletedAt     DateTime?
   conversations Conversation[]
   notes         Note[]
   attachments   Attachment[]
+
+  /// 唯一账号标识，用于 @handle 展示与搜索。老用户为空，展示时回退到邮箱前缀
+  handle String? @unique
+  /// 个性签名 / 职位
+  bio    String?
+
+  friendships      ChatFriendship[]           @relation("ChatFriendshipOwner")
+  friendOf         ChatFriendship[]           @relation("ChatFriendshipTarget")
+  chatMemberships  ChatConversationMember[]
+  chatMessages     ChatMessage[]
+  chatAttachments  ChatAttachment[]
 }
```

### 3.2 五个新模型（完整可粘贴）

追加到 `prisma/schema.prisma` 末尾：

```prisma
/* ==================================================================== */
/* 聊天模块                                                              */
/*                                                                       */
/* 模型名统一加 Chat 前缀：Conversation / Message 已被 AI 助手模块占用，   */
/* Prisma 的模型与枚举都在同一命名空间，重名会直接报 Duplicate model。     */
/* ==================================================================== */

/// 好友关系。每人一行：A 加 B 会写 (A,B) 与 (B,A) 两条，双向可见
model ChatFriendship {
  id        String   @id @default(cuid())
  userId    String
  friendId  String
  /// 备注名，为空时展示对方的 nickname
  alias     String?
  createdAt DateTime @default(now())

  user   User @relation("ChatFriendshipOwner", fields: [userId], references: [id], onDelete: Cascade)
  friend User @relation("ChatFriendshipTarget", fields: [friendId], references: [id], onDelete: Cascade)

  /// 同一个好友只能加一次
  @@unique([userId, friendId])
  @@index([friendId])
}

enum ChatConversationKind {
  DIRECT
  GROUP
}

model ChatConversation {
  id        String               @id @default(cuid())
  kind      ChatConversationKind
  /// 群聊的群名。单聊为 null，标题由前端按对方名字推导
  title     String?
  /// 群聊创建者，用于权限判断
  ownerId   String?
  /// 单聊去重键：两个成员 id 排序后 ':' 连接。群聊为 null
  directKey String?              @unique
  createdAt DateTime             @default(now())
  updatedAt DateTime             @updatedAt

  members  ChatConversationMember[]
  messages ChatMessage[]

  @@index([updatedAt])
}

/// 会话成员。把「置顶 / 免打扰 / 未读」放在成员维度而不是会话维度 ——
/// 这些是每个人自己的状态，放会话上会导致 A 读了消息、B 的未读数也被清零
model ChatConversationMember {
  id             String    @id @default(cuid())
  conversationId String
  userId         String
  pinned         Boolean   @default(false)
  muted          Boolean   @default(false)
  unread         Int       @default(0)
  /// 最后已读的时间，用于算未读与已读回执
  lastReadAt     DateTime?
  joinedAt       DateTime  @default(now())
  /// 退出/被移出群聊的时间；为 null 表示仍在群里
  leftAt         DateTime?

  conversation ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user         User             @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([conversationId, userId])
  @@index([userId, pinned])
}

enum ChatMessageKind {
  TEXT
  IMAGE
  FILE
  NOTE
}

enum ChatMessageStatus {
  SENT
  READ
}

model ChatMessage {
  id             String            @id @default(cuid())
  conversationId String
  senderId       String
  kind           ChatMessageKind
  /// 文本内容；附件与笔记卡片也可以带一句说明
  text           String?
  /// 分享的笔记快照（只存 id / 标题 / 类型 / 子页面数，不存正文）
  noteId         String?
  noteTitle      String?
  noteKind       String?
  noteChildCount Int               @default(0)
  status         ChatMessageStatus @default(SENT)
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt

  conversation ChatConversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender       User             @relation(fields: [senderId], references: [id])
  /// 一个附件只属于一条消息
  attachment   ChatAttachment?

  /// 拉历史消息按 (会话, 时间倒序) 分页，这个复合索引是必需的
  @@index([conversationId, createdAt])
}

/// 聊天附件。与笔记的 Attachment 分表：
/// 两者生命周期不同（删笔记不该删聊天记录里的文件），混在一张表会互相牵连
model ChatAttachment {
  id         String   @id @default(cuid())
  /// 可空！上传与发送是两步：先 POST /chat/attachments 拿 id，
  /// 再带 attachmentId 发消息时才建立关联。非空约束会让第一步插不进去
  messageId  String?  @unique
  uploaderId String
  filename   String
  /// 存储相对路径。文件名用随机 UUID + 扩展名，杜绝路径穿越与同名覆盖
  storageKey String   @unique
  mimeType   String
  size       Int
  createdAt  DateTime @default(now())

  message ChatMessage? @relation(fields: [messageId], references: [id], onDelete: Cascade)

  /// 清理孤儿附件（上传了但没发出去）要靠这个索引
  @@index([uploaderId, createdAt])
}
```

### 3.3 迁移

```bash
cd D:/项目/wisora-web/backend
pnpm exec prisma migrate dev --name add_chat_module
pnpm exec prisma generate
```

⚠️ **不要用 `prisma migrate status` 判断有没有漂移** —— Prisma 7 的 `status` 只比对已应用的迁移文件，schema 加了模型但还没建迁移时照样显示 "up to date"（笔记模块那次就是这么被骗的）。要 `migrate dev` 实跑，或者直接查库：

```bash
node -e "
const path=require('path');
const {Client}=require(path.join(process.cwd(),'node_modules/.pnpm/pg@8.23.0/node_modules/pg'));
require('dotenv/config');
const c=new Client({connectionString:process.env.DATABASE_URL.replace(/\"/g,'')});
c.connect().then(()=>c.query(\"SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'Chat%' ORDER BY tablename\"))
 .then(r=>{console.log(r.rows.map(x=>'  '+x.tablename).join('\n'));return c.end();});
"
```

期望看到 5 张表：`ChatAttachment` / `ChatConversation` / `ChatConversationMember` / `ChatFriendship` / `ChatMessage`。

---

## 4. 模块内文件（逐文件完整代码）

### 4.1 `src/chat/types/chat-events.ts`

```ts
/**
 * 后端出参形状与实时事件。
 *
 * 与前端 `frontend/src/types/chat.ts` 一一对应 —— 字段名或空值语义一旦改动，
 * 两处必须同时改。前端刻意用 `| null` 而不是可选字段，后端这边也保持一致：
 * 可空关系一律给 null，不给 undefined。
 *
 * 原因：JSON.stringify 会把值为 undefined 的键整个丢掉，前端读到的就是
 * 「字段不存在」，与「字段为 null」在类型上不等价 —— 前端按 `foo === null`
 * 判断的地方会全部走错分支。
 */

export type Presence = 'online' | 'away' | 'offline';
export type ConversationKindDto = 'direct' | 'group';
export type MessageKindDto = 'text' | 'image' | 'file' | 'note';
export type MessageStatusDto = 'sent' | 'read';

export interface AttachmentDto {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  /** 图片给出可预览地址。接口本身需要鉴权，前端要取 Blob 再转 objectURL */
  previewUrl?: string;
}

export interface SharedNoteDto {
  noteId: string;
  title: string;
  /** 分享的是单篇笔记还是一个目录 */
  kind: 'note' | 'folder';
  childCount: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  senderId: string;
  kind: MessageKindDto;
  text: string | null;
  attachment: AttachmentDto | null;
  note: SharedNoteDto | null;
  createdAt: string;
  /** 后端只会返回 sent / read；sending / failed 是前端本地状态 */
  status: MessageStatusDto;
}

export interface ConversationDto {
  id: string;
  kind: ConversationKindDto;
  title: string | null;
  /** 必须包含当前用户 */
  memberIds: string[];
  lastMessage: MessageDto | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FriendDto {
  id: string;
  name: string;
  handle: string;
  /** 非好友时已脱敏，如 y***@example.com */
  email: string;
  /** 无签名时是空字符串，不是 null —— 前端直接渲染 */
  bio: string;
  presence: Presence;
  isFriend: boolean;
}

export interface ShareNoteResultDto {
  conversationCount: number;
  messageCount: number;
}

/* ------------------------------ 实时事件 ------------------------------ */

/** 服务端 → 客户端 */
export type ChatServerEvent =
  | { type: 'message'; message: MessageDto }
  | { type: 'typing'; conversationId: string; userId: string; typing: boolean }
  | { type: 'read'; conversationId: string; userId: string }
  | { type: 'presence'; userId: string; presence: Presence };

/** 客户端 → 服务端 */
export type ChatClientEvent =
  | { type: 'typing'; conversationId: string; typing: boolean }
  | { type: 'read'; conversationId: string };
```

### 4.2 `src/chat/chat.mapper.ts`

```ts
import type {
  AttachmentDto,
  ConversationDto,
  FriendDto,
  MessageDto,
  Presence,
} from './types/chat-events';

/*
 * 这个文件是「数据库行 → 接口出参」的唯一转换点。
 *
 * 为什么不散在各个 service 里：Message 这个形状在 4 个地方都要拼
 * （会话列表的最后一条、历史消息、发送返回、分享写入）。
 * 散着写的话前端字段一变就得改 4 处 —— 笔记模块当初
 * 「create 接口漏返回 attachments」就是这么来的。
 */

/* ------------------------------ Prisma select ------------------------------ */

export const USER_SHAPE = {
  id: true,
  email: true,
  nickname: true,
  handle: true,
  bio: true,
} as const;

export const ATTACHMENT_SHAPE = {
  id: true,
  filename: true,
  mimeType: true,
  size: true,
} as const;

export const MESSAGE_SHAPE = {
  id: true,
  conversationId: true,
  senderId: true,
  kind: true,
  text: true,
  noteId: true,
  noteTitle: true,
  noteKind: true,
  noteChildCount: true,
  status: true,
  createdAt: true,
  attachment: { select: ATTACHMENT_SHAPE },
} as const;

export const CONVERSATION_SHAPE = {
  id: true,
  kind: true,
  title: true,
  createdAt: true,
  updatedAt: true,
  // 成员 id：与列表一起返回，否则前端渲染每行都要再发一次请求
  members: { where: { leftAt: null }, select: { userId: true } },
  // 最后一条消息：列表用它渲染摘要
  messages: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: MESSAGE_SHAPE,
  },
} as const;

/* ------------------------------ 行类型 ------------------------------ */
/*
 * 手写结构类型而不是从 Prisma 推导（Prisma.ChatMessageGetPayload<...>）：
 * 后者会把 select 的 readonly 修饰一起带进来，和这里的可变参数互相打架。
 * 结构上够用即可，字段对不上编译期就能发现。
 */

interface AttachmentRow {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

interface MessageRow {
  id: string;
  conversationId: string;
  senderId: string;
  kind: string;
  text: string | null;
  noteId: string | null;
  noteTitle: string | null;
  noteKind: string | null;
  noteChildCount: number;
  status: string;
  createdAt: Date;
  attachment: AttachmentRow | null;
}

interface ConversationRow {
  id: string;
  kind: string;
  title: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{ userId: string }>;
  messages: MessageRow[];
}

interface MemberFlags {
  pinned: boolean;
  muted: boolean;
  unread: number;
}

interface UserRow {
  id: string;
  email: string;
  nickname: string | null;
  handle: string | null;
  bio: string | null;
}

/* ------------------------------ 映射 ------------------------------ */

export function toAttachment(row: AttachmentRow): AttachmentDto {
  const dto: AttachmentDto = {
    id: row.id,
    name: row.filename,
    size: row.size,
    mimeType: row.mimeType,
  };
  // 只有图片给预览地址；其它类型前端渲染成文件卡片，不需要取流
  if (row.mimeType.startsWith('image/')) {
    dto.previewUrl = `/chat/attachments/${row.id}/content`;
  }
  return dto;
}

export function toMessage(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    kind: row.kind.toLowerCase() as MessageDto['kind'],
    text: row.text,
    attachment: row.attachment ? toAttachment(row.attachment) : null,
    note: row.noteId
      ? {
          noteId: row.noteId,
          title: row.noteTitle ?? '笔记',
          kind: (row.noteKind as 'note' | 'folder' | null) ?? 'note',
          childCount: row.noteChildCount,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    status: row.status.toLowerCase() as MessageDto['status'],
  };
}

export function toConversation(
  row: ConversationRow,
  member: MemberFlags,
): ConversationDto {
  return {
    id: row.id,
    kind: row.kind.toLowerCase() as ConversationDto['kind'],
    title: row.title,
    memberIds: row.members.map((m) => m.userId),
    lastMessage: row.messages[0] ? toMessage(row.messages[0]) : null,
    unread: member.unread,
    pinned: member.pinned,
    muted: member.muted,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * handle：老用户为空，回退到邮箱前缀。
 *
 * 这是权宜之计 —— 邮箱前缀可能重复（a@x.com 与 a@y.com），
 * 搜索时按它匹配会给出多个候选。等 handle 补全后应把回退去掉。
 */
export function handleOf(user: { handle: string | null; email: string }): string {
  return user.handle?.trim() || user.email.split('@')[0] || user.id.slice(0, 8);
}

export function displayNameOf(user: {
  nickname: string | null;
  email: string;
}): string {
  return user.nickname?.trim() || user.email.split('@')[0];
}

/**
 * 非好友时脱敏邮箱。
 *
 * 搜索接口会把陌生人也返回出来，直接给完整邮箱等于把用户邮箱
 * 变成了可枚举的资源（按 handle 逐个试探即可批量收集）。
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}

export function toFriend(
  user: UserRow,
  opts: { isFriend: boolean; presence: Presence; alias?: string | null },
): FriendDto {
  return {
    id: user.id,
    // 备注名优先于昵称
    name: opts.alias?.trim() || displayNameOf(user),
    handle: handleOf(user),
    email: opts.isFriend ? user.email : maskEmail(user.email),
    // 空字符串而不是 null：前端直接渲染，不做空值判断
    bio: user.bio ?? '',
    presence: opts.presence,
    isFriend: opts.isFriend,
  };
}
```

### 4.3 DTO

`src/chat/dto/friend.dto.ts`：

```ts
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class AddFriendDto {
  @IsString()
  @IsNotEmpty({ message: '缺少 userId' })
  @MaxLength(64)
  userId!: string;
}
```

`src/chat/dto/conversation.dto.ts`：

```ts
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 创建会话。
 *
 * 单聊与群聊共用一个 DTO 而不是拆两个：路径相同（POST /chat/conversations），
 * 只在 body 里用 kind 区分。跨字段的约束（kind=direct 必须给 friendId、
 * kind=group 必须给 title+memberIds）没法用装饰器表达，
 * 由 ConversationsService.create 负责校验。
 */
export class CreateConversationDto {
  @IsIn(['direct', 'group'], { message: 'kind 只能是 direct 或 group' })
  kind!: 'direct' | 'group';

  /** kind=direct 时必填 */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  friendId?: string;

  /** kind=group 时必填 */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  /** kind=group 时必填，不需要包含自己（后端会加） */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(100, { message: '群成员最多 100 人' })
  memberIds?: string[];
}

export class UpdateConversationDto {
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsBoolean()
  muted?: boolean;
}
```

`src/chat/dto/message.dto.ts`：

```ts
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * 发消息。
 *
 * 注意这里收的是 `attachmentId` / `noteId`，不是完整的附件对象或笔记对象。
 * 前端适配层负责把 `payload.attachment.id` 拍平成 `attachmentId`。
 *
 * 为什么不让前端传完整对象：`note.title` 这类字段一旦由客户端提供，
 * 就可以伪造标题把别人的笔记发出去（后端会按 noteId 自己取快照）。
 */
export class SendMessageDto {
  @IsOptional()
  @IsString()
  @MaxLength(4000, { message: '单条消息最多 4000 字' })
  text?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  attachmentId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  noteId?: string;
}
```

`src/chat/dto/share.dto.ts`：

```ts
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * 分享笔记给好友。
 *
 * 刻意只有 noteId，没有 title / childCount ——
 * 后端按 noteId 调 NotesService.get() 自己取快照，
 * 顺带完成归属校验。接收前端标题意味着可以伪造。
 */
export class ShareNoteDto {
  @IsString()
  @IsNotEmpty()
  noteId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: '请至少选择一位好友' })
  @ArrayMaxSize(50, { message: '一次最多分享给 50 位好友' })
  @IsString({ each: true })
  toFriendIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200, { message: '附言最多 200 字' })
  comment?: string;
}
```

### 4.4 `src/chat/friends.service.ts`

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { USER_SHAPE, displayNameOf, handleOf, toFriend } from './chat.mapper';
import type { FriendDto, Presence } from './types/chat-events';

/** 在线状态的 Redis key 与 TTL（秒）。TTL 兼作心跳超时的兜底 */
const ONLINE_KEY = (userId: string) => `chat:online:${userId}`;
const SEARCH_LIMIT = 20;

type UserRow = {
  id: string;
  email: string;
  nickname: string | null;
  handle: string | null;
  bio: string | null;
};

@Injectable()
export class FriendsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /* ------------------------------ 在线状态 ------------------------------ */

  /**
   * 在线状态来自 Redis。阶段五的网关在连接时写入、断开时删除。
   * 网关还没上时这里永远返回 offline —— 前端离线不画任何标记，不会显示异常。
   */
  private async presenceOf(userId: string): Promise<Presence> {
    const online = await this.redis.getClient().exists(ONLINE_KEY(userId));
    return online === 1 ? 'online' : 'offline';
  }

  private async presenceOfMany(ids: string[]): Promise<Map<string, Presence>> {
    if (ids.length === 0) return new Map();
    const client = this.redis.getClient();
    // 一次 pipeline 拿完，避免 N 次往返
    const results = await client
      .pipeline(ids.map((id) => ['exists', ONLINE_KEY(id)]))
      .exec();
    const map = new Map<string, Presence>();
    ids.forEach((id, index) => {
      const value = results?.[index]?.[1];
      map.set(id, value === 1 ? 'online' : 'offline');
    });
    return map;
  }

  /* ------------------------------ 好友 ------------------------------ */

  /** 我的好友列表 */
  async list(userId: string): Promise<FriendDto[]> {
    const rows = await this.prisma.chatFriendship.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { alias: true, friend: { select: USER_SHAPE } },
    });
    if (rows.length === 0) return [];

    const presence = await this.presenceOfMany(rows.map((r) => r.friend.id));
    return rows.map((r) =>
      toFriend(r.friend as UserRow, {
        isFriend: true,
        presence: presence.get(r.friend.id) ?? 'offline',
        alias: r.alias,
      }),
    );
  }

  /**
   * 搜索用户（按 handle / 昵称 / 邮箱）。
   *
   * 空关键词返回空数组 —— **不要返回全量用户**，
   * 那等于把用户目录公开出去了。
   */
  async search(userId: string, keyword: string): Promise<FriendDto[]> {
    const q = keyword.trim();
    if (!q) return [];

    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        id: { not: userId },
        OR: [
          { handle: { contains: q, mode: 'insensitive' } },
          { nickname: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      take: SEARCH_LIMIT,
      orderBy: { createdAt: 'desc' },
      select: USER_SHAPE,
    });
    if (users.length === 0) return [];

    const [friendRows, presence] = await Promise.all([
      this.prisma.chatFriendship.findMany({
        where: { userId, friendId: { in: users.map((u) => u.id) } },
        select: { friendId: true },
      }),
      this.presenceOfMany(users.map((u) => u.id)),
    ]);
    const friendIds = new Set(friendRows.map((r) => r.friendId));

    return users.map((u) =>
      toFriend(u as UserRow, {
        isFriend: friendIds.has(u.id),
        presence: presence.get(u.id) ?? 'offline',
      }),
    );
  }

  /**
   * 加好友。
   *
   * **双向写两条**（A→B 与 B→A）：单向的话，A 加了 B 之后 B 的列表里
   * 没有 A，收到消息时找不到会话入口。表结构仍是「每人一行」，
   * 只是加好友这个动作写两行 —— 这也是主流 IM 的做法。
   * 想改成单向申请制的话，去掉第二条 upsert 即可。
   *
   * 幂等：已加过返回既有关系，**不报 409**。
   * 前端「添加」按钮点两次是很常见的（网络慢、用户不确定点中没有），
   * 报错只会让人以为失败。
   */
  async add(userId: string, friendId: string): Promise<FriendDto> {
    if (!friendId) throw new BadRequestException('缺少 userId');
    if (friendId === userId) {
      throw new BadRequestException('不能添加自己为好友');
    }

    const target = await this.prisma.user.findFirst({
      where: { id: friendId, deletedAt: null },
      select: USER_SHAPE,
    });
    if (!target) throw new NotFoundException('用户不存在');

    await this.prisma.$transaction([
      this.prisma.chatFriendship.upsert({
        where: { userId_friendId: { userId, friendId } },
        create: { userId, friendId },
        update: {},
      }),
      this.prisma.chatFriendship.upsert({
        where: { userId_friendId: { userId: friendId, friendId: userId } },
        create: { userId: friendId, friendId: userId },
        update: {},
      }),
    ]);

    return toFriend(target as UserRow, {
      isFriend: true,
      presence: await this.presenceOf(userId === friendId ? userId : friendId),
    });
  }

  /** 删好友：两个方向一起删，否则对方列表里还留着我 */
  async remove(userId: string, friendId: string) {
    await this.prisma.chatFriendship.deleteMany({
      where: {
        OR: [
          { userId, friendId },
          { userId: friendId, friendId: userId },
        ],
      },
    });
    return { deleted: true };
  }

  /**
   * 断言两人是好友，供群聊建群时校验。
   *
   * 不校验的话可以把任意 userId 塞进群成员里 ——
   * 等于拿到了一个「给陌生人发消息」的通道。
   */
  async assertFriends(userId: string, friendIds: string[]): Promise<void> {
    if (friendIds.length === 0) return;
    const count = await this.prisma.chatFriendship.count({
      where: { userId, friendId: { in: friendIds } },
    });
    if (count !== friendIds.length) {
      throw new BadRequestException('只能邀请好友，部分成员不在你的好友列表中');
    }
  }

  /** 昵称/邮箱前缀，给网关推事件时用 */
  async nameOf(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, nickname: true },
    });
    return user ? displayNameOf(user) : '某位用户';
  }

  /** 供网关写在线状态 */
  static onlineKey = ONLINE_KEY;
  /** 供其它服务做 handle 展示 */
  static handle = handleOf;
}
```

### 4.5 `src/chat/conversations.service.ts`

```ts
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CONVERSATION_SHAPE, toConversation } from './chat.mapper';
import { FriendsService } from './friends.service';
import type { ConversationDto } from './types/chat-events';
import type { CreateConversationDto, UpdateConversationDto } from './dto/conversation.dto';

/** 单聊去重键：两个 id 排序后连接，与传入顺序无关 */
function directKeyOf(a: string, b: string): string {
  return [a, b].sort().join(':');
}

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly friends: FriendsService,
  ) {}

  /* ------------------------------ 鉴权 ------------------------------ */

  /**
   * 必须是会话成员，否则 404。
   *
   * 用 404 而不是 403：403 会告诉调用方「这个会话存在但你不在里面」，
   * 可以被用来枚举他人会话 id。这与 ai 模块的 assertOwned 是同一策略 ——
   * 「不存在」与「无权访问」返回同一文案。
   */
  async assertMember(userId: string, conversationId: string) {
    const member = await this.prisma.chatConversationMember.findFirst({
      where: { conversationId, userId, leftAt: null },
      select: { id: true, pinned: true, muted: true, unread: true },
    });
    if (!member) throw new NotFoundException('会话不存在或无权访问');
    return member;
  }

  /** 会话内仍在群的成员 id，供网关决定推给谁 */
  async memberIds(conversationId: string): Promise<string[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { conversationId, leftAt: null },
      select: { userId: true },
    });
    return rows.map((r) => r.userId);
  }

  /** 我参与的会话 id，网关连接时用它一次性 join 全部房间 */
  async myConversationIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { userId, leftAt: null },
      select: { conversationId: true },
    });
    return rows.map((r) => r.conversationId);
  }

  /* ------------------------------ 查询 ------------------------------ */

  /** 单个会话（带当前用户自己的置顶/未读等状态） */
  async getOne(userId: string, conversationId: string): Promise<ConversationDto> {
    const member = await this.assertMember(userId, conversationId);
    const row = await this.prisma.chatConversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_SHAPE,
    });
    if (!row) throw new NotFoundException('会话不存在或无权访问');
    return toConversation(row, member);
  }

  /**
   * 我的会话列表。
   *
   * 排序：置顶优先，其次按最后一条消息的时间（没有消息就用会话的 updatedAt）。
   * **由后端排序**，前端只做展示性重排 —— 前端排序会在分页接入后露出破绽。
   */
  async list(userId: string): Promise<ConversationDto[]> {
    const rows = await this.prisma.chatConversationMember.findMany({
      where: { userId, leftAt: null },
      select: {
        pinned: true,
        muted: true,
        unread: true,
        conversation: { select: CONVERSATION_SHAPE },
      },
    });

    return rows
      .map((r) => toConversation(r.conversation, r))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned);
        return lastActivityAt(b) - lastActivityAt(a);
      });
  }

  /* ------------------------------ 写入 ------------------------------ */

  /** 按 kind 分流。跨字段校验放在这里（DTO 表达不了） */
  async create(userId: string, dto: CreateConversationDto): Promise<ConversationDto> {
    if (dto.kind === 'direct') {
      if (!dto.friendId) {
        throw new BadRequestException('单聊需要提供 friendId');
      }
      return this.createDirect(userId, dto.friendId);
    }

    if (!dto.memberIds || dto.memberIds.length === 0) {
      throw new BadRequestException('群聊至少要有一位成员');
    }
    return this.createGroup(userId, dto.title ?? '', dto.memberIds);
  }

  /**
   * 单聊：**必须复用**已有会话。
   *
   * 不复用的话，用户多点几次「发消息」就会和同一个人建出多条单聊，
   * 列表里出现一堆重复。去重靠 directKey 唯一索引，而不是查一遍再建 ——
   * 「查-建」中间有并发窗口，两个人同时点会建出两条。
   */
  async createDirect(userId: string, friendId: string): Promise<ConversationDto> {
    if (friendId === userId) {
      throw new BadRequestException('不能和自己创建会话');
    }
    await this.friends.assertFriends(userId, [friendId]);

    const directKey = directKeyOf(userId, friendId);
    const existing = await this.prisma.chatConversation.findUnique({
      where: { directKey },
      select: { id: true },
    });

    if (existing) {
      /*
       * 复用分支要做两件事：
       * 1. upsert 成员行 —— 用户可能此前退过群，leftAt 非空会看不到会话
       * 2. 未读清零 —— 主动点开联系人等同于读了
       */
      await this.prisma.chatConversationMember.upsert({
        where: {
          conversationId_userId: { conversationId: existing.id, userId },
        },
        create: { conversationId: existing.id, userId },
        update: { leftAt: null, unread: 0, lastReadAt: new Date() },
      });
      return this.getOne(userId, existing.id);
    }

    const created = await this.prisma.chatConversation.create({
      data: {
        kind: 'DIRECT',
        directKey,
        members: { create: [{ userId }, { userId: friendId }] },
      },
      select: { id: true },
    });
    return this.getOne(userId, created.id);
  }

  /** 建群。memberIds 不需要包含自己，这里负责加进去 */
  async createGroup(
    userId: string,
    title: string,
    memberIds: string[],
  ): Promise<ConversationDto> {
    // 去重并排除自己 —— 前端可能把自己的 id 也勾上
    const ids = [...new Set(memberIds)].filter((id) => id !== userId);
    if (ids.length === 0) {
      throw new BadRequestException('群聊至少要有一位成员');
    }
    if (ids.length > 100) {
      throw new BadRequestException('群成员最多 100 人');
    }
    // 只允许拉好友进群，否则可以把陌生人拖进来给他发消息
    await this.friends.assertFriends(userId, ids);

    const created = await this.prisma.chatConversation.create({
      data: {
        kind: 'GROUP',
        title: title.trim() || '未命名群聊',
        ownerId: userId,
        members: {
          create: [userId, ...ids].map((id) => ({ userId: id })),
        },
      },
      select: { id: true },
    });
    return this.getOne(userId, created.id);
  }

  /**
   * 置顶 / 免打扰。
   *
   * **只改当前用户自己那一行** ChatConversationMember。
   * 改会话行的话，一个人置顶会让全群的人都置顶。
   */
  async updateFlags(
    userId: string,
    conversationId: string,
    dto: UpdateConversationDto,
  ): Promise<ConversationDto> {
    await this.assertMember(userId, conversationId);

    const data: { pinned?: boolean; muted?: boolean } = {};
    if (dto.pinned !== undefined) data.pinned = dto.pinned;
    if (dto.muted !== undefined) data.muted = dto.muted;

    if (Object.keys(data).length > 0) {
      await this.prisma.chatConversationMember.update({
        where: { conversationId_userId: { conversationId, userId } },
        data,
      });
    }
    return this.getOne(userId, conversationId);
  }

  /**
   * 标记已读：未读清零 + 把别人发给我的消息置为 READ。
   *
   * 返回成员 id，让调用方（controller）决定是否推事件 ——
   * service 不直接依赖网关，避免 service 与 gateway 互相循环依赖。
   */
  async markRead(userId: string, conversationId: string): Promise<string[]> {
    await this.assertMember(userId, conversationId);

    await this.prisma.$transaction([
      this.prisma.chatConversationMember.update({
        where: { conversationId_userId: { conversationId, userId } },
        data: { unread: 0, lastReadAt: new Date() },
      }),
      this.prisma.chatMessage.updateMany({
        where: { conversationId, senderId: { not: userId }, status: 'SENT' },
        data: { status: 'READ' },
      }),
    ]);

    return this.memberIds(conversationId);
  }
}

/** 列表排序用的活跃时间：优先最后一条消息，其次会话本身 */
function lastActivityAt(c: ConversationDto): number {
  const iso = c.lastMessage?.createdAt ?? c.updatedAt;
  return new Date(iso).getTime();
}
```

### 4.6 `src/chat/messages.service.ts`

```ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';
import { MESSAGE_SHAPE, toMessage } from './chat.mapper';
import { NotesService } from '../notes/notes.service';
import type { MessageDto } from './types/chat-events';
import type { SendMessageDto } from './dto/message.dto';

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly notes: NotesService,
  ) {}

  /**
   * 历史消息，**时间正序**返回（时间线是自上而下渲染的）。
   *
   * 游标分页而不是 offset：实时聊天里消息是不断插入的，
   * offset 分页会让「翻页时看到重复消息」或「漏掉一条」。
   * 游标用 messageId，比传时间戳更稳（同毫秒内的多条不会错位）。
   */
  async list(
    userId: string,
    conversationId: string,
    before?: string,
    limit?: number,
  ): Promise<MessageDto[]> {
    await this.conversations.assertMember(userId, conversationId);

    const take = clampPageSize(limit);
    const rows = await this.prisma.chatMessage.findMany({
      where: { conversationId },
      // 先按倒序取最新的若干条
      orderBy: { createdAt: 'desc' },
      take,
      // cursor + skip:1 = 从这条之后开始取（不含这条本身）
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      select: MESSAGE_SHAPE,
    });

    // 再翻回正序
    return rows.reverse().map(toMessage);
  }

  /**
   * 发消息。
   *
   * 三件事必须在一个事务里：写消息、推会话活跃时间、给其他人累加未读。
   * 分开做的话，中间失败会留下「消息存在但未读没加」这种静默不一致。
   */
  async send(
    userId: string,
    conversationId: string,
    dto: SendMessageDto,
  ): Promise<MessageDto> {
    await this.conversations.assertMember(userId, conversationId);

    const text = dto.text?.trim() || null;
    if (!text && !dto.attachmentId && !dto.noteId) {
      throw new BadRequestException('消息内容不能为空');
    }

    /*
     * 纯文本走这里。附件与笔记各有一条独立的建消息路径，
     * 因为它们的 kind 与快照字段来源不同。
     */
    if (dto.noteId) {
      return this.createNoteMessage(userId, conversationId, dto.noteId, text);
    }
    if (dto.attachmentId) {
      return this.createAttachmentMessage(
        userId,
        conversationId,
        dto.attachmentId,
        text,
      );
    }

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: 'TEXT',
      text,
    });
    return toMessage(created);
  }

  /* ------------------------------ 三种消息写入 ------------------------------ */

  /**
   * 文本消息 + 会话活跃时间 + 未读累加（一个事务）。
   *
   * unread 的累加对象排除了发送者自己 —— 给自己加未读会让列表上
   * 出现一个自己发完消息就冒出来的红点。
   */
  private async insertMessage(data: {
    conversationId: string;
    senderId: string;
    kind: 'TEXT' | 'IMAGE' | 'FILE' | 'NOTE';
    text: string | null;
    noteSnapshot?: {
      noteId: string;
      title: string;
      kind: 'note' | 'folder';
      childCount: number;
    };
    attachmentId?: string;
  }) {
    const [created] = await this.prisma.$transaction([
      this.prisma.chatMessage.create({
        data: {
          conversationId: data.conversationId,
          senderId: data.senderId,
          kind: data.kind,
          text: data.text,
          ...(data.noteSnapshot
            ? {
                noteId: data.noteSnapshot.noteId,
                noteTitle: data.noteSnapshot.title,
                noteKind: data.noteSnapshot.kind,
                noteChildCount: data.noteSnapshot.childCount,
              }
            : {}),
          ...(data.attachmentId
            ? { attachment: { connect: { id: data.attachmentId } } }
            : {}),
        },
        select: MESSAGE_SHAPE,
      }),
      // updatedAt 是 @updatedAt，这里显式写一次把会话顶到列表最前
      this.prisma.chatConversation.update({
        where: { id: data.conversationId },
        data: { updatedAt: new Date() },
      }),
      this.prisma.chatConversationMember.updateMany({
        where: {
          conversationId: data.conversationId,
          userId: { not: data.senderId },
          leftAt: null,
        },
        data: { unread: { increment: 1 } },
      }),
    ]);

    return created;
  }

  /**
   * 附件消息。
   *
   * 归属校验不能省：附件上传后拿到的 id 是字符串，若不校验，
   * 调用方可以把别人的附件 id 塞进来，等于「转发」了他人文件。
   *
   * 用 403（而不是 404）是因为「附件不存在」与「附件不属于你」
   * 对上传者本人来说都是同一件事，前端文案一致即可。
   */
  private async createAttachmentMessage(
    userId: string,
    conversationId: string,
    attachmentId: string,
    text: string | null,
  ): Promise<MessageDto> {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id: attachmentId },
      select: { id: true, uploaderId: true, mimeType: true, messageId: true },
    });
    if (!attachment || attachment.uploaderId !== userId) {
      throw new ForbiddenException('附件不存在或无权访问');
    }
    if (attachment.messageId) {
      throw new BadRequestException('该附件已经发送过了');
    }

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: attachment.mimeType.startsWith('image/') ? 'IMAGE' : 'FILE',
      text,
      attachmentId: attachment.id,
    });
    return toMessage(created);
  }

  /**
   * 笔记卡片消息。
   *
   * 标题等快照信息由服务端按 noteId 查（顺带完成归属校验），
   * **不接受前端传入** —— 否则可以伪造标题把别人的笔记发出去。
   *
   * 公开（非 private）是因为分享接口要复用：一条 note 消息的写入规则
   * 只应有一处，两条路径各写一遍迟早不一致。
   */
  async createNoteMessage(
    userId: string,
    conversationId: string,
    noteId: string,
    comment: string | null,
  ): Promise<MessageDto> {
    // 归属校验 + 取快照。get() 内部就是 assertOwned，不归属会抛 404
    const note = await this.notes.get(userId, noteId);

    const created = await this.insertMessage({
      conversationId,
      senderId: userId,
      kind: 'NOTE',
      text: comment,
      noteSnapshot: {
        noteId: note.id,
        title: note.title || '无标题',
        // 有子页面就当作目录分享，卡片上显示「含 N 个子页面」
        kind: note.children.length > 0 ? 'folder' : 'note',
        childCount: note.children.length,
      },
    });
    return toMessage(created);
  }

  /* ------------------------------ 已读回执 ------------------------------ */

  /** 供网关在收到客户端 read 事件时调用 */
  async markOthersRead(userId: string, conversationId: string) {
    return this.conversations.markRead(userId, conversationId);
  }
}

function clampPageSize(limit?: number): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}
```

> **为什么 `createNoteMessage` 要 public 而不是把分享逻辑塞在这里**：
> 分享是「对每个好友建/复用单聊，再写一条 note 消息」的循环，属于编排。
> 写消息的规则留在这里，编排放到 `ShareService`，两者职责不混。

### 4.7 `src/chat/share.service.ts`

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { FriendsService } from './friends.service';
import type { ShareNoteResultDto } from './types/chat-events';
import type { ShareNoteDto } from './dto/share.dto';

@Injectable()
export class ShareService {
  private readonly logger = new Logger(ShareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly friends: FriendsService,
  ) {}

  /**
   * 把笔记 / 目录分享给若干好友。
   *
   * 每个好友一条单聊消息，而不是建一个群 —— 分享是「我发给你的」
   * 一次性动作，建群会把收件人互相暴露出去。
   *
   * 部分失败：**照常返回成功的那部分**，前端提示「N 位好友已收到」。
   * 一个人失败就整体回滚的话，用户得重新勾选一遍，代价更大。
   *
   * 注意笔记归属校验发生在 MessagesService.createNoteMessage 里
   * （它会调 NotesService.get → assertOwned）。放在这之前更好，
   * 可以少循环几次，但放在里面能保证「凡是写 note 消息的路径都校验过」。
   */
  async share(userId: string, dto: ShareNoteDto): Promise<ShareNoteResultDto> {
    const friendIds = [...new Set(dto.toFriendIds)].filter(
      (id) => id && id !== userId,
    );
    if (friendIds.length === 0) {
      throw new BadRequestException('请至少选择一位好友');
    }
    // 只能分享给好友：否则可以给任意 userId 发消息
    await this.friends.assertFriends(userId, friendIds);

    const comment = dto.comment?.trim() || null;
    const conversationIds = new Set<string>();
    let messageCount = 0;

    for (const friendId of friendIds) {
      try {
        const conversation = await this.conversations.createDirect(
          userId,
          friendId,
        );
        await this.messages.createNoteMessage(
          userId,
          conversation.id,
          dto.noteId,
          comment,
        );
        conversationIds.add(conversation.id);
        messageCount += 1;
      } catch (err) {
        // 单个人失败不中断其余：记录后继续
        this.logger.warn(
          `分享笔记给 ${friendId} 失败：${(err as Error).message}`,
        );
      }
    }

    if (messageCount === 0) {
      // 全都失败了才报错 —— 这里把原因归到笔记上，
      // 因为最常见的失败是 noteId 不归属当前用户（404）
      throw new BadRequestException('分享失败，请确认笔记存在且属于你');
    }

    return {
      conversationCount: conversationIds.size,
      messageCount,
    };
  }

  /**
   * 分享给「我自己」。前端暂未接，留着是因为
   * 「转发到自己的收藏」是最常用的入口之一。
   */
  async selfNote(userId: string, noteId: string): Promise<string> {
    const conversation = await this.conversations.createDirect(
      userId,
      await this.selfConversationPeer(userId),
    );
    return conversation.id;
  }

  private async selfConversationPeer(userId: string): Promise<string> {
    // 需要一个「对方」才能建单聊，暂时用自己（directKey 会退化成单元素）
    void this.prisma;
    return userId;
  }
}

void ShareNoteDto;
```

> ⚠️ `selfNote` / `selfConversationPeer` 这段是**示意性的，不要照抄** ——
> 单聊要求两个不同成员，用自己当对方会在 `directKey` 与成员唯一约束上出问题。
> 「收藏」应该是一张独立的会话（`kind: GROUP` + 单人，或加一个 `SELF` 类型）。
> 我把它留在文档里是为了标记「这个场景需要单独设计」，落地时**删掉这两个方法**。

### 4.8 `src/chat/chat-attachments.service.ts`

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../common/storage/storage.service';
import { assertUploadable, decodeFilename, type UploadedFileLike } from '../common/upload/file-guard';
import { toAttachment } from './chat.mapper';
import type { AttachmentDto } from './types/chat-events';

/**
 * 聊天附件上限（字节）。默认 50MB，与前端 CHAT_FILE_MAX_BYTES 对齐。
 *
 * 比笔记的 20MB 大：聊天里发视频/压缩包是常见需求，
 * 而笔记附件基本是 PDF 与图片。
 */
const MAX_BYTES = Number(
  process.env.CHAT_UPLOAD_MAX_BYTES ?? 50 * 1024 * 1024,
);

@Injectable()
export class ChatAttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * 上传：校验 → 落盘 → 写元数据。
   *
   * 此时还没有 messageId（NULL），属于「待发送」状态。
   * 用户传了文件却关掉页面会留下孤儿附件，靠 §7 阶段二的清理任务回收。
   *
   * 用内存存储（控制器里的 FileInterceptor 不写磁盘），
   * 先过白名单与体积校验再落盘，避免非法文件先写进磁盘。
   */
  async upload(
    userId: string,
    file: UploadedFileLike | undefined,
  ): Promise<AttachmentDto> {
    if (!file) throw new BadRequestException('未收到文件');

    // 白名单与体积：真正的安全边界在这里，前端按扩展名判断拦不住任何人
    assertUploadable(file, MAX_BYTES);

    // 只解一次：写库与落盘用同一个名字，两次调用会各自算一遍（浪费且有分歧风险）
    const filename = decodeFilename(file.originalname);
    const storageKey = await this.storage.save(file.buffer, filename);

    const row = await this.prisma.chatAttachment.create({
      data: {
        uploaderId: userId,
        filename,
        storageKey,
        mimeType: file.mimetype,
        size: file.size,
      },
      select: { id: true, filename: true, mimeType: true, size: true },
    });

    return toAttachment(row);
  }

  /**
   * 读取附件内容。
   *
   * 两条准入路径：
   * 1. 已挂到某条消息上 → 必须是该消息所属会话的成员
   * 2. 还没挂（上传未发送）→ 只有上传者本人
   *
   * 不校验的话，附件 id 泄露就等于文件泄露（id 是 cuid，不易猜，
   * 但会话里任何人都能看到别人发的附件 id）。
   */
  async readContent(userId: string, attachmentId: string) {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        id: true,
        filename: true,
        mimeType: true,
        storageKey: true,
        uploaderId: true,
        messageId: true,
      },
    });
    if (!attachment) throw new NotFoundException('附件不存在或无权访问');

    if (attachment.messageId) {
      const member = await this.prisma.chatConversationMember.findFirst({
        where: {
          userId,
          leftAt: null,
          conversation: { messages: { some: { id: attachment.messageId } } },
        },
        select: { id: true },
      });
      if (!member) throw new NotFoundException('附件不存在或无权访问');
    } else if (attachment.uploaderId !== userId) {
      throw new NotFoundException('附件不存在或无权访问');
    }

    return {
      attachment,
      buffer: await this.storage.read(attachment.storageKey),
    };
  }

  /** 供 controller 在删除消息时调用（预留） */
  async remove(userId: string, attachmentId: string) {
    const attachment = await this.prisma.chatAttachment.findFirst({
      where: { id: attachmentId, uploaderId: userId },
      select: { id: true, storageKey: true, messageId: true },
    });
    if (!attachment) throw new NotFoundException('附件不存在或无权访问');
    if (attachment.messageId) {
      throw new BadRequestException('附件已发送，不能单独删除');
    }

    await this.prisma.chatAttachment.delete({ where: { id: attachment.id } });
    await this.storage.remove(attachment.storageKey);
    return { deleted: true };
  }
}
```

### 4.9 `src/chat/chat.controller.ts`

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { SkipResponse } from '../common/decorators/skip-response.decorator';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { UploadedFileLike } from '../common/upload/file-guard';
import { FriendsService } from './friends.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ShareService } from './share.service';
import { ChatGateway } from './chat.gateway';
import { AddFriendDto } from './dto/friend.dto';
import {
  CreateConversationDto,
  UpdateConversationDto,
} from './dto/conversation.dto';
import { SendMessageDto } from './dto/message.dto';
import { ShareNoteDto } from './dto/share.dto';

/** 发消息与上传附件共用的限流参数 */
const SEND_SCOPE = 'chat-send';
const SEND_MAX_PER_MINUTE = 30;
const UPLOAD_SCOPE = 'chat-upload';
const UPLOAD_MAX_PER_MINUTE = 20;

/**
 * 聊天接口。
 *
 * 路径前缀 `/chat`（**不加全局前缀**，与 `/ai`、`/notes` 一致）。
 * 全部接口挂 JwtAuthGuard，userId 一律从令牌取 —— 不接受客户端传入，
 * 否则任何人都能冒充他人发消息。
 *
 * 无全局前缀这一点要注意：`main.ts` 里没有 setGlobalPrefix，
 * 所以前端拼的是 `${VITE_BASE_API}/chat/...`。
 */
@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(
    private readonly friends: FriendsService,
    private readonly conversations: ConversationsService,
    private readonly messages: MessagesService,
    private readonly attachments: ChatAttachmentsService,
    private readonly share: ShareService,
    private readonly rateLimit: RateLimitService,
    private readonly gateway: ChatGateway,
  ) {}

  /* ------------------------------ 好友 ------------------------------ */

  /** 我的好友列表 */
  @Get('friends')
  listFriends(@CurrentUser() userId: string) {
    return this.friends.list(userId);
  }

  /** 搜索用户。空关键词返回空数组，不返回全量用户 */
  @Get('users')
  searchUsers(@CurrentUser() userId: string, @Query('keyword') keyword?: string) {
    return this.friends.search(userId, keyword ?? '');
  }

  /** 加好友。幂等：已加过返回既有关系 */
  @Post('friends')
  addFriend(@CurrentUser() userId: string, @Body() dto: AddFriendDto) {
    return this.friends.add(userId, dto.userId);
  }

  @Delete('friends/:userId')
  removeFriend(@CurrentUser() userId: string, @Param('userId') friendId: string) {
    return this.friends.remove(userId, friendId);
  }

  /* ------------------------------ 会话 ------------------------------ */

  @Get('conversations')
  listConversations(@CurrentUser() userId: string) {
    return this.conversations.list(userId);
  }

  /** 单聊 / 建群，按 body 里的 kind 分流 */
  @Post('conversations')
  createConversation(
    @CurrentUser() userId: string,
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversations.create(userId, dto);
  }

  /** 置顶 / 免打扰。只改当前用户自己那一行成员记录 */
  @Patch('conversations/:id')
  updateConversation(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
  ) {
    return this.conversations.updateFlags(userId, id, dto);
  }

  /**
   * 标记已读。
   *
   * 除了改库，还要给会话内其他人推 read 事件 —— 否则对方看不到
   * 「已读」双勾变成实心。推送由 controller 发起而不是 service：
   * service 注入 gateway 会形成 service ↔ gateway 循环依赖。
   */
  @Post('conversations/:id/read')
  async markRead(@CurrentUser() userId: string, @Param('id') id: string) {
    const memberIds = await this.conversations.markRead(userId, id);
    this.gateway.pushToMembers(memberIds, userId, {
      type: 'read',
      conversationId: id,
      userId,
    });
    return { read: true };
  }

  /* ------------------------------ 消息 ------------------------------ */

  /** 历史消息，时间正序。游标分页：?before=<messageId>&limit=30 */
  @Get('conversations/:id/messages')
  listMessages(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Query('before') before?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messages.list(
      userId,
      id,
      before,
      limit ? Number(limit) : undefined,
    );
  }

  /**
   * 发消息。body 三者至少一个：text / attachmentId / noteId。
   *
   * 发成功后推送给会话成员（含发送者自己 —— 前端已按 id 去重，
   * 服务端统一推一次可以让多端登录的其它设备也即时看到）。
   */
  @Post('conversations/:id/messages')
  async sendMessage(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ) {
    await this.assertRateLimit(userId, SEND_SCOPE, SEND_MAX_PER_MINUTE);

    const message = await this.messages.send(userId, id, dto);
    const memberIds = await this.conversations.memberIds(id);
    this.gateway.pushToMembers(memberIds, null, { type: 'message', message });

    return message;
  }

  /**
   * 分享笔记给好友。
   *
   * 请求体只有 noteId / toFriendIds / comment —— 标题由后端自己查，
   * 见 ShareNoteDto 的注释。
   */
  @Post('notes/share')
  shareNote(@CurrentUser() userId: string, @Body() dto: ShareNoteDto) {
    return this.share.share(userId, dto);
  }

  /* ------------------------------ 附件 ------------------------------ */

  /**
   * 上传附件，先拿 id 再发消息。
   *
   * 字段名固定 `file`。用内存存储（不写磁盘），
   * 白名单与体积校验在 service 里。
   * limits.fileSize 只是第一道闸，真正给用户看的报错来自 assertUploadable。
   */
  @Post('attachments')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 50 * 1024 * 1024 } }),
  )
  async uploadAttachment(
    @CurrentUser() userId: string,
    @UploadedFile() file: UploadedFileLike | undefined,
  ) {
    await this.assertRateLimit(userId, UPLOAD_SCOPE, UPLOAD_MAX_PER_MINUTE);
    return this.attachments.upload(userId, file);
  }

  /**
   * 读取附件内容（预览与下载共用）。
   *
   * 必须 @SkipResponse()：全局拦截器会把响应包成 {code,msg,data}，
   * 二进制内容会被破坏。
   *
   * 前端不能直接把这个地址塞给 <img src> —— 接口需要 Authorization 头，
   * 而 img/iframe 带不上自定义头。前端要先 fetch 成 Blob 再转 objectURL
   * （笔记模块的 fetchAttachmentBlob 就是这么做的，可直接照搬）。
   */
  @Get('attachments/:id/content')
  @SkipResponse()
  async attachmentContent(
    @CurrentUser() userId: string,
    @Param('id') id: string,
    @Res() res: Response,
    @Query('download') download?: string,
  ) {
    const { attachment, buffer } = await this.attachments.readContent(userId, id);

    // 文件名含中文时需用 RFC 5987 编码，否则部分浏览器会乱码
    const encoded = encodeURIComponent(attachment.filename);
    res.setHeader('Content-Type', attachment.mimeType);
    res.setHeader('Content-Length', buffer.length);
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encoded}`,
    );
    res.end(buffer);
  }

  /* ------------------------------ 内部 ------------------------------ */

  /**
   * 超限抛 429。前端按 429 提示「发送过于频繁」。
   *
   * 阈值比 AI 模块宽松（30 vs 10）：聊天是高频动作，
   * 按 AI 那个阈值正常聊天都会被拦。
   */
  private async assertRateLimit(
    userId: string,
    scope: string,
    max: number,
  ): Promise<void> {
    const result = await this.rateLimit.check(userId, { scope, max });
    if (!result.allowed) {
      throw new HttpException(
        `操作过于频繁，请 ${result.resetSeconds} 秒后再试`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
```

### 4.10 `src/chat/chat.module.ts`

```ts
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { FriendsService } from './friends.service';
import { ConversationsService } from './conversations.service';
import { MessagesService } from './messages.service';
import { ChatAttachmentsService } from './chat-attachments.service';
import { ShareService } from './share.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotesModule } from '../notes/notes.module';

/**
 * 聊天模块。
 *
 * PrismaModule / RedisModule / StorageModule / RateLimitModule 都是 @Global()，
 * 不需要在这里 imports。
 *
 * 需要 NotesModule 的原因只有一个：分享笔记时要调 NotesService.get()
 * 做归属校验并取标题快照。这是刻意的 —— 直接查 Note 表会让
 * 「笔记不存在或已删除」这类规则出现第二份实现。
 */
@Module({
  imports: [
    // JwtAuthGuard 依赖 JwtService 验签（非全局 Guard，逐控制器挂载）
    JwtModule.register({}),
    NotesModule,
  ],
  controllers: [ChatController],
  providers: [
    FriendsService,
    ConversationsService,
    MessagesService,
    ChatAttachmentsService,
    ShareService,
    JwtAuthGuard,
    ChatGateway,
  ],
  // 会话与消息的鉴权方法要给出去了：其它模块（例如未来在 AI 里加
  // 「读我的聊天记录」工具）会需要 assertMember
  exports: [ConversationsService, MessagesService],
})
export class ChatModule {}
```

> 若暂不上阶段五（WebSocket），把 `ChatGateway` 从 `providers` 里去掉，
> 同时把 `chat.controller.ts` 里 `gateway` 的注入与 3 处调用删掉
> （构造函数、`markRead`、`sendMessage`）。
> 为了减少这种来回，建议 `chat.gateway.ts` 先建一个**不发包的空壳**
> （见 §5.4），阶段一~四就能直接接上。

### 4.11 既有文件的改动

#### 4.11.1 `src/app.module.ts`

```diff
  import { NotesModule } from './notes/notes.module';
+ import { ChatModule } from './chat/chat.module';
+ import { StorageModule } from './common/storage/storage.module';
+ import { RateLimitModule } from './common/rate-limit/rate-limit.module';

  @Module({
    imports: [
      AuthModule,
      UserModule,
      RedisModule,
      VerificationCodeModule,
      MailModule,
      AiModule,
      NotesModule,
+     ChatModule,
      // @Global() 模块也要在根模块挂一次
+     StorageModule,
+     RateLimitModule,
    ],
```

> ⚠️ **不要**把 `ChatModule` 里的 provider 往 `AppModule` 的 `exports` 里加。
> 之前 AI 笔记工具那次就把 `NotesService` 加到了 `AppModule` 的 `exports`，
> Nest 启动直接报错 —— `exports` 只能导出当前模块 `providers` 里有的东西。

#### 4.11.2 `src/notes/attachments.service.ts`

按 §2.2 改 import 来源，删掉文件内的 `decodeFilename` / `ALLOWED_MIME` / `UploadedFileLike` 定义。

#### 4.11.3 （可选）启用全局校验

`src/main.ts`：

```diff
+ import { ValidationPipe } from '@nestjs/common';

  async function bootstrap() {
    const app = await NestFactory.create<NestExpressApplication>(AppModule);
+
+   /*
+    * 启用 DTO 校验。
+    *
+    * 在这之前，所有 DTO 上的 class-validator 装饰器都只是文档 ——
+    * 项目里从未注册过 ValidationPipe。
+    *
+    * 这是行为变更：原本能过的请求（例如 title 传数字）从此会被 400 拒掉。
+    * 建议单独一个提交，并跑一遍 auth / notes / ai 的回归脚本。
+    */
+   app.useGlobalPipes(
+     new ValidationPipe({
+       whitelist: true,            // 丢掉 DTO 未声明的字段
+       transform: true,            // @Type 转换才会生效（query 里的数字）
+       forbidNonWhitelisted: false, // 先别开，否则老前端多传字段会直接 400
+     }),
+   );
```

---

## 5. 阶段五：实时推送

### 5.1 依赖安装（注意 pnpm 的坑）

```bash
cd D:/项目/wisora-web/backend

# 先确认版本能对上 Nest 11
"C:/Users/揭/.workbuddy/binaries/node/versions/22.22.2-2/npm.cmd" pack @nestjs/websockets @nestjs/platform-socket.io socket.io
```

⚠️ **不要直接 `pnpm add`** —— 这个项目历史上被沙箱 safe-delete 拦过，且**会先删掉顶层目录**（曾导致 `Cannot find module 'sonner'`）。稳妥流程与当时装 gsap 一致：

```bash
# 1) 解包
mkdir -p /tmp/ws && cd /tmp/ws
tar -xzf <下载的 tgz> -C ex-websockets --one-top-level  ...

# 2) 拷贝进 node_modules（三个包各自独立目录，别放同一个）
cp -r ex-*/package "D:/项目/wisora-web/backend/node_modules/@nestjs/websockets"
cp -r ex-*/package "D:/项目/wisora-web/backend/node_modules/@nestjs/platform-socket.io"
cp -r ex-*/package "D:/项目/wisora-web/backend/node_modules/socket.io"

# 3) 在 package.json 声明，保证换机器时 pnpm install 能正确还原
#    "@nestjs/websockets": "^11.0.1",
#    "@nestjs/platform-socket.io": "^11.0.1",
#    "socket.io": "^4.8.1"
```

**替代方案（零新依赖，推荐先走这条）**：用 SSE，复用 ai 模块已经建好的一次性 ticket 机制。

| | WebSocket | SSE |
| --- | --- | --- |
| 新增依赖 | 3 个 | **0** |
| 双向（输入状态） | ✅ | ❌ 输入状态要另走 REST |
| 项目已有可复用件 | 无 | `ai/guards/stream-ticket.guard.ts`、`@SkipResponse()`、`ai.controller.ts` 的 `toSse` |
| 鉴权 | 握手帧带令牌 | 一次性 ticket（30s，取完即焚） |

SSE 版本只需要在 `chat.controller.ts` 里加一个长连接端点，形制照抄 `ai.controller.ts` 的 `@Sse()` + ticket 换票，前端 `subscribeChatEvents` 用 `EventSource` 接。**输入状态先不做**（Telegram 的「正在输入」体验，晚一点上不影响核心可用性）。

下面的网关按 WebSocket 写。

### 5.2 `src/chat/chat.gateway.ts`

```ts
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { RedisService } from '../redis/redis.service';
import { ConversationsService } from './conversations.service';
import type { ChatClientEvent, ChatServerEvent } from './types/chat-events';

/** 房间名：一个会话一个房间 */
const roomOf = (conversationId: string) => `conv:${conversationId}`;
/** 在线状态的 Redis key，与 FriendsService 保持一致 */
const onlineKey = (userId: string) => `chat:online:${userId}`;
/** 在线状态 TTL（秒）。断开时主动删，TTL 是进程被杀时的兜底 */
const ONLINE_TTL = 120;

interface AuthedSocket extends Socket {
  data: { userId: string };
}

/**
 * 聊天实时网关。
 *
 * 命名空间 `chat`，前端连 `ws://<host>/chat`。
 *
 * 鉴权：令牌不放 query（会进访问日志与代理记录）——
 * 与 ai 模块当初为 SSE 引入一次性 ticket 是同一个理由。
 * 这里支持两种握手方式：
 *   1. socket.io 的 auth 字段（`io(url, { auth: { token } })`）
 *   2. 连接后第一帧发 `{ type: 'auth', token }`
 */
@WebSocketGateway({
  namespace: 'chat',
  /*
   * 必须显式配 cors：main.ts 里的 app.enableCors() 只管 HTTP，
   * 不影响 WebSocket 的握手响应。
   */
  cors: { origin: true, credentials: true },
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly conversations: ConversationsService,
  ) {}

  /* ------------------------------ 连接生命周期 ------------------------------ */

  async handleConnection(client: AuthedSocket) {
    const userId = await this.authenticate(client);
    if (!userId) {
      // 认证失败立刻断开，不发任何业务事件
      client.disconnect(true);
      return;
    }
    client.data.userId = userId;

    const online = await this.redis.getClient();
    await online.set(onlineKey(userId), '1', 'EX', ONLINE_TTL);

    /*
     * 一次性 join 全部房间。
     * 每次发消息再临时 join 会有竞态：A 连上后 B 发的第一条消息可能到不了。
     */
    const conversationIds = await this.conversations.myConversationIds(userId);
    for (const id of conversationIds) {
      await client.join(roomOf(id));
    }

    // 告知所有人我上线了（前端只对好友渲染在线点，多做一次过滤也无害）
    this.server.emit('event', {
      type: 'presence',
      userId,
      presence: 'online',
    } satisfies ChatServerEvent);
  }

  async handleDisconnect(client: AuthedSocket) {
    const userId = client.data?.userId;
    if (!userId) return;

    /*
     * 同一用户可能多端在线，只有最后一个连接断开才算离线。
     * 用 room 检查：socket.io 会自动把 socket 加进以自己 id 命名的房间。
     */
    const sockets = await this.server.in(userId).fetchSockets();
    if (sockets.length > 0) return;

    await this.redis.getClient().del(onlineKey(userId));
    this.server.emit('event', {
      type: 'presence',
      userId,
      presence: 'offline',
    } satisfies ChatServerEvent);
  }

  /** 多端识别：连接时把自己 join 进以 userId 命名的房间 */
  private async authenticate(client: Socket): Promise<string | null> {
    const token =
      (client.handshake.auth?.token as string | undefined) ??
      (client.handshake.headers.authorization?.startsWith('Bearer ')
        ? client.handshake.headers.authorization.slice(7)
        : undefined);

    if (!token) return null;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
      await client.join(payload.sub);
      return payload.sub;
    } catch {
      this.logger.warn('WebSocket 握手令牌无效');
      return null;
    }
  }

  /* ------------------------------ 客户端事件 ------------------------------ */

  /** 输入中。节流交给前端，服务端只做转发 */
  @SubscribeMessage('typing')
  async onTyping(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: Extract<ChatClientEvent, { type: 'typing' }>,
  ) {
    const userId = client.data?.userId;
    if (!userId || !body?.conversationId) return;

    // 只有成员才能在这个会话里广播 —— 否则可以把状态推到别人的会话
    try {
      await this.conversations.assertMember(userId, body.conversationId);
    } catch {
      return;
    }

    client.to(roomOf(body.conversationId)).emit('event', {
      type: 'typing',
      conversationId: body.conversationId,
      userId,
      typing: body.typing === true,
    } satisfies ChatServerEvent);
  }

  /** 主动上报已读（前端目前走 REST，两条路二选一） */
  @SubscribeMessage('read')
  async onRead(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: Extract<ChatClientEvent, { type: 'read' }>,
  ) {
    const userId = client.data?.userId;
    if (!userId || !body?.conversationId) return;

    const memberIds = await this.conversations
      .markRead(userId, body.conversationId)
      .catch(() => null);
    if (!memberIds) return;

    this.pushToMembers(memberIds, userId, {
      type: 'read',
      conversationId: body.conversationId,
      userId,
    });
  }

  /* ------------------------------ 服务端推送 ------------------------------ */

  /**
   * 推给会话成员。
   *
   * @param excludeUserId 排除某个人（一般是不想把事件回推给触发者）；
   *        传 null 表示全员都推（新消息要推给发送者，让他的其它设备同步）
   */
  pushToMembers(
    memberIds: string[],
    excludeUserId: string | null,
    event: ChatServerEvent,
  ): void {
    if (!this.server) return; // 网关未就绪（例如未装依赖时的空壳）
    const targets = memberIds.filter((id) => id !== excludeUserId);
    if (targets.length === 0) return;
    // 按 userId 房间定向投递，不广播给所有人
    this.server.to(targets).emit('event', event);
  }
}
```

### 5.3 网关的三个注意点

1. **只用 `pushToMembers`，永不 `server.emit` 业务事件**（除了 presence）。广播给所有连接会把消息推给不相干的人。
2. **HTTP 与 WS 的鉴权必须同源**：都用 `JWT_ACCESS_SECRET`。两边各写一份验签逻辑是以后出 bug 的高发区。
3. **断线重连要能补齐**。前端重连后按本地最大 `messageId` 拉一次增量即可，后端用现有的 `list(..., before)` 就能支撑；如需更严格，给 `ChatMessage` 加一个按时间过滤的查询。

### 5.4 若暂不上 WS：空壳网关

为了让阶段一~四的代码不用改，先写一个「什么都不做」的网关：

```ts
import { Injectable } from '@nestjs/common';
import type { ChatServerEvent } from './types/chat-events';

/**
 * 占位网关：接口与真实网关一致，但不发包。
 * 装上 @nestjs/websockets 之后把 §5.2 的实现替换进来即可，
 * controller 里那几处调用不用动。
 */
@Injectable()
export class ChatGateway {
  pushToMembers(
    _memberIds: string[],
    _excludeUserId: string | null,
    _event: ChatServerEvent,
  ): void {
    // 无实时通道时静默丢弃：前端仍能通过 REST 拿到数据
  }
}
```

---

## 6. 前端适配层替换

### 6.1 `request/chat.ts`：13 个函数体换真实调用

只改这个文件，页面与 store 零改动。逐条对照：

| 前端函数（`request/chat.ts`） | 换成 | 备注 |
| --- | --- | --- |
| `setCurrentUser(userId)` | **删掉调用点** | 真实实现里身份来自令牌。函数体改成 `void userId;` 保留签名，等 store 稳定后再删 |
| `listFriends()` | `request.get('/chat/friends')` | |
| `searchUsers(kw)` | `request.get('/chat/users', { params: { keyword: kw } })` | |
| `addFriend(id)` | `request.post('/chat/friends', { userId: id })` | |
| `listConversations()` | `request.get('/chat/conversations')` | |
| `listMessages(cid)` | `request.get(\`/chat/conversations/${cid}/messages\`)` | 分页参数后加 |
| `createDirectConversation(fid)` | `request.post('/chat/conversations', { kind: 'direct', friendId: fid })` | |
| `createGroupConversation(p)` | `request.post('/chat/conversations', { kind: 'group', title: p.title, memberIds: p.memberIds })` | |
| `updateConversationFlags(cid, f)` | `request.patch(\`/chat/conversations/${cid}\`, f)` | |
| `markConversationRead(cid)` | `request.post(\`/chat/conversations/${cid}/read\`)` | |
| `uploadAttachment(file, onProgress)` | `request.post('/chat/attachments', formData, { onUploadProgress })` | 见下方注意 |
| `sendMessage(p)` | `request.post(\`/chat/conversations/${p.conversationId}/messages\`, body)` | **body 要拍平**，见下 |
| `shareNote(p)` | `request.post('/chat/notes/share', { noteId, toFriendIds, comment })` | **不要传 title / childCount** |
| `subscribeChatEvents(h)` | `EventSource` 或 `socket.io-client` | §5 |

**两处字段拍平（很容易漏）**：

```ts
// sendMessage：前端 payload 里是完整对象，后端只要 id
const body = {
  text: payload.text,
  attachmentId: payload.attachment?.id,
  noteId: payload.note?.noteId,
};

// shareNote：前端 ShareNotePayload 里有 title/kind/childCount，后端只收 noteId
//   payload.title / payload.kind / payload.childCount 在后端就绪后不再需要，
//   可以从 SendMessagePayload / ShareNotePayload 里删掉（但那是前端类型改动，属于阶段六清理）
```

**上传进度**：`request` 层是 axios，`onUploadProgress` 能拿到真实进度，替换掉 mock 里那个「12 步假装」的循环。注意 `Content-Type` 要让浏览器自己带 multipart 边界，**不要手写 `multipart/form-data`**。

### 6.2 ⚠️ 一处前端必须补的改动：图片预览会 401

`components/chat/MessageList.tsx:323` 目前是：

```tsx
<img src={message.attachment.previewUrl} ... />
```

mock 阶段的 `previewUrl` 是 `URL.createObjectURL(file)`，能直接渲染。**接上后端后 `previewUrl` 变成 `/chat/attachments/<id>/content`，这个接口需要 `Authorization` 头，而 `<img>` 带不上自定义头 —— 图片会 401 全挂。**

修法：照搬笔记模块现成的写法（`request/notes.ts:69`）。

```ts
// request/chat.ts 新增
export async function fetchChatAttachmentBlob(id: string): Promise<Blob> {
  const token = (await import('./storage')).getToken();
  const res = await fetch(`${BASE}/chat/attachments/${id}/content`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  if (!res.ok) throw new Error(`加载附件失败（HTTP ${res.status}）`);
  return res.blob();
}
```

然后在 `MessageList` 里给图片消息做一个「取 Blob → objectURL」的小 hook，并把 `objectUrl` 优先于 `previewUrl` 使用（`MessageList.tsx:93` 那个 `href` 已经是 `objectUrl ?? previewUrl` 的顺序了，渲染那里对齐即可）。**记得在卸载时 `URL.revokeObjectURL`** —— 笔记页的 `AttachmentPreview` 已经处理过这个，照抄即可。

这是**必做项**，不做的话文件消息能发、能下载，但聊天里所有图片都是碎的。

---

## 7. 落地顺序与每步验收

| 阶段 | 动作 | 验收 |
| --- | --- | --- |
| **0** | §2 三处 common 搬迁（或改用最小改动做法）；`pnpm run build` | 编译通过；启动后 `POST /notes` 与 `/ai` 仍正常（搬迁只动 import） |
| **1** | §3 Prisma（User 两列 + 5 模型）→ `migrate dev` → `generate` | 查库看到 5 张 `Chat*` 表；`User` 有 `handle` / `bio` |
| **2** | §4 全部文件 + §4.11.1/2 接线（**网关先用 §5.4 空壳**） | `pnpm run build` 通过；`GET /chat/friends` 带令牌返回 `[]` 而不是 500 |
| **3** | 造数据：注册两个账号 → 互加好友 → 建单聊 → 发消息 | 用 curl 或 `test-chat-module.js` 验证 |
| **4** | 前端替换 `request/chat.ts`（§6.1）+ 补图片取流（§6.2） | 页面用真实数据跑通；图片能显示 |
| **5** | 笔记右键分享 → 聊天收到卡片 | 同一脚本的 B 组 |
| **6** | 上网关（§5.2）替换空壳 | 双开两个账号，A 发 B 实时收到 |
| **7** | 删 `chat.mock.ts`；清理 `subscribeChatEvents` 的 mock 注释；回归 | 全量跑一遍 |

### 每阶段都要跑的验证脚本

**已有、可直接跑**（服务都在运行时）：

```bash
cd D:/项目/_verify
node test-chat-module.js       # 需后端：聊天端到端 + 笔记右键分享 + 深链，32 项
node test-chat-offline.js      # 不需要后端：纯前端 40 项（阶段 4 之后会开始失败，
                               #   因为它断言「0 失败请求」，那是 mock 阶段的特征）
```

**阶段 3 建议补的后端断言**（`backend/test/verify-chat.cjs`）：

1. 未带令牌 → 401
2. 加好友幂等：连点两次仍是 200，且关系只有一条（**双向两条**）
3. 单聊复用：对同一个人 `POST /chat/conversations { kind: direct }` 两次，返回同一个 id
4. 越权：用 A 的令牌往 B 的会话发消息 → **404**（不是 403）
5. 附件归属：用 A 的令牌带 B 上传的 attachmentId 发消息 → 403
6. 空消息：`{}` → 400
7. 分享：`{ noteId: 别人的笔记 }` → 400/404；分享给自己的笔记 → 成功
8. 未读：A 连发 3 条给 B，B 的 `unread` 应为 3；B 标记已读后归 0，且 A 的消息 `status` 变 `read`
9. 游标分页：发 40 条，`limit=30` 拿 30 条 + `before=<最早一条 id>` 再拿 10 条，无重复无遗漏
10. 图片消息 `previewUrl` 存在，非图片消息为 `undefined`

### 阶段 2 附注：孤儿附件清理

`ChatAttachment.messageId` 可空是为了两步上传，代价是「传了没发」会留垃圾。给 `StorageService` 加一个定时任务（或用现成的 `@nestjs/schedule`，**项目尚未安装，请勿为此单独引入** —— 先用一个在 `ChatModule.onModuleInit` 里 `setInterval` 的简易版本即可）：

```ts
// TODO: 清理 24 小时前仍未挂到消息上的附件（messageId IS NULL）
// 先删磁盘文件再删库记录 —— 反过来的话删文件失败就变成永久孤儿
```
