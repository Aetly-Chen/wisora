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
| `backend/test/seed-chat-demo.cjs` | 演示数据播种（`--me` / `--reset` / `--json`） | — |

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

### 8.5 演示数据

`seed-chat-demo.cjs` 可以直接给任意账号造一批好友 / 会话 / 消息：

```bash
cd backend
node test/seed-chat-demo.cjs --me you@example.com   # 造数据
node test/seed-chat-demo.cjs --reset                # 清干净
```

它是**直接写库**的（不走 API）—— 因为目标账号可能是真实账号，
脚本不知道密码、拿不到令牌。接口层的正确性由 `verify-chat.cjs` 覆盖。

### 8.6 遗留

- `frontend/pnpm-lock.yaml` 未同步 `socket.io-client`（安装被 safe-delete
  守卫中断）。`package.json` 已声明，跑一次 `pnpm install` 即补齐；
  只影响 `--frozen-lockfile` 场景
- 前端暂未接「加载更早的消息」：`listMessages` 已支持 `before` 游标，
  加个按钮即可
- 输入状态（typing）的**发送端**未接：网关与 store 都已支持，
  只差 Composer 里的节流上报

