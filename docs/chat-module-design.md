# 聊天模块设计文档

> 交付范围：前端页面与后端接口**均已落地并实测通过**。
> 前端 40/40（离线）+ 29/29（真机）、后端 72/72，详见文末「落地记录」。

---

## 0. 一句话总览

| 项 | 状态 |
| --- | --- |
| 前端界面（会话列表 / 消息流 / 输入区 / 三个弹窗 / 响应式） | ✅ 已完成，40/40 实测通过 |
| 笔记右键菜单 + 「分享给好友」 | ✅ 已完成 |
| 后端接口与数据模型 | ✅ 已完成，72/72 实测通过 |
| 实时推送（WebSocket） | ✅ 已完成并实测（`chat` 命名空间） |
| 前端 mock 适配层 | ✅ 已删除，改走真实接口 |

> ⚠️ 本文档 §3 的模型名与最终实现有一处**必须**的差异：`Conversation` / `Message`
> 已被 AI 助手模块占用，Prisma 的模型与枚举共用一个命名空间，重名会直接报
> `Duplicate model`。实际实现统一加了 `Chat` 前缀。
> 另外 §3 里 `ChatAttachment.messageId` 写成了非空 —— 那也是错的（见文末「落地时修正的两处」）。

---

## 1. 前端已完成的部分

### 1.1 新增文件

| 文件路径 | 内容 |
| --- | --- |
| `frontend/src/types/chat.ts` | 全部类型：`Friend` / `Conversation` / `Message` / `ChatAttachment` / `SharedNotePayload` / `ChatEvent` / 请求载荷 |
| `frontend/src/lib/chat-utils.ts` | 纯函数：时间分组与格式化、字节格式化、首字母头像取色、文件类型判定、体积上限常量 |
| `frontend/src/lib/use-current-user.ts` | 拿到当前用户 id，缺资料时按令牌回查一次（首次进入 / 存储被清时的兜底） |
| `frontend/src/request/chat.mock.ts` | 内存 mock 数据 + 实时事件模拟（**后端接好后删除**） |
| `frontend/src/request/chat.ts` | **接口适配层**：唯一需要替换的文件，每个函数标注了对应后端接口 |
| `frontend/src/stores/useChatStore.ts` | 聊天状态：会话、消息分桶、草稿、未读、输入中、上传进度、事件订阅 |
| `frontend/src/components/ContextMenu.tsx` | 通用右键菜单（视口边界收缩、Esc/外部点击/滚动关闭、方向键导航） |
| `frontend/src/components/chat/PeerAvatar.tsx` | 首字母头像 + 在线状态点 |
| `frontend/src/components/chat/ConversationList.tsx` | 会话列表（搜索、未读、置顶、免打扰、骨架屏、空态、虚拟滚动） |
| `frontend/src/components/chat/ChatHeader.tsx` | 会话头部（在线状态 / 群成员、置顶与免打扰菜单） |
| `frontend/src/components/chat/MessageList.tsx` | 消息流（日期分隔、气泡分组、已读回执、文件卡、笔记卡、输入中指示、回到最新） |
| `frontend/src/components/chat/Composer.tsx` | 输入区（Enter 发送 / Shift+Enter 换行、中文输入法保护、附件、拖拽、上传进度） |
| `frontend/src/components/chat/NewChatDialog.tsx` | 新建聊天（单聊 / 群聊两个页签） |
| `frontend/src/components/chat/AddFriendDialog.tsx` | 添加好友（按 @账号搜索） |
| `frontend/src/components/chat/ShareToFriendDialog.tsx` | 分享笔记给好友（笔记页与聊天页共用） |
| `frontend/src/pages/chat/index.tsx` | 聊天页（整屏工作区，移动端列表与会话两态切换） |

### 1.2 修改文件

| 文件路径 | 改动内容 |
| --- | --- |
| `frontend/src/components/VirtualList.tsx` | 新增可选 `rowHeight` 属性（默认仍是 44px）。会话行要放头像 + 两行文字，44px 装不下；默认值不变，不影响笔记与 AI 助手列表 |
| `frontend/src/router/index.tsx` | 注册 `/chat` 懒加载路由 |
| `frontend/src/components/Layout.tsx` | `/chat` 隐藏全局顶部导航（与 `/agent`、`/notes` 同为整屏工作区） |
| `frontend/src/components/Header.tsx` | 主导航新增「聊天」 |
| `frontend/src/pages/notes/index.tsx` | 目录树行接入右键菜单（打开 / 新建子页面 / 移动到… / 分享给好友 / 置顶 / 删除）；接入 `ShareToFriendDialog`；支持深链 `?note=<id>` 直接打开笔记 |
| `frontend/src/stores/useNotesStore.ts` | `togglePin` 增加可选的 `noteId` 参数（右键菜单要能置顶任意一行，而不是只作用于当前打开的笔记）；带乐观更新与失败回滚 |

### 1.3 前端刻意保留的三个替换点

后端接入时只需要动这三处，其余代码不动：

1. **`request/chat.ts` 的 13 个函数体** —— 换成 `request.xxx(...)` 调用。
2. **`subscribeChatEvents`** —— 从内存事件订阅换成 WebSocket / SSE 连接。
3. **`chat.mock.ts` 整个文件删除**。

---

## 2. 后端设计总览

### 2.1 建议的模块结构

```
backend/src/chat/
├── chat.module.ts                 # 模块装配（导入 PrismaModule / RedisModule / NotesModule / StorageService）
├── chat.gateway.ts                # WebSocket 网关（在线的输入状态、消息推送、已读回执）
├── chat.controller.ts             # REST：好友、会话、消息、附件、分享
├── friends.service.ts             # 好友关系（申请 / 同意 / 列表 / 搜索用户）
├── conversations.service.ts       # 会话（单聊复用、建群、置顶、免打扰、已读）
├── messages.service.ts            # 消息（发送、分页拉取、已读回执、笔记卡片落库）
├── chat-attachments.service.ts    # 附件（复用 notes 的 StorageService，独立白名单）
├── dto/
│   ├── friend.dto.ts
│   ├── conversation.dto.ts
│   ├── message.dto.ts
│   └── share.dto.ts
└── types/
    └── chat-events.ts             # 与前端 types/chat.ts 的 ChatEvent 一一对应

backend/prisma/schema.prisma       # 新增 5 个模型（见 §3）
backend/src/app.module.ts          # 注册 ChatModule
```

### 2.2 与既有模块的复用关系

| 复用对象 | 怎么用 |
| --- | --- |
| `src/notes` 的 `StorageService` | 聊天附件同样落盘（或日后换对象存储）。**建议把它从 notes 模块提到 common**，因为现在有两个模块要用它，留在 notes 会让 chat 反向依赖 notes |
| `src/notes` 的 `NotesService.get()` | 「分享笔记」时校验笔记归属、取标题与子页面数（**不要让前端传标题**，见 §5 风险 3） |
| `src/common/guards/jwt-auth.guard.ts` | 所有 REST 接口挂同一个守卫，身份一律从令牌解析 |
| `src/common/decorators/current-user.decorator.ts` | 取 `userId`，不接受前端传入 |
| `src/redis` | 在线状态（`chat:online:<userId>`）、输入状态（短 TTL）、未读计数缓存 |
| 全局响应拦截器 | 返回体自动包成 `{ code, msg, data }`，前端拦截器会解包，**后端不需要手写外层** |

---

## 3. 数据模型（Prisma）

> 字段名与前端 `types/chat.ts` 一一对应；前端拿到的是 JSON，Date 已序列化为 ISO 字符串。

```prisma
/// 好友关系。单向存储：A 加 B 只写一条 (userId, friendId)
model Friendship {
  id        String   @id @default(cuid())
  userId    String
  friendId  String
  /// 备注名，为空时展示对方的 nickname
  alias     String?
  createdAt DateTime @default(now())

  user   User @relation("FriendshipOwner", fields: [userId], references: [id], onDelete: Cascade)
  friend User @relation("FriendshipTarget", fields: [friendId], references: [id], onDelete: Cascade)

  /// 同一个好友只能加一次
  @@unique([userId, friendId])
  @@index([userId])
}

enum ConversationKind {
  DIRECT
  GROUP
}

model Conversation {
  id        String           @id @default(cuid())
  kind      ConversationKind
  /// 群聊的群名。单聊为 null，标题由前端按对方名字推导
  title     String?
  /// 群聊创建者，用于权限判断
  ownerId   String?
  createdAt DateTime         @default(now())
  updatedAt DateTime         @updatedAt

  members  ConversationMember[]
  messages Message[]

  @@index([updatedAt])
}

/// 会话成员。把「置顶 / 免打扰 / 未读」放在成员维度而不是会话维度 ——
/// 这些是每个人自己的状态，放会话上会导致改一个人的设置影响全群
model ConversationMember {
  id             String    @id @default(cuid())
  conversationId String
  userId         String
  pinned         Boolean   @default(false)
  muted          Boolean   @default(false)
  unread         Int       @default(0)
  /// 最后已读的消息 id，用于算未读与已读回执
  lastReadAt     DateTime?
  joinedAt       DateTime  @default(now())
  /// 退出/被移出群聊的时间；为 null 表示仍在群里
  leftAt         DateTime?

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([conversationId, userId])
  @@index([userId, pinned])
}

enum MessageKind {
  TEXT
  IMAGE
  FILE
  NOTE
}

enum MessageStatus {
  SENT
  READ
}

model Message {
  id             String        @id @default(cuid())
  conversationId String
  senderId       String
  kind           MessageKind
  /// 文本内容；附件与笔记卡片也可以带一句说明
  text           String?
  /// 分享的笔记快照（只存 id / 标题 / 类型 / 子页面数，不存正文）
  noteId         String?
  noteTitle      String?
  noteKind       String?
  noteChildCount Int           @default(0)
  status         MessageStatus @default(SENT)
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt

  conversation Conversation      @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender       User              @relation(fields: [senderId], references: [id])
  attachments  ChatAttachment[]

  /// 拉历史消息按 (会话, 时间倒序) 分页，这个复合索引是必需的
  @@index([conversationId, createdAt])
}

/// 聊天附件。与笔记的 Attachment 分表：
/// 两者生命周期不同（删笔记不该删聊天记录里的文件），混在一张表会互相牵连
model ChatAttachment {
  id         String   @id @default(cuid())
  messageId  String
  uploaderId String
  filename   String
  /// 存储相对路径。文件名用随机 UUID + 扩展名，杜绝路径穿越与同名覆盖
  storageKey String
  mimeType   String
  size       Int
  createdAt  DateTime @default(now())

  message Message @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([messageId])
}
```

**关于 `Message.note*` 三个字段**：刻意存标题快照而不是每次联表查笔记。理由有两条：
聊天记录是历史，笔记后来改名不该改写历史；而且列表页一屏几百条消息，
每条都去 join 笔记表会让拉取变成一个 N+1 的坑。

---

## 4. 接口约定

### 4.1 通用约定

| 项 | 约定 |
| --- | --- |
| 基路径 | `/chat`（**不加全局前缀**，与 `/ai`、`/notes` 一致） |
| 鉴权 | 所有接口挂 `JwtAuthGuard`，`userId` 取自令牌，**不接受前端传入** |
| 响应体 | 后端不手写外层，全局拦截器包成 `{ code: 200, msg, data }`；前端拦截器已解包，页面拿到的是 `data` |
| 分页 | 消息列表用游标分页：`?before=<messageId>&limit=30`，避免 offset 在实时插入时错位 |
| 时间 | 一律 ISO 8601 字符串 |
| 头像 | 不存头像文件，前端按 `id` 稳定取色 + 首字母渲染 |

### 4.2 REST 接口

#### 好友

| # | 方法 | 路径 | 请求 | 响应 | 说明 / 错误 |
| --- | --- | --- | --- | --- | --- |
| 1 | GET | `/chat/friends` | — | `Friend[]` | 我的好友列表 |
| 2 | GET | `/chat/users` | `?keyword=` | `Friend[]` | 按 `@handle` 或昵称搜索。**邮箱等敏感字段要脱敏**：非好友不给完整邮箱。空关键词返回空数组，不要返回全量用户 |
| 3 | POST | `/chat/friends` | `{ userId }` | `Friend` | 加好友。已存在返回 200 + 既有关系（幂等），不要报 409 |
| 4 | DELETE | `/chat/friends/:userId` | — | `{ deleted: true }` | 删好友（可选，前端暂未接） |

`Friend` 响应形状：

```ts
{
  id: string;           // 对方 userId
  name: string;         // 昵称，无昵称时用邮箱前缀
  handle: string;       // 唯一账号标识，如 "yihang.chen"
  email: string;        // 非好友时建议返回 "y***@domain"
  bio: string;          // 个性签名；无则空字符串（不要 null，前端直接渲染）
  presence: 'online' | 'away' | 'offline';
  isFriend: boolean;    // 搜索结果里未加好友时为 false
}
```

#### 会话

| # | 方法 | 路径 | 请求 | 响应 | 说明 / 错误 |
| --- | --- | --- | --- | --- | --- |
| 5 | GET | `/chat/conversations` | — | `Conversation[]` | 我的会话列表，按「置顶优先 + 最后消息时间倒序」返回。**由后端排序**，前端只做展示性重排 |
| 6 | POST | `/chat/conversations` | 见下 | `Conversation` | 单聊 / 建群 |
| 7 | PATCH | `/chat/conversations/:id` | `{ pinned?, muted? }` | `Conversation` | 置顶 / 免打扰。**只改当前用户自己那一行** `ConversationMember` |
| 8 | POST | `/chat/conversations/:id/read` | — | `void` | 标记已读：更新 `lastReadAt`、`unread = 0`，并给会话内其他人推 `read` 事件 |

创建会话请求体（`kind` 决定形态）：

```ts
// 单聊：已存在与同一人的单聊时必须返回既有会话，不要新建
{ kind: 'direct', friendId: string }

// 群聊：memberIds 不需要包含自己，后端负责把当前用户加进去
{ kind: 'group', title: string, memberIds: string[] }   // memberIds.length >= 1
```

`Conversation` 响应形状：

```ts
{
  id: string;
  kind: 'direct' | 'group';
  title: string | null;
  memberIds: string[];        // 必须包含当前用户
  lastMessage: Message | null;
  unread: number;
  pinned: boolean;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}
```

> `memberIds` 与 `lastMessage` 建议随列表一起返回。分开查的话，前端渲染列表时
> 要么每行发一次请求，要么闪一下占位。

#### 消息

| # | 方法 | 路径 | 请求 | 响应 | 说明 / 错误 |
| --- | --- | --- | --- | --- | --- |
| 9 | GET | `/chat/conversations/:id/messages` | `?before=&limit=` | `Message[]` | 历史消息，**时间正序**返回。默认 30 条，上限 100 |
| 10 | POST | `/chat/conversations/:id/messages` | `{ text?, attachmentId?, note? }` | `Message` | 发消息。三者至少一个 |
| 11 | POST | `/chat/attachments` | `multipart/form-data`（字段名 `file`） | `ChatAttachment` | 先传文件拿 id，再带 `attachmentId` 发消息 |
| 12 | GET | `/chat/attachments/:id/content` | — | 文件流 | 带 `JwtAuthGuard`。前端已按「先取 Blob 再转 objectURL」处理（iframe/img 带不上 Authorization 头） |

发送消息的校验与错误码：

| 场景 | 状态码 | 前端表现 |
| --- | --- | --- |
| 附件 id 不属于当前用户 | 403 | 提示「附件不存在或无权访问」 |
| 会话不存在或我不是成员 | 404（**不要用 403**） | 与「无权访问」同一文案，避免被当作探测手段 |
| 正文与附件都为空 | 400 | 提示「消息内容不能为空」 |
| 频率超限 | 429 | 提示「发送过于频繁」 |

`Message` 响应形状（与前端 `types/chat.ts` 严格对齐）：

```ts
{
  id: string;
  conversationId: string;
  senderId: string;
  kind: 'text' | 'image' | 'file' | 'note';
  text: string | null;
  attachment: {           // 无附件时 null
    id: string; name: string; size: number; mimeType: string;
    previewUrl?: string;  // 图片消息给出可预览地址
  } | null;
  note: {                 // 非分享消息时 null
    noteId: string; title: string; kind: 'note' | 'folder'; childCount: number;
  } | null;
  createdAt: string;
  status: 'sending' | 'sent' | 'read';   // 后端只会返回 sent / read
}
```

#### 分享笔记

| # | 方法 | 路径 | 请求 | 响应 | 说明 / 错误 |
| --- | --- | --- | --- | --- | --- |
| 13 | POST | `/chat/notes/share` | `{ noteId, toFriendIds[], comment? }` | `{ conversationCount, messageCount }` | 分享给多个好友：为每人复用或新建单聊，各写一条 `kind=NOTE` 的消息 |

**关键约定：请求里不要带 `title` / `childCount`。** 后端应自己按 `noteId`
调 `NotesService.get()` 取标题与子页面数，并顺带完成归属校验。
前端传标题意味着可以伪造标题（甚至把别人的笔记 id 配上一个假标题发出去）。

### 4.3 实时事件协议

推荐 **WebSocket**（`ws://<host>/chat/ws`，连接时带令牌），原因：
输入状态、已读回执、新消息都是双向高频事件，SSE 只能单向、发输入状态得另开 REST。

握手：`new WebSocket(url, [\`bearer.${token}\`])` 或连接后第一帧发 `{ type: 'auth', token }`。
**不要把令牌放 query**（会进访问日志与代理记录）—— 这一点与 `ai` 模块当初
为 SSE 引入一次性 ticket 是同一个理由。

服务端 → 客户端事件（JSON，与前端 `ChatEvent` 一一对应）：

```ts
{ type: 'message',  message: Message }                                   // 新消息
{ type: 'typing',   conversationId: string, userId: string, typing: boolean }
{ type: 'read',     conversationId: string, userId: string }             // 对方已读
{ type: 'presence', userId: string, presence: 'online' | 'away' | 'offline' }
```

客户端 → 服务端：

```ts
{ type: 'typing', conversationId: string, typing: boolean }   // 输入中（节流 3s，前端未接，可后置）
{ type: 'read',   conversationId: string }                    // 主动上报已读（前端走 REST 接口，二选一）
```

服务端要做的三件事：

1. **只推给会话成员**。按 `conversationId → memberIds` 维护房间，不要广播给所有人。
2. **发消息的人也要收到一次 `message` 事件**或由 REST 响应返回完整消息。
   前端已做去重（乐观插入 + 事件按 id 去重），两种都可以，但**要一致**。
3. **断线重连后要能补齐**。建议客户端重连时按 `lastMessageId` 拉一次增量；
   服务端保留最近 N 条消息的环形缓冲或直接用数据库按时间过滤。

### 4.4 附件上传约定

| 项 | 约定 |
| --- | --- |
| 字段名 | `file` |
| 单文件上限 | 50 MB（`CHAT_FILE_MAX_BYTES`，前端已按此拦截） |
| MIME 白名单 | **不放行 `text/html`、`image/svg+xml`、`application/x-msdownload` 等可执行类型**，与笔记附件同一策略，避免存储型 XSS |
| 落盘命名 | 随机 UUID + 扩展名（不要用原始文件名做路径） |
| 中文文件名 | 注意 multer 按 latin1 解码的问题，复用 `notes/attachments.service.ts` 里的 `decodeFilename()` |
| 预览地址 | 图片给 `previewUrl`；接口本身需要鉴权，前端取 Blob 转 objectURL |

---

## 5. 风险与必须注意的点

1. **越权的三种形态都要防**：会话成员校验（不能往别人的会话发消息）、
   附件归属校验（不能拿别人的附件 id 转发）、分享目标校验（只能分享自己的笔记）。
   错误文案统一成「不存在或无权访问」，不要用 403 与 404 的差异泄露资源是否存在
   —— 这与 `ai` 模块的 `assertOwned` 是同一策略。

2. **未读计数放成员维度**，别放会话上。放会话上会导致 A 读了消息、B 的未读数也被清零。

3. **不要相信前端传来的笔记标题**（见 §4.2 分享接口）。

4. **单聊复用**（见 §4.2 创建会话）。不定这条，用户多点几次「发消息」就会
   和多个人建出多条单聊会话，列表里出现一堆重复。

5. **消息分页用游标**。实时聊天里插消息很频繁，offset 分页会出现「翻页时
   看到重复消息」或「漏掉一条」。

6. **`StorageService` 建议从 notes 提到 common**。现在 chat 也要用它，
   留在 notes 里会让 chat 依赖 notes 模块（跨业务模块依赖，日后想单独拆 chat 就拆不动）。

7. **限流**：发消息与上传附件都要限流。可复用 `ai` 模块的 `RateLimitService`
   （它已经基于 Redis 实现，按 userId 计数）。

---

## 6. 分阶段落地顺序

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| 一 | Prisma 模型 + 迁移；好友与会话的读接口（1、5、9） | 用真实数据替换 `chat.ts` 的前 3 个函数，列表能出真实好友与会话 |
| 二 | 发消息 + 附件上传（10、11、12） | 能发文本与文件；`request/chat.ts` 的 `sendMessage` / `uploadAttachment` 换成真实调用 |
| 三 | 建群、加好友、置顶免打扰、已读（6、7、8、2、3） | 弹窗与列表操作全部落到真实数据 |
| 四 | 分享笔记（13） | 笔记右键分享 → 对方会话出现卡片 |
| 五 | WebSocket 推送（§4.3） | 双开两个浏览器账号，A 发 B 实时收到；输入状态与已读回执生效 |
| 六 | 删除 `chat.mock.ts`，清理 `request/chat.ts` 里的 mock 注释 | 全量回归 |

每阶段完成后，前端只需替换 `request/chat.ts` 里对应的函数体，**不需要改页面**。

---

## 7. 本次前端实测记录

脚本：`D:/项目/_verify/test-chat-offline.js`（**不需要后端**，因为数据来自 mock 适配层）

```
40 通过 / 0 失败

A 布局与列表      根容器、全局导航已隐藏、虚拟列表渲染、未读计数、时间摘要、底部用户
B 消息流          消息渲染、日期分隔、文件卡片（体积与类型）
C 切换会话        内容变化、正确的会话、群聊显示发送者名与成员名单、图片消息渲染
D 发消息与发文件  消息即时出现、空输入禁用发送、草稿清空、对方自动回复、文件气泡
E 输入框行为      Shift+Enter 换行、空内容禁用发送
F 会话右键菜单    弹出、含置顶与免打扰、Esc 关闭、键盘操作生效
G 新建聊天/建群   弹窗、两个页签、按钮显示人数、新群进列表
H 加好友          搜索到未加好友的用户、添加成功提示
I 移动端布局      窄屏会话列表收起、消息流可见
J 控制台与网络    0 控制台错误、0 失败请求（证明不依赖后端）
```

另有一个需要后端才能跑的完整脚本：`D:/项目/_verify/test-chat-module.js`
（覆盖 A 聊天页端到端 + B 笔记右键分享 → 聊天收到卡片 + C 深链 `?note=`）。
**等 PG / Redis / 后端起来后直接跑即可**，它会用真实接口验证分享链路。

---

## 8. 落地记录（后端 + 前端接入完成后回填）

### 8.1 脚本与结果

| 脚本 | 覆盖 | 结果 |
| --- | --- | --- |
| `backend/test/verify-chat.cjs` | 后端接口层 | **72 / 0** |
| `_verify/test-chat-live.js` | 浏览器端到端（真实后端） | **29 / 0** |
| `_verify/test-chat-offline.js` | 纯前端（mock 阶段） | 40 / 0（mock 删除后不再适用） |
| `backend/test/probe-chat-ws.cjs` | 裸 ws 探测网关命名空间 | 命名空间可达 |
| `backend/test/seed-chat-demo.cjs` | 测试夹具：给 `.local` 测试账号造好友 / 会话 / 消息 | — |
| `backend/test/purge-demo-chat.cjs` | 清理演示 / 测试残留数据（默认预演，`--apply` 才删） | — |

`verify-chat.cjs` 刻意覆盖的几类边界：

- **错误码语义**：非成员访问会话返回 **404 而不是 403**（403 会暴露「资源存在」）
- **未读计数只在成员维度累加**，且不给自己加
- **单聊复用**：正反方向各建一次都返回同一条会话
- **游标分页**：`limit=2 + before=<id>` 翻页不重不漏
- **附件归属**：拿别人的附件 id 发消息 → 403；非会话成员读附件 → 404
- **分享**：标题由后端按 noteId 取（不是前端传的）；分享别人的笔记 → 404
- **成员级设置**：A 置顶不影响 B

`test-chat-live.js` 里有两条断言值得单独说，因为它们专门抓「假通过」：

- **图片 `naturalWidth > 0`** —— 只看 DOM 里有没有 `<img>` 是抓不到 bug 的；
  附件接口需要 Authorization 头而 `<img>` 带不上，真出问题就是 401 加一张碎图
- **对方发消息后页面不刷新即出现** —— 只有 WebSocket 真通了才会发生，
  用轮询糊出来的实现过不了这条

### 8.2 落地时修正的两处设计

1. **模型名加 `Chat` 前缀**
   `Conversation` / `Message` 已被 AI 助手模块占用。Prisma 的模型与枚举
   共用一个命名空间，同名直接 `Duplicate model` 起不来。
   实际：`ChatFriendship` / `ChatConversation` / `ChatConversationMember` /
   `ChatMessage` / `ChatAttachment`，枚举同理加前缀。

2. **`ChatAttachment.messageId` 必须可空**
   上传与发送是两步（先 `POST /chat/attachments` 拿 id，再带 `attachmentId`
   发消息）。非空约束会让第一步插不进去，整条链路走不通。
   代价是会产生「传了没发」的孤儿附件，已配一个启动时挂载的
   `setInterval` 清理任务（不引入 `@nestjs/schedule`）。

### 8.3 两个实现细节与设计文档不同

- **在线状态续期用 engine.io 心跳**，而不是自己 `setInterval` 管定时器 ——
  心跳本来就是「连接还活着」的信号，省掉一套登记与清理
- **推送只用 `pushToMembers`**（按 userId 房间定向投递），
  只有 `presence` 用广播 —— 业务事件广播会把消息推给不相干的人

### 8.4 测试抓到的一个真实竞态

发消息时 **React 报 "Encountered two children with the same key"**，成因：

```
1. 乐观插入临时气泡 temp_X
2. POST /messages 发出
3. 服务端落库后先推一条 WebSocket 事件（真实 id 为 N）
   → 事件处理按 id 去重，列表里没有 N，于是追加了一条 N
4. POST 响应回来，把 temp_X 替换成 N
   → 列表里出现两条 N
```

只在**发送方**出现，因为只有发送方同时收到「REST 响应」和「自己那条推送」。
修法是在 `useChatStore` 里加 `reconcileMessage()`：替换 temp 的同时
清掉同 id 的其它条目。

### 8.5 测试夹具与「假数据」纪律

`seed-chat-demo.cjs` 是**测试夹具**，不是演示工具。
唯一的消费者是 `_verify/test-chat-live.js` —— 它需要「图片消息、文件消息、
笔记卡片、群聊」这些真实账号不一定有的场景。

```bash
cd backend
node test/seed-chat-demo.cjs                       # 默认 .local 测试账号
node test/seed-chat-demo.cjs --me x@wisora.local   # 指定测试账号
node test/purge-demo-chat.cjs --apply              # 清掉（默认只预演）
```

它是**直接写库**的（不走 API）：脚本没有目标账号的密码，无法登录取令牌。
接口层的正确性由 `verify-chat.cjs` 覆盖。

#### 这里出过一次事故

把 `--me` 指向真实账号后，4 个虚构联系人（沈砚舟、林知微、何澈、邱迟）
**直接出现在用户的聊天列表里**，被当成了 bug。

原因是两件事叠加：

1. `seed-chat-demo.cjs` 建的 `demo-chat-*` 好友是**独立账号**，
   不在浏览器测试的清理范围内 —— 每跑一次测试就往库里多攒 4 个假联系人
2. 脚本的默认 `--me` 当时就写着真实账号

现在有三道限制：

- **默认目标就是 `.local` 测试账号**；`--me` 传非 `.local` 直接拒绝
  （`--force` 才放行，且放行后自己负责清理）
- 新增 `purge-demo-chat.cjs`：按邮箱前缀（`demo-chat-` / `e2e-`）清账号，
  外加「成员不足 2 人的孤儿会话」与标题含「演示」的群。
  **默认只预演**，列出将删除什么，加 `--apply` 才动手
- `test-chat-live.js` 收尾自动调它，不再留残留

界面上的残留也一并清了：加好友弹窗的 placeholder 曾写着
`例如 yanzhou.shen`，那是演示账号沈砚舟的 handle。

### 8.6 视觉层还原为 Telegram（2026-09-23 追加）

#### 先纠正一个前提：此前并不存在「Telegram 版本」

用户反馈「聊天页原本按 Telegram 风格设计，现在被改成了别的样式」，要求改回去。
但查过 `git log --follow` 之后可以确认：**仓库里从来没有过一个 Telegram 风格的实现**，
所以这不是回退，而是第一次真正按 Telegram 实现。

与样式相关的提交只有 `13c0fbb`（初版）→ `0ed1eb8`（接真实接口）→ `14105d7`（清假数据），
三次之间与视觉有关的差异只有两处：`PeerAvatar` → `Avatar` 的改名上移，
以及 `ChatImage` 的附件取流修复。页面自诞生起一直在用项目的暖白 + `slate` + `indigo`。

也就是说，差距是**初始需求（"风格参考 Telegram，适配现有视觉"）与实际交付之间的落差**，
不是新旧两版实现。这种差距没法用 `git checkout` 解决，只能重新实现一遍视觉层。

#### 做法：一层只作用于 `/chat` 的令牌

| 文件 | 改动 |
| --- | --- |
| `frontend/src/index.css` | `:root` 新增 `--tg-*` 令牌；`@theme inline` 把它们注册成主题色（得到 `bg-tg-*` / `border-tg-*` 具名工具类）；新增 `.tg-wallpaper`（渐变 + 涂鸦图案）与 `.tg-app`（选区、光标色）；**把全局 `* { @apply border-border }` 收进 `@layer base`（修全站描边失效，见下）** |
| `frontend/src/lib/chat-utils.ts` | 新增 `peerAvatarClass` / `peerNameClass`（Telegram 7 色成员板，与既有 `avatarTone` 并存） |
| `frontend/src/components/Avatar.tsx` | 新增可选 `fill` 属性：传入则整条替换底色，不传保持原有渐变 |
| `chat/ConversationList.tsx` | 行高 68→72、头像 48px、选中行实底蓝反白、绿色未读角标、右下角铅笔悬浮按钮 |
| `chat/ChatHeader.tsx` | 48px 头像、15px 名字、13px 状态、纯白底只留一条 hairline |
| `chat/MessageList.tsx` | 浅绿/白气泡、SVG 尾巴、时间戳浮入末行、日期胶囊、群聊昵称按人上色 |
| `chat/Composer.tsx` | 白色输入域 + 圆形蓝底纸飞机按钮 |
| `chat/ChatImage.tsx` | 占位底色换令牌 |
| `pages/chat/index.tsx` | 侧栏 320px、壁纸挂 `<main>`、空态与提示条换令牌 |
| `chat/NewChatDialog.tsx` / `chat/AddFriendDialog.tsx` | 换令牌（这两个只在聊天页使用） |

**令牌为什么放 `:root` 而不是页面级作用域**：shadcn 的 Dialog 走 Radix Portal
渲染到 `document.body`，不在聊天页的 DOM 子树内。令牌若挂在 `.tg-app` 上，
弹窗里取到的就是空值，颜色会整片塌掉。作用域靠"只有聊天模块引用 `--tg-` 前缀"来保证。

**`ShareToFriendDialog` 改完又改回去了**：它只被笔记页调用（`pages/notes/index.tsx`），
属于 `/notes` 的流程。跟着变蓝会让那个页面出现第二个强调色 ——
"和全站统一"在这里比"聊天相关就一起改"更重要。

#### 刻意不照抄原版的四处取值

| 位置 | 原版 | 实际取值 | 原因 |
| --- | --- | --- | --- |
| 选中行实底 | `#2aabee` | `#0077b3` | 原版白字压上去只有 2.6:1，正文不达标；加深后 4.9:1 |
| 实底按钮 | `#2aabee` | `#0088cc` | 同上。白图标需要 3:1，加深后 3.9:1 |
| 群聊昵称 | 与头像同色 | 同色相加深版 | 原版 `#7bc862` 当正文在白底上只有 2.2:1，加深后全部过 4.5:1 |
| 壁纸 | Telegram 自有涂鸦插画集 | 同风格线稿（纸飞机/星/心/气泡/时钟/闪电/信封/音符） | 原版素材是 Telegram 的资产，这里是一组近似而非原图 |

#### 自己发的气泡整个透明（Tailwind 的构建期陷阱）

```tsx
// ✗ 不报错，但类名不会被生成，气泡直接变透明
className={`bg-[color:var(--tg-bubble-${mine ? 'out' : 'in'})]`}

// ✓ 两个分支写成完整字面量
mine ? 'bg-[color:var(--tg-bubble-out)]' : 'bg-[color:var(--tg-bubble-in)]'
```

Tailwind 是**构建期扫源码文本**生成工具类的，看不见模板拼接的结果。
当时 `-in` 之所以看着正常，只是因为别处恰好有一个字面量 `bg-[color:var(--tg-bubble-in)]`
（正在输入指示器用了它），而 `-out` 没有任何字面量出处。

**排查手法**：DOM 里的 class 名是对的，但 `getComputedStyle(el).backgroundColor`
是 `rgba(0,0,0,0)` —— 就说明这个工具类根本没被生成。这和"类名写错了"是两种不同的故障，
只看截图容易误判成样式冲突。

#### 另外两个真机截图才发现的问题

1. **壁纸第一版压得太浅**。初版做成"极淡"的渐变，结果 `#effdde` 的自己消息气泡
   与背景几乎同色，气泡边界整个消失。Telegram 原版的壁纸本来就是中等饱和度的，
   白气泡与浅绿气泡都靠它才立得住。已改为蓝 → 青绿 → 橄榄的五段渐变。
2. **时间戳单独占一行**。原先每个气泡底部都有一条只放时间的空行，整屏显得松散。
   Telegram 是短消息的时间贴着文字右端、排不下才换行，改用 `float-right` 实现；
   卡片类消息（图片/文件/笔记）仍走块级，因为卡片自己占满宽度。

#### 第二个更严重的坑：全站的描边色一直是同一个灰

做令牌替换时发现 `border-[color:var(--tg-border)]` 不生效。顺着查到根因，
问题不在令牌写法，而在 `index.css` 里那条最外层的全局规则：

```css
* { @apply border-border; }   /* ← 未分层 */
```

Tailwind v4 把工具类放进 `@layer utilities`，而 **CSS 级联层里未分层的规则
优先级高于任何分层规则** —— 这与选择器权重无关，`*`（权重 0）照样压住
`.border-red-500`（权重 0-1-0）。实测确认：`border-slate-300`、`border-indigo-600`、
`border-red-500`、`border-transparent` 全部回落到默认灰 `#e2e8f0`。

**这是一个先于本次改动就存在的全站性缺陷**，只是默认灰看起来"本来就该是灰的"，
所以一直没被发现。影响面不只是聊天页：全站的错误态描边（`border-red-200`）、
焦点态描边（`focus:border-indigo-300`）、分隔线（`border-transparent`）都从未生效过。

修法是把它收进 base 层：

```css
@layer base {
  * { @apply border-border; }
}
```

#### 令牌改用「具名工具类」而不是任意值

修好分层之后又发现：`border-[color:var(--x)]` 与 `ring-[color:var(--x)]`
在 Tailwind v4 下**根本不生成规则**（`bg-` / `text-` 的这个写法是可以的，
`border-` / `ring-` 不行，且完全不报错）。

因此把令牌注册进 `@theme inline` 变成主题色，代码里改用具名工具类：

| 之前 | 之后 |
| --- | --- |
| `bg-[color:var(--tg-surface)]` | `bg-tg-surface` |
| `text-[color:var(--tg-text-muted)]` | `text-tg-text-muted` |
| `border-[color:var(--tg-border)]` | `border-tg-border` |
| `focus:ring-[color:var(--tg-brand-soft)]` | `focus:ring-tg-brand-soft` |

命名是机械映射（令牌 `--tg-text-muted` → `--color-tg-text-muted` → `text-tg-text-muted`），
整批替换脚本化完成，共 158 处、8 个文件。具名工具类还顺带让
`focus:` / `hover:` / `disabled:` 等变体全部可用（任意值写法在变体下更不可靠）。

> 这两处都是**不报错的失效**：编译通过、Lint 通过、页面也都渲染出来了，
> 只有把 `getComputedStyle` 的实际值打出来才看得见。判断依据：
> 类名在 DOM 上是对的，但计算值是"没生效的样子"（背景透明、描边回默认灰）。

#### 真机验证

`tsc -b`、eslint（改动文件零告警）、`vite build` 全部通过。真机走查覆盖
1440×900 桌面（单聊 + 群聊）与 390×844 移动端（列表抽屉 + 会话态），
并用 `getComputedStyle` 核对实际色值（自己气泡 `rgb(239,253,222)`、对方 `rgb(255,255,255)`）、
选中行反白、未读角标、群聊昵称与头像同色系、气泡尾巴。

走查数据用**新增的** `backend/test/seed-chat-visual.cjs` 生成（`viz-*` 独立命名空间，
自带 `--cleanup`），走查完已清空并核实库里 `viz-*` 用户/会话/消息均为 0。

> ⚠️ 该脚本用裸 `pg` 写时间字段时**必须传 ISO 字符串**：Prisma 的 `DateTime` 落库是
> `timestamp without time zone`，node-postgres 会把 `Date` 按**本地时间**序列化，
> 偏移被 PG 丢弃后读取时又当成 UTC，整体差 8 小时。

#### 一处需要澄清的 `§1.1` 过时项

`§1.1` 是初版设计稿，其中两行已不成立，以实际代码为准：

- `frontend/src/request/chat.mock.ts` —— **已删除**（见 §0）
- `frontend/src/components/chat/PeerAvatar.tsx` —— 已上移并改名为
  `frontend/src/components/Avatar.tsx`（它同时出现在顶部导航与个人资料页，
  放在 `chat/` 下会让导航反向依赖聊天模块）

### 8.7 遗留

- `frontend/pnpm-lock.yaml` 未同步 `socket.io-client`（安装被 safe-delete
  守卫中断）。`package.json` 已声明，在**普通终端**里跑一次
  `pnpm install` 即补齐；只影响 `--frozen-lockfile` 场景。
  注意别用 `--store-dir` 变通 —— pnpm 会提示「整个 node_modules 将被删除重装」，
  在当前环境里这个提示一旦确认就会毁掉依赖树
- 前端暂未接「加载更早的消息」：`listMessages` 已支持 `before` 游标，
  加个按钮即可
- 输入状态（typing）的**发送端**未接：网关与 store 都已支持，
  只差 Composer 里的节流上报
- **群聊昵称会撞色**：成员配色是 `id` 哈希取 7 色，4 人小群天然不撞的概率只有约 35%
  （`7×6×5×4 / 7⁴ ≈ 35%`）。Telegram 是按成员在群里的序号分配来保证不撞的，
  改成那样需要按会话计算颜色映射，代价是会破坏现在"同一个人在所有视图同色"
  这条性质（也即会话列表里的头像色与群聊里的昵称色始终一致）。暂未改动。
- **移动端冷启动直接进入第一个会话**，而不是先看到会话列表。
  来源是 `useChatStore.init` 里那句"首次进入默认选中第一个会话，避免右侧一片空白"，
  在桌面端是合理的，在移动端与 Telegram 的行为不一致（Telegram 先给列表）。
  属既有行为，本次未动。
- **后端在磁盘上有两份**：实际运行的是 `D:\项目\wisora-web\backend`
  （实测进程即 `node D:\项目\wisora-web\backend\dist\src\main`），
  `D:\项目\wisora` 是迁移前的旧独立副本。改代码一律改 monorepo 里的 `backend/`；
  旧副本是否删除待确认。

