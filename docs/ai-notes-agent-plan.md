# 让 AI 能操作笔记模块：实现方案

> 目标：把 Agent 从「只能对话」扩展成「能读写我的笔记」——
> ① 让 AI 生成的内容可以保存进笔记模块；② 用自然语言命令 AI 整理/修改/移动/删除笔记。
>
> 本方案最初只给路径与代码、不动仓库；后续已按本方案落地并实测通过，
> 实际执行情况见文末「[落地记录](#9-落地记录)」。所有代码都对照现有实现
> （`backend/src/ai`、`backend/src/notes`）核过接口签名。

---

## 0. 结论先行

| 项 | 结论 |
| --- | --- |
| 需要新增文件 | **1 个**：`backend/src/ai/tools/notes.tool.ts` |
| 需要修改文件 | **后端 5 个 + 前端 3 个**（见 §5 清单） |
| 是否要改数据库 | **不用**。Note 表已具备全部字段（含 `parentId`） |
| 是否需要新接口 | **不用**。工具直接复用 `NotesService` |
| **落地前必须先解决** | 参见下方「两个前置事实」—— 不解决的话，你写完工具也一个都跑不起来 |

---

## 1. 两个前置事实（先看这个，能省你一轮排查）

### 事实 1：写操作的链路是断的，`allowWrite` 恒为 `false`

现有代码里写操作的授权链路是完整的：

```
前端 createChatTicket(allowWrite)  →  POST /ai/chat/ticket  { allowWrite }
   → Redis 存 ticket（30s，含 allowWrite）
   → GET /ai/chat/stream 经 StreamTicketGuard 取出 allowWrite
   → AiService.invokeTool：policy.write && !allowWrite → 拦截，只告诉模型"需要授权"
```

但**前端这一步永远是 false**：

```ts
// frontend/src/request/ai-stream.ts:107
const { ticket } = await createChatTicket();   // ← 没传参数，allowWrite 走默认值 false
```

`streamChat` 的入参里也没有 `allowWrite`。所以从功能上线至今，**所有写操作工具（包括已有的 `rename_my_conversation`）都会被服务端拦截**，模型只会回你一句"需要开启允许 AI 修改数据后才能执行"。

**结论**：前端必须把 `allowWrite` 打通，并且加一个让用户显式开启的开关。这是本方案的前置条件，不是可选项。

### 事实 2：工具系统有三处现成扩展点，照抄即可

| 能力 | 位置 | 说明 |
| --- | --- | --- |
| 工具定义 | `ai/tools/conversation.tool.ts` | 用 `tool(async fn, { name, description, schema })` 定义，zod 描述参数 |
| 按用户注册 | `ai/tools/index.ts` 的 `createUserScopedTools(prisma, userId)` | **每次请求新建**，userId 由闭包注入 —— 模型无法传别人的 userId |
| 写操作标记 | `ai/tools/index.ts` 里给 `policy.write = true` | 由 `AiService.invokeTool` 统一拦截 |
| 策略（超时/重试） | `ai/tools/tool.registry.ts` 的 `ToolPolicy` | 默认 `timeoutMs: 15000, retries: 1` |

> ⚠️ **写工具必须显式设 `retries: 0`**。注册表的默认重试是 1，而 `executeWithRetry` 用的是 `Promise.race` 超时——**超时后底层写入并不会被取消**，若再重试一次就会出现「一篇内容保存成两篇」。这个坑很隐蔽，务必注意。

---

## 2. 总体设计

### 2.1 两条保存路径，职责不同，建议都做

| | 路径 A：消息气泡「保存到笔记」按钮 | 路径 B：自然语言让 AI 调工具 |
| --- | --- | --- |
| 实现 | 前端按钮 → 直接 `POST /notes` | 模型调 `create_my_note` |
| 内容保真 | **逐字不差**（直接拿消息内容） | 模型可能顺手改写、漏段 |
| 消耗 | 0 token | 要把整篇内容再输出一遍（长文很贵） |
| 灵活度 | 只能存"刚生成的那条消息" | 可起标题、判断挂到哪个目录、追加到已有笔记、跨笔记整理 |

**结论**：路径 A 做「保存刚生成的内容」（可靠、便宜），路径 B 做「整理已有笔记」（灵活）。只做 B 会又贵又不稳，只做 A 则失去了你要的"命令 AI 操作笔记"。

### 2.2 为什么工具内部走 `NotesService`，不直接用 Prisma

`conversation.tool.ts` 是直接用 `prisma` 查的，但笔记**不能照抄这个做法**：

`NotesService` 里沉淀了四条硬规则，只应有一份实现：

1. 层级上限 `MAX_DEPTH = 6`（`resolveParent`）
2. 移动的**环检测**（`move` 里判断目标是否在自己的子树内 —— 否则子树互相嵌套后再也遍历不出来，侧边栏整片消失）
3. 删除时**级联软删整棵子树**并返回影响数量（`remove`，避免子页面变孤儿）
4. 详情返回结构 `DETAIL_SELECT`（含 children / attachments）

如果工具直接写 Prisma，AI 这条路就**绕过了全部校验**：能把页面挂到第 8 层、能移出环、能删出孤儿。所以工具必须依赖 `NotesService`。

### 2.3 数据流

```
用户：「帮我把刚才那份文档保存到笔记里」
        │
        ▼
前端 streamChat({ allowWrite: true })            ← 用户开关已打开
        │  createChatTicket(true)
        ▼
POST /ai/chat/ticket → Redis{ userId, allowWrite:true } (30s)
        │
        ▼
GET /ai/chat/stream?ticket=…  → StreamTicketGuard → req.allowWrite = true
        │
        ▼
AiController 按请求创建工具：createUserScopedTools(prisma, userId, notes)
        │
        ▼
AiService.runAgent → 模型返回 tool_calls
        │  invokeTool: policy.write && allowWrite → 放行
        ▼
notes.tool.ts → NotesService.create() → PostgreSQL
        │
        ▼
SSE: tool_call / tool_result 事件 → 前端渲染「已创建笔记」
```

### 2.4 工具清单（6 个，不建议再多）

工具越多，模型选错的概率越高。这 6 个覆盖了你要的全部场景：

| 工具名 | 读写 | 作用 |
| --- | --- | --- |
| `list_my_notes` | 读 | 列出/搜索目录树（带层级缩进、置顶、更新时间、id）。兼作"查 id"入口 |
| `read_my_note` | 读 | 读正文 + 子页面 + 附件清单（正文超 4000 字截断，防上下文塞爆） |
| `create_my_note` | **写** | **保存 AI 生成的内容为新笔记**（可指定父目录） |
| `write_my_note` | **写** | 写入已有笔记正文，`mode: append \| replace`，**默认追加** |
| `update_my_note` | **写** | 改标题 / 置顶 / 移动到另一个目录（复用环检测） |
| `delete_my_note` | **写** | 删除（子树级联），要求模型先复述并取得用户确认 |

**刻意的设计**：把「改正文」和「改元信息」拆成两个工具。合并成一个的话，模型很容易在只想改标题时把 `content` 也传上，导致整篇正文被覆盖。

---

## 3. 后端改动（逐文件 + 完整代码）

### 3.1 新增：`backend/src/ai/tools/notes.tool.ts`

```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { NotesService } from '../../notes/notes.service';

/**
 * 笔记类工具：让 Agent 能读写当前用户的笔记模块。
 *
 * 两个刻意的设计：
 *
 * 1. **内部走 NotesService，不直接查 Prisma**。
 *    层级上限（6 层）、移动环检测、子树级联软删、详情返回结构
 *    这些规则只应有一份实现。若这里直接用 prisma 写，AI 这条路
 *    就会绕过校验 —— 能把页面挂到第 8 层，或把目录移进自己的后代
 *    形成环，之后整片子树在侧边栏里消失。
 *
 * 2. **userId 由工厂闭包注入**，与 conversation.tool.ts 同一策略：
 *    模型无法通过参数指定别人的 userId。NotesService 内部还会
 *    再 assertOwned 一次，双保险。
 */

/** 正文回给模型时的截断长度：一篇长文足以塞满上下文，导致后面几轮失忆 */
const CONTENT_LIMIT = 4000;

/** 把 NotesService 抛出的异常转成模型能读懂的失败结果，而不是让整次工具调用抛错 */
function asFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return JSON.stringify({ success: false, message });
}

interface NoteRow {
  id: string;
  title: string;
  parentId: string | null;
  pinned: boolean;
  updatedAt: Date;
}

/**
 * 把扁平列表渲染成带缩进的文本树。
 *
 * 不返回嵌套 JSON 是因为：模型读缩进文本比读嵌套对象更不容易漏层级，
 * 而且能直接看到「id ↔ 层级」的对应关系，减少它把父子关系搞错。
 */
function renderTree(rows: NoteRow[]): string {
  const idSet = new Set(rows.map((r) => r.id));
  const byParent = new Map<string | null, NoteRow[]>();

  for (const row of rows) {
    // 父级不在结果集内（例如只搜索命中了子页面）时按根节点处理，
    // 否则这些笔记会整块从输出里消失
    const key = row.parentId && idSet.has(row.parentId) ? row.parentId : null;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(row);
    else byParent.set(key, [row]);
  }

  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const row of byParent.get(parentId) ?? []) {
      const time = row.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
      lines.push(
        `${'  '.repeat(depth)}- ${row.title}${
          row.pinned ? '（置顶）' : ''
        } | id=${row.id} | 更新 ${time}`,
      );
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

/* ------------------------------ 读：列表 / 搜索 ------------------------------ */

const listSchema = z.object({
  keyword: z
    .string()
    .optional()
    .describe('按标题或正文搜索的关键词；不传表示列出全部笔记'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('最多返回多少篇，默认 50'),
});

export function createListNotesTool(notes: NotesService, userId: string) {
  return tool(
    async ({ keyword, limit }) => {
      const rows = await notes.list(userId, keyword?.trim() || undefined);
      const take = limit ?? 50;
      const sliced = rows.slice(0, take);

      if (sliced.length === 0) {
        return JSON.stringify({
          found: false,
          total: 0,
          message: keyword
            ? `没有找到包含「${keyword}」的笔记`
            : '该用户还没有任何笔记',
        });
      }

      return JSON.stringify({
        found: true,
        total: rows.length,
        returned: sliced.length,
        // 明确告诉模型结果被截断，避免它以为"就这些"
        truncated: rows.length > sliced.length,
        tree: renderTree(sliced),
      });
    },
    {
      name: 'list_my_notes',
      description:
        '列出或搜索当前用户的笔记目录树（含层级缩进、是否置顶、更新时间与笔记 id）。' +
        '三种情况必须使用：① 用户问"我有哪些笔记""有没有关于 X 的笔记"；' +
        '② 需要把新内容放进某个目录时，先查目录 id —— 不要凭空编造 id；' +
        '③ 用户说"那篇笔记"但指代不明时，先列出来让用户确认。',
      schema: listSchema,
    },
  );
}

const readSchema = z.object({
  noteId: z.string().min(1).describe('要读取的笔记 id，来自 list_my_notes 的结果'),
});

export function createReadNoteTool(notes: NotesService, userId: string) {
  return tool(
    async ({ noteId }) => {
      try {
        const note = await notes.get(userId, noteId);
        const content = note.content ?? '';
        return JSON.stringify({
          found: true,
          id: note.id,
          title: note.title,
          parentId: note.parentId,
          pinned: note.pinned,
          content:
            content.length > CONTENT_LIMIT
              ? `${content.slice(
                  0,
                  CONTENT_LIMIT,
                )}\n…（正文共 ${content.length} 字，已截断）`
              : content,
          children: note.children.map((c) => ({ id: c.id, title: c.title })),
          attachments: note.attachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            size: a.size,
          })),
        });
      } catch (err) {
        return asFailure(err);
      }
    },
    {
      name: 'read_my_note',
      description:
        '读取一篇笔记的正文、子页面与附件列表。' +
        '当用户要求基于某篇笔记续写、摘要、改写或引用其中内容时使用。',
      schema: readSchema,
    },
  );
}

/* ------------------------------ 写：创建 / 写入 ------------------------------ */

const createSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(120)
    .describe('笔记标题，简洁明确，不要带《》或引号'),
  content: z.string().describe('笔记正文，Markdown 格式'),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe(
      '父页面 id：想放进某个目录下时传该目录 id（先用 list_my_notes 查）。' +
        '不传或传 null 表示作为一级目录。',
    ),
});

export function createCreateNoteTool(notes: NotesService, userId: string) {
  return tool(
    async ({ title, content, parentId }) => {
      try {
        const note = await notes.create(userId, {
          title,
          content,
          parentId: parentId ?? undefined,
        });
        return JSON.stringify({
          success: true,
          id: note.id,
          title: note.title,
          parentId: note.parentId,
          message: `已保存到笔记：${note.title}`,
        });
      } catch (err) {
        return asFailure(err);
      }
    },
    {
      name: 'create_my_note',
      description:
        '把一段内容保存为新的笔记（写操作，需要用户授权）。' +
        '用户说"保存到笔记""存成一篇笔记""记录下来""帮我存起来"时使用。' +
        '保存前应先与用户确认标题、以及是否放进某个目录；' +
        '不要擅自保存用户没有要求保存的内容。',
      schema: createSchema,
    },
  );
}

const writeSchema = z.object({
  noteId: z.string().min(1).describe('目标笔记 id'),
  content: z.string().describe('要写入的 Markdown 内容'),
  mode: z
    .enum(['append', 'replace'])
    .optional()
    .describe(
      'append（默认）追加到正文末尾；replace 整篇覆盖。' +
        '只有在用户明确要求"重写/替换整篇"时才用 replace',
    ),
});

export function createWriteNoteTool(notes: NotesService, userId: string) {
  return tool(
    async ({ noteId, content, mode }) => {
      try {
        const current = await notes.get(userId, noteId);
        const existing = current.content ?? '';
        const finalMode = mode ?? 'append';
        const next =
          finalMode === 'replace'
            ? content
            : existing.trim()
              ? `${existing.replace(/\s+$/, '')}\n\n${content}`
              : content;

        const updated = await notes.update(userId, noteId, { content: next });
        return JSON.stringify({
          success: true,
          id: updated.id,
          title: updated.title,
          mode: finalMode,
          contentLength: next.length,
          message:
            finalMode === 'replace'
              ? `已替换《${updated.title}》的正文`
              : `已追加到《${updated.title}》末尾`,
        });
      } catch (err) {
        return asFailure(err);
      }
    },
    {
      name: 'write_my_note',
      description:
        '把内容写入已有笔记的正文（写操作，需要用户授权）。默认追加到末尾；' +
        '仅当用户明确要求整篇重写时才用 replace。' +
        '当用户说"把刚才的内容加到那篇笔记里""补充到《X》后面"时使用。',
      schema: writeSchema,
    },
  );
}

/* --------------------------- 写：标题 / 置顶 / 移动 --------------------------- */

const updateSchema = z.object({
  noteId: z.string().min(1).describe('要修改的笔记 id'),
  title: z.string().min(1).max(120).optional().describe('新标题'),
  pinned: z.boolean().optional().describe('是否置顶'),
  parentId: z
    .string()
    .nullable()
    .optional()
    .describe('移动到该页面下；传 null 移到顶层。不传表示不改动层级'),
});

export function createUpdateNoteTool(notes: NotesService, userId: string) {
  return tool(
    async ({ noteId, title, pinned, parentId }) => {
      try {
        /*
         * 只把「确实传了的字段」放进 dto。
         *
         * 关键点：parentId 的 undefined 与 null 语义不同 ——
         * undefined = 不动层级，null = 移到顶层。
         * 写成 `parentId: parentId ?? null` 会让"只想改标题"变成"顺便移到顶层"。
         */
        const dto: {
          title?: string;
          pinned?: boolean;
          parentId?: string | null;
        } = {};
        if (title !== undefined) dto.title = title;
        if (pinned !== undefined) dto.pinned = pinned;
        if (parentId !== undefined) dto.parentId = parentId;

        if (Object.keys(dto).length === 0) {
          return JSON.stringify({ success: false, message: '没有要修改的字段' });
        }

        const updated = await notes.update(userId, noteId, dto);
        return JSON.stringify({
          success: true,
          id: updated.id,
          title: updated.title,
          parentId: updated.parentId,
          pinned: updated.pinned,
          message: `已更新《${updated.title}》`,
        });
      } catch (err) {
        return asFailure(err);
      }
    },
    {
      name: 'update_my_note',
      description:
        '修改笔记的标题、置顶状态，或把笔记移动到另一个目录下（写操作，需要用户授权）。' +
        '移动时若目标目录不存在、或会造成层级环/超过 6 层，服务端会拒绝并说明原因，' +
        '此时应如实转告用户而不是反复重试。',
      schema: updateSchema,
    },
  );
}

/* ------------------------------ 写：删除（高风险） ------------------------------ */

const deleteSchema = z.object({
  noteId: z.string().min(1).describe('要删除的笔记 id'),
  confirmedByUser: z
    .boolean()
    .describe(
      '用户是否在本轮对话中明确确认删除。未取得确认时必须传 false，' +
        '应先复述将被删除的内容并询问用户',
    ),
});

export function createDeleteNoteTool(notes: NotesService, userId: string) {
  return tool(
    async ({ noteId, confirmedByUser }) => {
      /*
       * 双重拦截。
       *
       * 第一层是 allowWrite（会话级授权），第二层是这里的用户确认。
       * 模型有相当概率直接把 confirmedByUser 传成 true，
       * 所以未确认时这里不是简单报错，而是把「会连带删掉几篇」算出来
       * 交给它 —— 让它有话可讲地去问用户，而不是硬着头皮重试。
       */
      if (!confirmedByUser) {
        try {
          const note = await notes.get(userId, noteId);
          return JSON.stringify({
            success: false,
            needsConfirmation: true,
            willAlsoDelete: note.children.length,
            message:
              `《${note.title}》下还有 ${note.children.length} 个子页面，` +
              '删除会一并移除整棵子树。请先向用户复述并取得明确确认。',
          });
        } catch (err) {
          return asFailure(err);
        }
      }

      try {
        const result = await notes.remove(userId, noteId);
        return JSON.stringify({
          success: true,
          deleted: result.count,
          message: `已删除 ${result.count} 篇（含子页面）`,
        });
      } catch (err) {
        return asFailure(err);
      }
    },
    {
      name: 'delete_my_note',
      description:
        '删除笔记及其全部子页面（写操作，需要用户授权，且需要用户确认）。' +
        '调用前必须先在对话中明确复述将要删除的内容并得到用户同意；' +
        '内容不确定时先用 read_my_note 查看再询问。',
      schema: deleteSchema,
    },
  );
}
```

### 3.2 改：`backend/src/ai/tools/index.ts`

**改动 1**：顶部加 import。

```ts
import { NotesService } from '../../notes/notes.service';
import {
  createCreateNoteTool,
  createDeleteNoteTool,
  createListNotesTool,
  createReadNoteTool,
  createUpdateNoteTool,
  createWriteNoteTool,
} from './notes.tool';
```

**改动 2**：导出。

```ts
export * from './notes.tool';
```

**改动 3**：`createUserScopedTools` 增加 `notes` 参数并注册 6 个新工具。

```ts
/**
 * 按请求创建"当前用户专属"的工具。
 *
 * 为什么要每次请求都新建：这些工具必须带 userId 过滤，
 * 否则 Agent 可能读到甚至改动别人的数据。userId 只有在请求时才拿得到，
 * 所以不能像 query_user 那样在启动时注册成全局单例。
 *
 * 笔记工具依赖 NotesService 而不是 Prisma：层级上限、移动环检测、
 * 子树级联删除这些规则必须复用同一份实现，否则 AI 这条路会绕过校验。
 */
export function createUserScopedTools(
  prisma: PrismaService,
  userId: string,
  notes: NotesService,
): ToolWithPolicy[] {
  return [
    /* ---------- 会话（原有，未改动） ---------- */
    {
      tool: createListConversationsTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createReadConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createRenameConversationTool(prisma, userId),
      policy: { timeoutMs: 10_000, retries: 0, write: true },
    },

    /* ---------- 笔记：读 ---------- */
    {
      tool: createListNotesTool(notes, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },
    {
      tool: createReadNoteTool(notes, userId),
      policy: { timeoutMs: 10_000, retries: 1 },
    },

    /* ---------- 笔记：写 ---------- */
    // 写操作一律 retries: 0 —— 注册表默认是 1，而超时用的是
    // Promise.race，底层写入并不会被取消；再重试一次就会出现
    // 「一篇内容保存成两篇」。这类重复数据很难被用户察觉。
    {
      tool: createCreateNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createWriteNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createUpdateNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
    {
      tool: createDeleteNoteTool(notes, userId),
      policy: { timeoutMs: 15_000, retries: 0, write: true },
    },
  ];
}
```

### 3.3 改：`backend/src/notes/notes.module.ts`

只加一行 `exports`：

```ts
@Module({
  imports: [JwtModule.register({})],
  controllers: [NotesController, AttachmentsController],
  providers: [NotesService, AttachmentsService, StorageService, JwtAuthGuard],
  // 让 AiModule 能注入 NotesService：笔记工具的校验规则必须与 HTTP 接口一致
  exports: [NotesService],
})
export class NotesModule {}
```

### 3.4 改：`backend/src/ai/ai.module.ts`

```ts
// 新增 import
import { NotesModule } from '../notes/notes.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.register({}),
    NotesModule,        // ← 新增
  ],
  // providers / controllers / exports 不变
})
export class AiModule implements OnModuleInit { /* 不变 */ }
```

> 不会产生循环依赖：`NotesModule` 只依赖 `JwtModule`，不反过来依赖 `AiModule`。

### 3.5 改：`backend/src/ai/ai.controller.ts`

**三处**改动。

```ts
// ① 新增 import
import { NotesService } from '../notes/notes.service';

// ② 构造函数注入
constructor(
  private readonly aiService: AiService,
  private readonly jwtService: JwtService,
  private readonly redis: RedisService,
  private readonly conversations: ConversationRepository,
  private readonly rateLimit: RateLimitService,
  private readonly prisma: PrismaService,
  private readonly models: ChatModelFactory,
  private readonly notes: NotesService,     // ← 新增
) {}

// ③ stream() 里创建工具时传入 notes
const userTools = createUserScopedTools(this.prisma, userId, this.notes);
```

其余不动 —— ticket 的签发、guard 的解析、`allowWrite` 的传递链路都已经写好了。

### 3.6 改：`backend/src/ai/prompts/system.prompt.ts`

提示词是这个功能**成败的关键**：工具描述只告诉模型"能做什么"，提示词决定它"什么时候做、什么时候先问"。在 `## 工具使用` 之后插入一节：

```ts
## 笔记操作
- 用户说"保存到笔记""记下来""存起来"时用 create_my_note；
  说"加到那篇笔记里""补充到《X》后面"时用 write_my_note（默认追加，
  除非用户明确说"重写/替换整篇"，否则绝不用 replace）
- **不要擅自保存**。生成了较长内容后，先问一句"要不要我保存到笔记？"，
  得到同意再写。用户没指定目录时，接着问"放一级目录还是某个目录下"，
  不要自己挑一个目录就存
- 需要目录 id 或不确定笔记 id 时，先调 list_my_notes 查，
  **不要编造 id**。用户说"那篇笔记"而指代不明时，
  列出 2-3 个候选让用户挑，不要猜
- 写操作需要用户开启"允许 AI 修改数据"。未开启时如实说明这一点，
  不要说成是你自己被限制了权限
- 删除前必须先在对话里复述"标题 + 会连带删除几个子页面"，
  再问是否确认；得到明确的"确认/删吧"之后才调用 delete_my_note，
  并把 confirmedByUser 传 true
- 写成功后用一句话回报结果（例如"已保存为《XXX》，放在 Y 目录下"），
  不要复述整篇正文
- 不要用笔记工具保存闲聊内容、会话总结等对用户没有留存价值的文本
```

---

## 4. 前端改动（逐文件 + 完整代码）

### 4.1 改：`frontend/src/request/ai-stream.ts`

**改动 1**：`StreamChatParams` 增加 `allowWrite`。

```ts
export interface StreamChatParams {
  question: string;
  conversationId?: string;
  /** 本次使用的模型；不传则由后端回落到默认模型 */
  model?: string;
  /**
   * 本次是否允许 AI 执行写操作（保存/修改/删除笔记等）。
   *
   * 授权随一次性 ticket 一起签发（30 秒过期、取完即焚），
   * 所以它天然只作用于"这一轮"，不会长期生效。
   */
  allowWrite?: boolean;
  signal?: AbortSignal;
  handlers: { /* 保持不变 */ };
}
```

**改动 2**：`streamChat` 把授权传进换票请求。

```ts
export async function streamChat(params: StreamChatParams): Promise<void> {
  const {
    question,
    conversationId,
    model,
    allowWrite = false,
    signal,
    handlers,
  } = params;

  // 关键：授权在这里随 ticket 签发。原先这里是无参调用，
  // 导致 allowWrite 恒为 false，所有写操作工具都会被服务端拦下。
  const { ticket } = await createChatTicket(allowWrite);

  // 以下不变
}
```

### 4.2 改：`frontend/src/stores/useAgentStore.ts`

**改动 1**：state 与 action 定义。

```ts
interface AgentState {
  // ...原有字段...

  /** 当前选中的模型 */
  model: string;
  models: string[];

  /**
   * 是否允许 AI 执行写操作（保存/修改/删除笔记）。
   *
   * 刻意不做持久化：每次进入页面都从"关闭"开始。
   * 写权限被记住的话，用户下次无意识地说一句"帮我清理一下笔记"
   * 就可能真的删掉东西。
   */
  allowWrite: boolean;
  setAllowWrite: (value: boolean) => void;

  // ...原有 action...
}
```

**改动 2**：初始值。

```ts
  model: '',
  models: [],
  allowWrite: false,
```

**改动 3**：实现 action（放在 `setModel` 旁边即可）。

```ts
  setAllowWrite: (value) => set({ allowWrite: value }),
```

**改动 4**：`send()` 里带上授权。

```ts
      await streamChat({
        question: text,
        conversationId: get().conversationId,
        model: get().model || undefined,
        allowWrite: get().allowWrite,   // ← 新增
        signal: controller.signal,
        handlers: { /* 保持不变 */ },
      });
```

### 4.3 改：`frontend/src/pages/agent/index.tsx`

这一处有 3 个独立的改动，都很小。

#### 改动 1：工具名中文映射（顺手把现有的英文名显示改掉）

页面现在直接把后端工具名渲染给用户，观感是开发态的。加一个映射表：

```tsx
/**
 * 工具名 → 用户能看懂的动作描述。
 *
 * 找不到映射时直接显示原始工具名：后端加新工具时前端不用跟着改，
 * 顶多是显示得不够友好，不会显示不出来。
 */
const TOOL_LABELS: Record<string, string> = {
  list_my_notes: '查看笔记目录',
  read_my_note: '读取笔记内容',
  create_my_note: '保存到笔记',
  write_my_note: '写入笔记',
  update_my_note: '更新笔记',
  delete_my_note: '删除笔记',
  list_my_conversations: '查看会话列表',
  read_my_conversation: '读取会话记录',
  rename_my_conversation: '重命名会话',
  query_user: '查询用户资料',
};

const toolLabel = (name: string) => TOOL_LABELS[name] ?? name;
```

然后把渲染 `msg.content`（原先是 `调用工具：${name}\n参数：${args}`）的地方改成用 `toolLabel`。最小改法是在 store 里生成 content 时就用映射，但映射表放页面更合适（store 不该关心文案）。**推荐做法**：store 里给 tool 消息多存一个 `toolName` 字段，页面渲染时自己查表。

`frontend/src/types/agent.ts` 加一个字段：

```ts
  /** 工具消息对应的工具名（用于渲染中文标签） */
  toolName?: string;
```

store 的 `onToolCall` 里补 `toolName: name`，页面里 `{toolLabel(msg.toolName ?? '')}`。

#### 改动 2：输入框旁加「允许 AI 修改数据」开关

放在模型切换按钮左侧（`InputBar` 内、`ModelSwitcher` 之前）。加 import：

```tsx
import { ShieldCheck, ShieldOff } from 'lucide-react';
```

`InputBarProps` 增加两个 prop：

```ts
  allowWrite: boolean;
  onAllowWriteChange: (value: boolean) => void;
```

按钮本体：

```tsx
<Button
  type="button"
  variant="ghost"
  size="icon"
  onClick={() => onAllowWriteChange(!allowWrite)}
  title={
    allowWrite
      ? '已允许 AI 修改数据：可以保存/修改/删除笔记。点击关闭'
      : '允许 AI 修改数据（保存笔记、整理笔记需要开启）'
  }
  aria-pressed={allowWrite}
  className={`h-9 w-9 shrink-0 rounded-full ${
    allowWrite
      ? 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
  }`}
>
  {allowWrite ? (
    <ShieldCheck className="h-4 w-4" />
  ) : (
    <ShieldOff className="h-4 w-4" />
  )}
</Button>
```

父组件接线（两处 `InputBar` 都要加）：

```tsx
allowWrite={allowWrite}
onAllowWriteChange={setAllowWrite}
```

同时从 store 解构出来：

```ts
const { /* ... */ allowWrite, setAllowWrite } = useAgentStore();
```

> 两个细节别漏：① 开关关闭时**不影响**只读工具，用户仍能问"我的笔记里有什么"；
> ② `aria-pressed` 要带上，否则屏幕阅读器无法播报开关状态。

#### 改动 3：助手消息加「保存到笔记」按钮（路径 A）

加 import：

```tsx
import { toast } from 'sonner';
import { createNote } from '@/request/notes';
```

消息气泡底部（助手消息、且内容非空时）：

```tsx
{msg.role === 'ai' && msg.content.trim() && (
  <div className="mt-1.5 flex items-center gap-2">
    <button
      type="button"
      onClick={() => void handleSaveToNotes(msg.content)}
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
    >
      <NotebookPen className="h-3.5 w-3.5" />
      保存到笔记
    </button>
  </div>
)}
```

处理函数（页面顶层，模块外的普通函数不需要；这里需要 toast 与状态，放组件内即可）：

```tsx
  /**
   * 路径 A：把助手这条消息原文存成笔记。
   *
   * 为什么不走 AI 工具：让它"重新输出一遍刚生成的内容"既费 token，
   * 又可能顺手改写或漏段。直接用消息原文 POST /notes 是逐字不差的。
   *
   * 标题取正文第一行（去掉 # 与多余空白），没有就退回时间戳，
   * 免得存出一堆"无标题"。
   */
  const handleSaveToNotes = async (content: string) => {
    const firstLine = content
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0);
    const title = (firstLine ?? '').slice(0, 60) || `对话记录 ${new Date().toLocaleString('zh-CN')}`;

    try {
      await createNote({ title, content });
      toast.success('已保存到笔记');
    } catch (err) {
      toast.error((err as Error).message || '保存失败');
    }
  };
```

> 这个按钮走的是普通 HTTP 接口，**不需要 `allowWrite` 开关** ——
> 它是用户主动点的一次显式操作，与"AI 自主决定改数据"是两件事。

#### 改动 4（可选但推荐）：AI 写完笔记后刷新笔记页

如果用户在同一个 SPA 会话里既开着 AI 助手又开着笔记页，AI 创建笔记后笔记页的列表是旧的。一行搞定：

```tsx
// onToolResult 里，写笔记类工具成功时
if (ok && ['create_my_note', 'write_my_note', 'update_my_note', 'delete_my_note'].includes(name)) {
  void useNotesStore.getState().loadNotes();
}
```

---

## 5. 改动文件清单（可直接对照执行）

### 后端

| 操作 | 文件 | 内容 |
| --- | --- | --- |
| **新增** | `backend/src/ai/tools/notes.tool.ts` | 6 个笔记工具的完整实现（§3.1） |
| 修改 | `backend/src/ai/tools/index.ts` | import + export + `createUserScopedTools` 增参与注册（§3.2） |
| 修改 | `backend/src/notes/notes.module.ts` | `exports: [NotesService]`（§3.3） |
| 修改 | `backend/src/ai/ai.module.ts` | `imports` 加 `NotesModule`（§3.4） |
| 修改 | `backend/src/ai/ai.controller.ts` | 注入 `NotesService` 并传入工具工厂（§3.5） |
| 修改 | `backend/src/ai/prompts/system.prompt.ts` | 新增「笔记操作」一节（§3.6） |

### 前端

| 操作 | 文件 | 内容 |
| --- | --- | --- |
| 修改 | `frontend/src/request/ai-stream.ts` | `allowWrite` 入参 + 透传给 `createChatTicket`（§4.1） |
| 修改 | `frontend/src/stores/useAgentStore.ts` | `allowWrite` 状态 + `setAllowWrite` + send 透传（§4.2） |
| 修改 | `frontend/src/pages/agent/index.tsx` | 授权开关 + 工具中文标签 + 「保存到笔记」按钮（§4.3） |
| 修改 | `frontend/src/types/agent.ts` | `AgentMessage` 加 `toolName?`（§4.3 改动 1） |

**不需要动**：数据库、Prisma schema、notes 模块的 controller/service、附件相关代码。

---

## 6. 落地顺序与验证

### 6.1 建议顺序（每步都可独立验证）

```
① 后端 DI 打通（§3.3 → §3.4 → §3.5）+ 空跑一次编译
     ↓  npm run build（AI 模块需要 NotesModule，DI 不通会在这里报错）
② 新增 notes.tool.ts（§3.1）+ tools/index.ts（§3.2）+ 提示词（§3.6）
     ↓  编译 + 起服务
③ 前端打通 allowWrite（§4.1 → §4.2 → §4.3 改动 2）
     ↓  浏览器里开开关，试"帮我把这句话保存成笔记"
④ 前端补工具标签与「保存到笔记」按钮（§4.3 改动 1、3）
```

先做 ③ 再做 ④ 是有意的：**开关没通之前，你在页面上看到的现象永远是"需要授权"，会误判成工具没写对。**

### 6.2 后端验证（curl，绕过前端确定性验证）

```bash
BASE=http://localhost:3000
TOKEN=<登录后的 accessToken>

# 1) 取一次性 ticket（注意这里的 allowWrite=true，测试时必带）
curl -s -X POST "$BASE/ai/chat/ticket" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"allowWrite":true}'
# → {"ticket":"...","allowWrite":true}   确认 allowWrite 回显为 true

# 2) 开流，让它保存一篇
curl -N "$BASE/ai/chat/stream?ticket=<ticket>&q=把我刚才说的这句话保存成一篇笔记，标题叫测试笔记"
# 观察事件序列：
#   {"type":"tool_call","name":"create_my_note","args":"{\"title\":\"测试笔记\",...}"}
#   {"type":"tool_result","name":"create_my_note","ok":true,"result":"{\"success\":true,...}"}

# 3) 反向验证：不带 allowWrite 取票，同一个问题应该被拦
#    tool_result 的 ok 为 false，result 里含"当前会话未获得用户授权"
```

### 6.3 必须覆盖的边界用例

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | 未开开关 → "保存到笔记" | 工具被拦，模型如实说"需要开启允许 AI 修改数据" |
| 2 | 开开关 → "保存到笔记" | 笔记真的落库，`parentId` 与预期一致 |
| 3 | 未开开关 → "我的笔记里有什么" | **正常返回**（只读工具不受授权影响） |
| 4 | 让它把笔记移到**自己的子页面**下 | 被拒，提示"不能移动到自己的子页面下"（环检测生效） |
| 5 | 让它删除有子页面的笔记 | 先要求确认，确认后删除，`count > 1`（子树级联） |
| 6 | 问"有没有关于 X 的笔记"（X 不存在） | 返回 `found: false`，模型不编造 |
| 7 | 让它"追加"到某篇笔记 | 正文变长、原内容**仍在**（验证 append 语义） |
| 8 | 让它给一篇 5000 字的笔记做摘要 | `read_my_note` 返回的内容被截断并注明 |

### 6.4 浏览器端验证

1. 开关打开 → 图标变实心盾牌 + 靛蓝高亮，`aria-pressed="true"`
2. 发一句"帮我写一份 300 字的产品介绍，然后保存到笔记" → 应看到工具步骤「保存到笔记 → 已完成」
3. 切到 `/notes` → 新笔记出现在列表里，内容/标题正确
4. 关闭开关再做一次 → 应看到「保存到笔记 → 失败」并被提示开启开关
5. 在助手消息上点「保存到笔记」→ 无开关状态下也能成功（验证路径 A 独立于授权）

---

## 7. 风险与边界（三件我要提醒你的事）

### 7.1 `MAX_ITERATIONS = 8` 对"读-改-写"复合任务偏紧

`ai.service.ts` 里单轮对话最多 8 次模型调用。一句"先看看我关于 X 的笔记，总结后追加到《Y》里"大约要走：`list_my_notes` → `read_my_note` → `read_my_note(Y)` → `write_my_note` = 4 轮工具往返 + 首尾 2 轮 = 6 轮，**已经接近上限**。若用户的要求再复杂一点（比如跨 3 篇整理），就会撞上 `MAX_ITERATIONS` 报错。

建议提到 **10～12**，或者把"跨多篇整理"这类需求在产品上引导成多次交互。

### 7.2 写工具的"超时但已写入"是真实存在的窗口

`executeWithRetry` 的 `Promise.race` 不会取消底层 Promise。所以 `create_my_note` 在 15 秒超时后，**数据库写入可能仍然成功**，而模型收到的是失败、可能选择重试 → 重复笔记。

我能给的缓解是 `retries: 0`（必做）。彻底解决需要幂等键（例如让工具带一个客户端生成的 `requestId`，服务端在 Note 上加唯一约束），这属于另一个话题，**建议先上 `retries: 0`，观察一段时间再决定要不要做幂等**。

### 7.3 别把删除做成"一句话就删"

`confirmedByUser` 是模型自报的布尔值，**它完全可以不听提示词直接传 true**。所以：

- 真正的安全边界是 `allowWrite` 开关（用户显式打开的动作）
- 提示词 + 工具内的二次询问只是"降低误删概率"，不是安全机制
- 如果你希望删除更稳，建议**阶段二再上删除**，并且给它一个独立开关（例如再加一个 `allowDestructive`，与 `allowWrite` 分开授权，前端用红色高亮区分）。改动点很小：`TicketPayload` 加一个字段、guard 里读出来、`invokeTool` 判断 `policy.destructive` 时要求它。

**我建议的阶段划分**：

| 阶段 | 内容 | 风险 |
| --- | --- | --- |
| 一 | 只读 2 个 + `create` / `write` / `update`（不含删除） | 低，最坏是建错笔记，可手动删 |
| 二 | 加 `delete_my_note` + 独立授权开关 | 中，需要额外确认机制 |
| 三 | 可选：笔记导出为 .md 下载、让 AI 读附件内容（PDF 解析） | — |

---

## 8. 最后：一个不用改后端的小功能

「把笔记导出为文件下载」——如果你想要的是**真的产出 .md 文件**（而不是存进笔记模块），这件事**不需要 AI、也不需要新接口**：笔记页已经拿到完整 `content`，前端自己造文件即可：

```ts
/** 把当前笔记下载为 .md 文件 */
const downloadAsMarkdown = () => {
  if (!active) return;
  const blob = new Blob([active.content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${active.title || '无标题'}.md`;
  a.click();
  // 记得释放，否则这个 blob 会一直占着内存直到页面刷新
  URL.revokeObjectURL(url);
};
```

配合 §4.3 改动 3 的按钮，你就同时有了：
**存进笔记模块（AI 自主 / 按钮手动）** 与 **导出成独立文件下载** 两条路。

---

## 9. 落地记录

按本方案实施完成，**实测 32/32 通过**（脚本 `D:/项目/_verify/test-ai-notes.js`）。

### 实施中修正的一处配置错误

`NotesService` 的 `exports` 最初被加到了 `AppModule`：

```ts
// ❌ 错误：AppModule 并不是 NotesService 的归属模块
@Module({
  providers: [AppService],
  exports: [NotesService],
})
export class AppModule {}
```

Nest 会因「导出了不属于本模块的 provider」在启动时直接报错。正确位置是
`NotesModule`（它才是 `NotesService` 的 providers 所在），见 §3.3。

> 一句话记住：`exports` 只能导出当前模块 `providers` 里有的东西；
> 要让别的模块用到某个 Service，应由**提供它的那个模块**导出。

### 实测覆盖（32 项断言）

| 分组 | 覆盖内容 |
| --- | --- |
| A1 关闭授权 | 换票回显 `allowWrite=false`；读工具 `list_my_notes` **正常执行**并返回真实笔记；写工具 `create_my_note` 被拦、返回含「授权」的说明；**数据库确认未产生任何笔记** |
| A2 开启授权 | 换票回显 `allowWrite=true`；写工具执行成功；笔记落库且正文正确；未指定父目录时 `parentId` 为 null |
| A3 环检测 | 让 AI 把父目录移到自己的子页面下 → 被后端拒绝，且**层级未被改动** |
| B1 授权开关 | 开关存在、默认关闭（`aria-pressed=false`）、两种状态下的 title 文案正确 |
| B2 界面保存 | 工具气泡出现；工具名渲染为中文「保存到笔记」；**不再出现英文工具名**；显示执行状态；笔记真的落库 |
| B3 消息按钮 | 点击后笔记数 +1；标题取消息首行；存的是消息原文 |
| B4 笔记页 | AI 创建的笔记出现在笔记列表里；**全程 0 控制台错误** |

### 一处已知的观感问题（未改，等你决定）

对话里**工具气泡显示在助手回答的下方**，而真实发生顺序是"先调工具、再产出回答"。例如：

```
[用户]     请创建一篇笔记…
[助手]     已保存为《界面端到端》，放在一级目录下…
[工具]     保存到笔记 · 已完成   ← 实际是先执行的，却显示在后面
```

原因是 `useAgentStore` 把助手回复累积在同一条占位消息里，而工具消息是**追加上去**的新消息，位置固定在助手气泡之后。这在写操作被拦住时看不出来，现在写操作能跑通了才暴露。

真要修的话，思路是：`tool_result` 到达后另起一条助手占位消息，让后续 token 写进新气泡，这样顺序就与真实时间线一致。改动约 15 行，集中在 `send()` 里的 `assistantId` 与 `appendToAssistant`。**要不要改由你定** —— 它不影响功能正确性。

