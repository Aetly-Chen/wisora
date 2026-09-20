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
  noteId: z
    .string()
    .min(1)
    .describe('要读取的笔记 id，来自 list_my_notes 的结果'),
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
          return JSON.stringify({
            success: false,
            message: '没有要修改的字段',
          });
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
