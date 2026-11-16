# Studio 模块设计（前后端一体）

> 取代 `studio-completion-plan.md`（那份按端拆分，前后端割裂，已删）。
>
> **每个模块都是「一个人做完前端 + 后端」的粒度**：先讲前端要达成什么交互，再讲后端怎么配合
> （接口、字段、权限、错误码），最后讲联调时两边怎么对齐状态、哪些边界必须处理。
>
> 盘点时间：2026-11-17。所有字段名、模型名、拦截器行为均对照过 `prisma/schema.prisma` 与现有前后端代码。

---

## 0. 为什么按模块切

按「前端任务 / 后端任务」拆，会逼着你在两层之间来回跳：改完 `GET /notes` 的返回形状，
才发现前端想要的是扁平数组而不是嵌套树，于是又回去改接口。

按模块切，每个模块从**交互**倒推出**契约**，一次把两边定死。你做完一个模块，页面上就有
一块东西真的活了，而不是「后端全写完但页面还是假的」。

---

## 1. 模块总览

| # | 模块 | 前端落点 | 后端落点 | 核心接口 | 依赖 |
|---|---|---|---|---|---|
| A | 笔记树与阅读 | `pages/studio` · `pages/studio/components/NoteBody.tsx` | `src/notes/` | `GET /notes`、`GET /notes/:id` | — |
| B | 编辑与保存 | `pages/studio/components/NoteBody.tsx` + 顶栏保存态 | `src/notes/`（`PATCH`） | `PATCH /notes/:id` | A |
| C | 附件与预览 | 左栏「文件」· `pages/studio/components/FilePreview.tsx` | `src/attachments/` | 上传 / 列表 / 签名 / 直链 | A |
| D | AI 对话 | 右栏 Agent · `pages/studio/components/AgentPanel.tsx` | `src/ai/` | 会话 CRUD + `POST /ai/chat` | A |
| E | Agent 操作笔记 | 右栏工具卡片 + 确认条 | `src/ai/tools/` | 复用 D 的流 + `PATCH` | A, D |
| F | 他人主页 | `/profile?u=` | `src/user/` | `GET /user/:id` | — |
| G | 检索（可选） | 左栏搜索框 | `src/rag/` | `GET /notes?keyword=` 升级 | A |

> 注：当前前端所有视图均位于 `pages/studio/index.tsx` 单文件内；按模块推进时拆到 `pages/studio/components/` 下（与 `studio-handoff.md` 一致）。

**推荐顺序**：`A → B → F → C → D → E → G`
（F 最短，插在 B 后面是为了尽早拿到一次「整条链路都通」的信心。）

---

## 2. 通用契约（所有模块共享，先读）

### 2.1 响应信封

后端统一返回，前端拦截器**已经解包**（`interceptor.ts`：`isSuccessCode(raw.code) → return raw.data`）。
所以前端 `request.get<T>()` 直接拿到 `data`，**不要再 `.data` 一次**。

```ts
{ code: 200 | 201 | 4xx | 5xx, msg: string, data: T }
```

- `code` 镜像 HTTP 状态码：GET 200，**未写 `@HttpCode` 的 POST 是 201**。
- 列表类是 `T = Item[]`，不要包成 `{ list, total }`（除非做分页，见 2.5）。

### 2.2 认证

- 所有业务接口挂 `JwtAuthGuard`，用 `@CurrentUser()` 取 `userId`。
- **userId 一律取自令牌**，任何接口都不接受前端传 userId —— 否则等于开放越权。
- 前端已有 `request` 实例自动带 `Authorization`；401/403 由拦截器统一清令牌 + 跳 `/auth`。
- 退出登录（`frontend/src/lib/logout.ts`）时，除了清令牌与 `useChatStore`，**必须一并 `reset()` 新增的 Studio 相关 store / 内存缓存**，防止切账号后看到上一位用户的笔记树或 AI 会话。

### 2.3 权限口径

| 情况 | 返回 |
|---|---|
| 资源不存在 | 404 |
| 资源存在但**不属于当前用户** | **404**（不是 403） |
| 已登录但无权访问某功能 | 403（本设计里基本不出现） |

403 等于告诉对方「这东西存在，只是不给你」—— 对一个多租户笔记应用来说这就是信息泄漏。

### 2.4 错误码表（全模块共用）

| 场景 | HTTP | msg（异常入参传 `message` 字符串，Filter 出参包装为 `msg`） |
|---|---|---|
| 未登录 / 令牌过期 | 401 | 登录已过期，请重新登录 |
| 笔记/附件不存在或不属于你 | 404 | 笔记不存在 / 附件不存在 |
| 父页面不存在 | 404 | 父页面不存在 |
| 移动成环（挂到自己子孙下） | 400 | 不能移动到自己的子页面下 |
| 超出两层限制（挂在二级页面下） | 400 | 最多支持两层页面 |
| 标题过长（>200） | 400 | 标题最多 200 字 |
| 正文超限（>1MB） | 400 | 正文过长 |
| 版本冲突（并发保存） | 409 | 这篇笔记已被修改，请刷新后重试 |
| 文件过大 | 400（`assertUploadable`） / 413（multer 兜底） | 单个文件不能超过 20 MB |
| 类型不支持 | 400 | 不支持的文件类型 |
| 签名过期/无效 | 404 | 链接已失效 |
| 模型服务失败 | 502 | 模型服务暂时不可用，请稍后重试 |

⚠️ 异常只用 Nest 标准形态（`throw new NotFoundException('笔记不存在')`）。
现有 filter 只读 `body.message || body.error`，传 `{code,msg}` 会**静默丢文案**；最终响应体统一由 `HttpExceptionFilter` 包装成 `{ code, msg, data: null }`。

### 2.5 时间、ID、分页

- ID 一律 `cuid` 字符串。
- 时间用 ISO 字符串（`updatedAt` 由 Prisma 自动维护）。
- 笔记**先不做分页**（个人知识库量级），但列表接口要留 `?limit&cursor` 的位置；
  附件列表按 `createdAt desc` 限 200 条，超出提示搜索。

---

## 3. 模块 A · 笔记树与阅读

### A1 前端的交互目标

- 中栏默认是知识树（已实现），节点来自真实笔记；点叶子 → 中栏切到正文。
- 左栏「笔记」tab 是同一份数据的嵌套列表（已实现样式）。
- 左栏顶部公共「＋」按钮按当前 tab 分派行为：`notes` → 新建顶层笔记；`chat` → 新建 AI 会话；`files` → 触发文件上传。
- 状态栏 `N · M`（笔记数 · 顶层数）、面包屑标题都读同一份数据。
- 空库（0 篇）才显示星海动画。

### A2 后端要提供的契约

| 方法 | 路由 | 入参 | 出参 `data` |
|---|---|---|---|
| GET | `/notes` | `?keyword=`（可选，搜标题+正文） | `NoteSummary[]` |
| GET | `/notes/:id` | — | `NoteDetail` |
| POST | `/notes` | `{ title?, parentId?, content? }` | `NoteDetail`（201） |
| DELETE | `/notes/:id` | — | `{ deletedIds: string[] }` |

### A3 数据结构

```ts
// 列表项：故意不带 content（列表可能几百条）
interface NoteSummary {
  id: string;
  title: string;        // 空标题后端兜底「无标题」
  parentId: string | null;  // null = 顶层
  pinned: boolean;      // 列表排序用：pinned desc, updatedAt desc
  updatedAt: string;
}

interface NoteDetail extends NoteSummary {
  content: string;      // Markdown 原文
  createdAt: string;
  updatedAt: string;    // 并发保存要用，见 B4
  attachments: { id: string; filename: string; mimeType: string; size: number }[];
}
```

字段来源：`Note` 模型已有 `id/userId/title/content/pinned/createdAt/updatedAt/deletedAt/parentId`，
**不需要迁移**。`attachments` 走 `Attachment` 关联。

### A4 权限与查询规则

- 所有查询带 `userId = @CurrentUser()` 且 `deletedAt: null`。
- `POST` 的 `parentId` 要为当前用户可见的笔记，否则 404（不能把笔记挂到别人页下）。
- **最多两层页面**：前端 `KnowledgeTree.tsx`（极坐标两圈 `depth: 1 | 2`）与左栏列表均只渲染两层，后端 `POST /notes` 传了 `parentId` 时，目标父节点自身的 `parentId` 必须为 `null`，否则返回 400「最多支持两层页面」。
- `DELETE` 是**软删除整棵子树**：先 BFS 收集 `subtreeIds`，再 `updateMany({ deletedAt })`。
  单条 `update` 只会删一层，子页面会变成孤儿。

### A5 联调：状态同步与边界

| 情况 | 两边怎么对齐 |
|---|---|
| 前端拿到的是**扁平数组** | 前端自己按 `parentId` 组树（`KnowledgeTree` 已这么做）。别让后端返嵌套——两层树结构会让「移动节点」变成两次请求 |
| 新建笔记 | 乐观：先插一条临时节点（`id: temp-xxx`）→ 回包后替换真 id + 真 `updatedAt`；失败则移除并提示 |
| 删除 | 前端把整棵子树从本地移除（不只是一条），否则子节点会挂到不存在的父上 |
| 标题为空 | 后端兜底「无标题」，但**新建后前端不要立刻显示「无标题」**再跳成空——统一等回包 |
| 顶级散记 | `parentId: null` 且没有子页面，在知识树里是实心点（不是空心圈），这是既有规则 |
| 多标签页 | 本轮不做实时同步；切回标签页时 `GET /notes` 重拉一次即可 |
| 请求失败 | 必须和「空库」区分：失败显示一行错误 + 重试，**不要显示星海**（用户会以为数据没了） |

### A6 验证

```bash
curl -s -H "Authorization: Bearer $T" localhost:3000/notes            # → [] 或 NoteSummary[]
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
     -d '{"title":"技术"}' localhost:3000/notes                        # → 201 + NoteDetail
curl -s -X POST ... -d '{"title":"子页","parentId":"<父id>"}'           # 建子页面
curl -s -X DELETE -H "Authorization: Bearer $T" localhost:3000/notes/<父id>
# 期望 data.deletedIds 含父子两个 id；列表里都没了；psql 里 deletedAt 非空
```
跨账号：用 B 的令牌访问 A 的 id → **404**。

---

## 4. 模块 B · 编辑与保存

### B1 前端的交互目标

- 点「编辑」进入可写状态（**没有编辑器依赖**，`<textarea>` + Markdown 预览两个 tab 即可）。
- 输入 debounce 600–800ms 自动保存；`Ctrl/Cmd+S` 立刻保存。
- 顶栏三态：`未保存 / 保存中 / 已保存`。
- 保存失败：顶部错误条 + 重试，**绝不能清空输入或静默丢弃**。

### B2 后端契约

| 方法 | 路由 | 入参 | 出参 |
|---|---|---|---|
| PATCH | `/notes/:id` | `{ title?, content?, pinned?, parentId?, baseUpdatedAt? }` | `NoteDetail` |

### B3 字段与校验

| 字段 | 规则 |
|---|---|
| `title` | 去首尾空白；空 → 存「无标题」；>200 字 → 400 |
| `content` | 上限 1MB（防误粘贴二进制）；不校验格式 |
| `pinned` | 布尔 |
| `parentId` | 允许 `null`（提到顶层）；非空时校验归属 + **禁止成环** + **最多两层**（目标父节点自身的 `parentId` 必须为 `null`，否则 400「最多支持两层页面」） |
| `baseUpdatedAt` | 可选。传了就做乐观锁（见 B4） |

### B4 并发：必须定一个策略

两个标签页同时编辑同一篇，后保存的会覆盖先保存的。选一种并在前端体现：

- **推荐：乐观锁**。前端保存时带上打开时的 `baseUpdatedAt`；后端 `updateMany({ where: { id, userId, updatedAt: base } })`，
  `count === 0` → **409**「这篇笔记已被修改，请刷新后重试」。
- 前端收到 409：**不覆盖、不自动重试**，显示冲突条让用户选「覆盖」或「重新加载」。

### B5 联调：状态同步与边界

| 情况 | 约定 |
|---|---|
| 自动保存与手动保存并发 | 前端用单飞（in-flight 标记）：已有请求在飞时不发第二个，只标「还有未保存」 |
| 保存期间切换笔记 | 先 flush 再切；未完成的请求用 `AbortController` 取消并**不**当作失败提示 |
| 保存成功 | 用回包的 `updatedAt` 更新本地基线（否则下次保存永远 409） |
| 保存失败（网络） | 保留草稿到 `localStorage`（key 带 noteId），下次打开该笔记时提示「有未保存的改动」 |
| 内容被外部改（后来发现） | 列表里 `updatedAt` 变了 → 打开时若本地无草稿，直接用新数据 |
| 空正文 | 允许保存空 `content`（新建后立刻输入很常见），但标题仍兜底 |

### B6 验证

- 改标题 → 800ms 内顶栏变「已保存」；刷新页面内容在。
- 两个标签页同时改：先保存者成功，后者 **409** 且页面出现冲突提示（不被静默覆盖）。
- 断网保存 → 错误条 + 重试按钮；恢复网络点重试成功。
- 输入 5000 字 → 不卡（textarea 原生能力足够，别引入受控双写延迟）。

---

## 5. 模块 C · 附件与预览

### C1 前端交互目标

- 左栏「文件」列出当前用户全部附件（含未挂到笔记的）。
- 上传入口：左栏切到「文件」tab 时，点击左栏顶部公共「＋」按钮（或在文件列表底部提供「＋ 上传文件」按钮）唤起隐藏 `<input type="file">`。
- 点击 → 中栏只读预览：图片 `<img>` / PDF `<iframe>` / 文本 `<pre>` / 其它给下载。
- 顶部 `readonly` 标识保留（沿用现有 UI）。

### C2 后端契约

| 方法 | 路由 | 入参 | 出参 |
|---|---|---|---|
| POST | `/attachments` | `multipart/form-data`，`file` + 可选 `?noteId=` | `AttachmentMeta`（201） |
| GET | `/attachments` | `?noteId=`（可选） | `AttachmentMeta[]`（带 `noteTitle`） |
| DELETE | `/attachments/:id` | — | `{ id }` |
| POST | `/attachments/sign` | `{ ids: string[] }` | `Record<id, string>` 相对直链 |
| GET | `/attachments/:id/content` | `?exp=&sig=`（**不走守卫**） | 文件字节流 |

### C3 数据结构

```ts
interface AttachmentMeta {
  id: string;
  filename: string;   // 原始文件名，展示与下载都用它
  mimeType: string;   // 决定预览方式
  size: number;       // 字节
  noteId: string | null;   // 可空：允许先传文件再挂笔记
  noteTitle?: string | null;
  createdAt: string;
}
```
对应 `Attachment` 模型（已有 `userId/noteId?/filename/mimeType/size/storageKey/createdAt`）。
磁盘落 `StorageService.save()`，`storageKey` 是随机串，**不要用原文件名**（同名覆盖 + 路径穿越）。

### C4 权限：直链为什么必须签名

`<img src>` / `<iframe src>` **带不了 `Authorization` 头**。所以：

1. 前端先 `POST /attachments/sign` 换短时直链（建议 1 小时）。
2. 直链形如 `/attachments/<id>/content?exp=<ts>&sig=<hmac>`，`sig` 对 `${id}.${exp}` 做 HMAC-SHA256 签名（密钥直接复用 `process.env.JWT_ACCESS_SECRET`，无需新增环境变量），校验时用 `crypto.timingSafeEqual` 比对。
3. `/content` **不挂守卫**，只校验签名；无效/过期 → **404**（不是 401，避免暴露接口存在）。
4. 返回**相对路径**：前端自己拼 `VITE_BASE_API`。返回绝对 URL 在换域/代理时会全炸。
5. 后端复用已有的 `StorageService`、`file-guard.ts`（`assertUploadable` / `decodeFilename`）与 `@SkipResponse()`。

⚠️ 这个坑已经踩过：直链是相对路径时若直接 `fetch('/attachments/...')`，请求会打到 dev server 被
SPA fallback 接走，预览区渲染出一整页 HTML。

### C5 联调：状态同步与边界

| 情况 | 约定 |
|---|---|
| 上传中 | 列表先插占位行（进度/灰度），成功替换成真 meta；失败移除并提示 |
| 上传与笔记保存的先后 | `noteId` 可空：先传文件拿到 id，笔记保存后再 `PATCH` 关联。**不要**等笔记存在才允许上传 |
| 文本类预览（`.md` / `.txt`） | 图片/PDF 直接把签名直链赋给 `<img>` / `<iframe>`；文本类由于 `/attachments/:id/content` 挂了 `@SkipResponse()` 直接返回原始字节流，前端必须用原生 `fetch(直链).then(r => r.text())` 读取，**不要**走会自动解包 `{code,msg,data}` 的 `request.get` |
| 签名过期 | 预览 404 时**自动重新签一次**再重试（只重试一次，避免循环） |
| 删除附件 | 同时删库 + 磁盘；若正文里还有 `attachment:<id>` 引用，前端预览时显示「附件已删除」占位 |
| 大文件 | 前端上传前先按 `size` 拦（20MB），比等后端返回 400（`assertUploadable`） / 413 体验好 |
| 同名文件 | 允许并存（`storageKey` 不同），列表靠 `createdAt` 区分 |

### C6 验证

```bash
curl -s -X POST -H "Authorization: Bearer $T" -F "file=@a.png" "localhost:3000/attachments?noteId=<id>"
curl -s -H "Authorization: Bearer $T" -X POST -H 'Content-Type: application/json' \
     -d '{"ids":["<aid>"]}' localhost:3000/attachments/sign     # → { "<aid>": "/attachments/<aid>/content?exp=..&sig=.." }
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "localhost:3000<直链>"   # 200 image/png
curl -s -o /dev/null -w '%{http_code}\n' "localhost:3000/attachments/<aid>/content" # 404
```

---

## 6. 模块 D · AI 对话

### D1 前端交互目标

- 右栏 Agent：发消息 → 文字**逐块**出现；流式中显示停止按钮；历史可回看。
- 顶部上下文 chip（当前笔记 / 选中片段），可删，随请求发给后端。
- 左栏「对话」tab 与右栏共用同一份会话列表。

### D2 后端契约

| 方法 | 路由 | 入参 | 出参 |
|---|---|---|---|
| GET | `/ai/conversations` | — | `{ id, title, updatedAt }[]` |
| POST | `/ai/conversations` | `{ title? }` | `{ id, title }`（201） |
| GET | `/ai/conversations/:id/messages` | `?limit=` | `{ id, role, content, toolCalls?, createdAt }[]` |
| DELETE | `/ai/conversations/:id` | — | `{ id }`（软删） |
| POST | `/ai/chat` | `{ conversationId, content, context?, allowWrite? }` | **SSE / chunked stream** |

> 历史消息只返回 `user` / `assistant`，当轮工具调用卡片与待确认 `proposal` 记在 `assistant` 消息的 `toolCalls` Json 字段中一并返回，保证刷新或切会话后工具卡与提议不丢失。

模型已存在：`Conversation`（`userId/title?/model?/deletedAt`）、`Message`（`role/content/toolCalls?/usage?`）。

### D3 流式协议（两边必须一致）

```
POST /ai/chat   →  Content-Type: text/event-stream

data: {"type":"start","userMessageId":"m1","assistantMessageId":"m2"}
data: {"type":"delta","text":"借"}
data: {"type":"delta","text":"用"}
data: {"type":"done","usage":{"prompt":123,"completion":45}}
data: {"type":"error","message":"模型服务暂时不可用"}
```

- **先落 user 消息**再开口子（否则流到一半崩了，历史里没有提问）。
- `assistantMessageId` 在 `start` 就给出，前端可据此做去重与「停止后落库」对账。
- 结束后把完整 assistant 文本 + `usage` 落库；**中途断开也要落已生成部分**。
- 前端不能用 `EventSource`（带不了 `Authorization`）→ 用 `fetch` + `ReadableStream` 手写 `data:` 行解析。

### D4 上下文

```ts
context?: { noteId?: string; selection?: string }
```
- `noteId` 由后端**自己查库**取正文（不信前端传来的正文），按 token 预算截断（建议 6k 字符）。
- `selection` 是用户选中的片段，只做提示补充，长度上限 2k。
- 前端采集：`view === 'note'` 时默认挂当前笔记 chip（可点 `×` 移除）；监听正文区鼠标/键盘选区填入 `selection`（上限 2k 字符）。

### D5 权限与取消

- 会话归属校验：`conversation.userId === @CurrentUser()`，否则 404。
- 前端「停止」用 `AbortController`；后端监听 `res.on('close')`（配合 `!res.writableEnded` 判断客户端是否中途断开）→ 停止生成并落库半截。
- 落库的 assistant 消息标记 `usage` 里的 `aborted: true`，方便以后区分。
- 后端已移除 `@langchain/*`，直接用 Node 原生 `fetch` 调用 OpenAI 兼容流式接口，零额外依赖。

### D6 联调：状态同步与边界

| 情况 | 约定 |
|---|---|
| 首次发消息还没建会话 | 若右栏当前未选中任何 `conversationId`，前端发送前先调 `POST /ai/conversations` 创建会话拿到 `id`，再发起 `POST /ai/chat` |
| 用户连点发送 | 前端流式中禁用输入；后端对同会话加**单飞锁**（Redis），并发请求返回 409 |
| 停止 | 立刻断开 + 落库半截；前端把半截文本固定在气泡里，不重发 |
| 刷新中途 | 历史里应有 user + 半截 assistant；前端不做「续写」 |
| 令牌过期 | chunked 流里 401 不会被拦截器接住 → 前端要在 `start` 前校验一次 `GET /ai/conversations`（顺带预热） |
| 会话标题 | 首次对话后由后端用首句截断生成（≤30 字），前端不要自己编 |
| 长回答 | 超过 N 字仍继续（别截断），但要保证落库完整 |

### D7 验证

```bash
curl -N -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' \
  -d '{"conversationId":"<id>","content":"说一句话"}' localhost:3000/ai/chat
# 逐条 data:；Ctrl+C 后 GET messages 里有 user + 半截 assistant
```

---

## 7. 模块 E · Agent 操作笔记

### E1 前端交互目标

- AI 能读笔记、能提议修改；**提议**以卡片形式出现（`应用 / 放弃`），用户点了才真改。
- 工具调用可见：一行 `✓ 读取《Rust 借用》`，不黑箱。

### E2 契约（复用 D 的流，扩展 message 类型）

```
data: {"type":"tool","name":"readNote","input":{"id":"n1"},"status":"ok"}
data: {"type":"proposal","patch":{"noteId":"n1","content":"..."},"summary":"把第 2 段改短"}
```

- 工具实现放 `src/ai/tools/`，注册到模型；`Message.toolCalls` 存调用记录（已有 Json 字段）。
- **写操作永远不直接落库**：只产出 `proposal`，真正写入走 `PATCH /notes/:id`（用户点「应用」时前端调用）。

### E3 权限与边界

| 情况 | 约定 |
|---|---|
| 只读开关 | 前端「可写」默认关闭；关闭时后端**不注册** `updateNote` 工具（不是靠模型自觉） |
| 笔记不属于用户 | 工具内部按 404 处理，给模型返回「笔记不存在」，不要抛 500 |
| proposal 过期 | 应用时带 `baseUpdatedAt`；不一致 → 409 提示「笔记已变化」 |
| 并发 | 同一会话同时只有一个 proposal 处于待确认状态 |

### E4 验证

- 问「这篇讲了什么」→ 出现 `readNote` 卡片，回答引用真实内容。
- 说「把第二段改短」→ 出现 proposal；不点应用，笔记**不变**；点了才变，`updatedAt` 更新。

---

## 8. 模块 F · 他人主页

### F1 前端交互

聊天里点头像 → 弹菜单「查看 XXX 的主页」→ `/profile?u=<id>` 显示对方资料。
（菜单与跳转**已实现**，缺的是页面数据。）

### F2 契约

| 方法 | 路由 | 出参 |
|---|---|---|
| GET | `/user/:id` | `{ id, nickname, handle, bio, createdAt, alias }` |

### F3 字段与权限（这一段最容易出事）

- **只对好友开放**：查 `ChatFriendship({ userId: 我, friendId: 对方 })`，没有 → **404**。
- **不返回 email**：现有 `USER_PUBLIC_SELECT` 含 `email`，注释也写着「只有本人资料接口返回」。
  他人主页另建一个 `USER_OTHER_SELECT`，只含 `id/nickname/handle/bio/createdAt`。
- 查自己（`id === 当前用户`）：前端若识别到 `?u=<我的id>` 直接 `navigate('/profile', { replace: true })` 切回本人资料页；后端 `GET /user/:id` 若收到 `id === 当前用户` 也直接复用 `getProfile` 逻辑（不因查不到好友关系而误返 404）。本人 `/user/profile` 那份**要**带 email。
- ⚠️ 路由顺序：`@Get('profile')` 必须写在 `@Get(':id')` **之前**，否则 `/user/profile` 会被当 id 匹配。

### F4 联调边界

| 情况 | 约定 |
|---|---|
| 非好友 / 用户已注销 | 都返回 404，前端统一「找不到这个用户」 |
| `bio` 为空 | 前端显示「这个人还没有写简介」，不要留白 |
| `alias` 有值 | 优先显示备注名，副行显示 `nickname` |
| 加载态 | 骨架两行，不要闪「找不到」 |

### F5 验证

好友 A 看 B → 200 且**无 email 字段**；非好友 → 404；`/user/profile` 仍返回自己的 email。

---

## 9. 模块 G · 检索（可选）

### G1 前端

左栏搜索框（现在只是样式）：输入即筛，命中标题高亮；空结果给「没有匹配」。

### G2 契约

- 短期：`GET /notes?keyword=` 走 SQL `contains`（标题 + 正文），够用到几千篇。
- 长期：`NoteChunk`（已有 `embedding Bytes`）+ 余弦相似度；保存笔记时异步切块，**切块失败不能影响保存**。

### G3 边界

- 删除的笔记不能被召回（join 回 `deletedAt`）。
- 召回要带 `noteId` 与命中片段，前端点击直接打开该笔记并滚动到片段。

---

## 10. 推进顺序

```
A 笔记树与阅读  ──→ B 编辑保存 ──→ F 他人主页（短，穿插）
        │
        ├──→ C 附件与预览
        └──→ D AI 对话 ──→ E Agent 操作笔记
                                   └──→ G 检索（可选）
```

| 阶段 | 完成标志 |
|---|---|
| M1 | A 完成：树、左栏、面包屑、计数全是真数据；空库才出星海 |
| M2 | B 完成：改完能存、刷新不丢、并发有 409 提示 |
| M3 | C 完成：三种文件类型都能预览，直链过期能自愈 |
| M4 | D 完成：流式逐字、停止可靠、历史完整 |
| M5 | E 完成：AI 能读能提议，写操作必须用户确认 |

---

## 11. 已知坑（都实测过）

1. **不需要 Prisma 迁移**：`Note/Attachment/NoteChunk/Conversation/Message` 都在。别为了「删干净」删模型，会动现有数据。
2. **`marked` 输出必须净化**再 `dangerouslySetInnerHTML`（XSS）。
3. **附件直链是相对路径**，前端拼 `VITE_BASE_API`。
4. **SSE 不能用 `EventSource`**，用 `fetch` + `ReadableStream`。
5. **`id` 选择器的 `display` 会压过 `.x[hidden]`** → 两视图叠加，需 `!important`。
6. **验证过渡动画必须异步等结束**：同步读 `getComputedStyle` 会拿到起始值，误判「没生效」。
7. **headless Chrome 两次 shell 调用之间会被回收**（`ECONNREFUSED 9222`）：启动 + 交互 + 截图放同一次调用；窗口宽度下限约 500px。
8. **`rm -rf` / `shutil.rmtree` 会被 safe-delete 拦**：用 `find <dir> -type f -delete`。
9. **POST 默认 201**：前端按 2xx 判成功，别写死 `code === 200`。
10. **退出登录必须清空 Studio 状态**：`frontend/src/lib/logout.ts` 目前只清了 Token 与 `useChatStore`；新增的笔记/附件/AI 状态若放进 zustand store 或内存缓存，必须在 `logout.ts` 一并 `reset()`，避免换账号看到上一个人的数据。

---

## 12. 仓库里现有的文档清单

已作废的旧模块文档（`agent-notes-workbench-plan.md`、`ai-notes-agent-plan.md`、`ai-rag-retrieval.md`、`notes-editor-redesign.md`、`wisora-modules-guide.*`、`wisora-代码逐文件详解.md`、`workbench-design-options.html` 及 `backend/docs/` 下旧文档）均已清理；`docs/` 下现存文档如下：

| 文档 | 状态 | 说明 |
|---|---|---|
| `studio-module-design.md`（本文） | ✅ 现行 | 补逻辑按它对 |
| `studio-handoff.md` | ✅ 现行 | studio 的 UI 结构、MOCK 位置、样式令牌、分栏/移动端约定 |
| `chat-module-design.md` · `chat-backend-implementation.md` | ✅ 现行 | 聊天模块还在用 |
| `homo-伪代码实现详解.md` · `olct-伪代码实现详解.md` | ✅ 无关但有效 | 另外两个项目，与本仓库无关 |
