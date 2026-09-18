import { create } from 'zustand';
import type {
  AttachmentMeta,
  NoteDetail,
  NoteSummary,
  NoteTreeRow,
  SaveState,
} from '../types/note';
import {
  createNote as apiCreateNote,
  deleteAttachment as apiDeleteAttachment,
  deleteNote as apiDeleteNote,
  getNote,
  listNotes,
  updateNote,
  uploadAttachment,
} from '../request/notes';
import { detectImportKind, readNoteFile } from '../lib/import-note';

/** 自动保存防抖时长：输入停顿这么久才发请求 */
const AUTOSAVE_DELAY_MS = 800;

interface NotesState {
  notes: NoteSummary[];
  keyword: string;
  listLoading: boolean;

  /** 树里哪些节点是展开的。用对象而非 Set，便于 zustand 里做不可变更新 */
  expanded: Record<string, boolean>;

  activeId?: string;
  active?: NoteDetail;
  detailLoading: boolean;

  saveState: SaveState;
  error?: string;
  /** 一次性成功提示（如「已导入 3 个文件」），展示后由 clearNotice 清掉 */
  notice?: string;

  loadNotes: (keyword?: string) => Promise<void>;
  setKeyword: (keyword: string) => void;
  toggleExpanded: (id: string) => void;
  openNote: (id: string) => Promise<void>;
  /** 新建笔记。传 parentId 即作为该页面的子页面，不传为顶层页面 */
  createNote: (parentId?: string | null) => Promise<void>;
  editTitle: (title: string) => void;
  editContent: (content: string) => void;
  /** 立即落盘（离开编辑器、切换笔记前调用） */
  flush: () => Promise<void>;
  togglePin: () => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  /**
   * 导入文件。md/html/txt 变成笔记，其余走附件。
   * 归属规则：当前打开了某篇笔记 → 作为它的子页面；否则作为顶层页面。
   */
  importFiles: (files: File[]) => Promise<void>;
  clearError: () => void;
  clearNotice: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 兜底补齐后端可能漏掉的字段。
 *
 * 后端若某个接口漏返回，页面会在 `attachments.length` 处整页崩掉。
 * TS 类型管不住运行时（axios 的泛型只是断言），所以在这里再兜一层。
 */
function withNoteShape(note: NoteDetail): NoteDetail {
  return {
    ...note,
    attachments: note.attachments ?? [],
    children: note.children ?? [],
    parentId: note.parentId ?? null,
  };
}

/**
 * 把扁平列表按 parentId 组装成树，再按展开状态摊平成一维行。
 *
 * 摊平是为了继续复用侧边栏已有的虚拟列表 —— 它只认
 * 「一维数组 + 固定行高」，摊平后层级与虚拟化可以同时成立。
 *
 * 搜索时直接返回扁平行（depth 全 0）：命中项散落在各层，
 * 强行接回原树会让「为什么这条在这里」变得难以理解。
 */
export function flattenNotes(
  notes: NoteSummary[],
  expanded: Record<string, boolean>,
  flat = false,
): NoteTreeRow[] {
  if (flat) {
    return notes.map((note) => ({ note, depth: 0, hasChildren: false }));
  }

  const childrenOf = new Map<string | null, NoteSummary[]>();
  const ids = new Set(notes.map((n) => n.id));
  for (const note of notes) {
    // 父节点不在当前列表里（例如被搜索过滤掉）时按顶层处理，
    // 否则这些笔记会从侧边栏里彻底消失
    const key = note.parentId && ids.has(note.parentId) ? note.parentId : null;
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(note);
    else childrenOf.set(key, [note]);
  }

  const rows: NoteTreeRow[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const bucket = childrenOf.get(parentId) ?? [];
    for (const note of bucket) {
      const children = childrenOf.get(note.id) ?? [];
      rows.push({ note, depth, hasChildren: children.length > 0 });
      if (children.length > 0 && expanded[note.id]) {
        walk(note.id, depth + 1);
      }
    }
  };
  walk(null, 0);
  return rows;
}

/** 从扁平列表里找出某篇笔记的所有祖先 id（从近到远） */
function ancestorIds(notes: NoteSummary[], id: string): string[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const chain: string[] = [];
  let current = byId.get(id)?.parentId ?? null;
  // 上限兜底，防止脏数据造成死循环
  let guard = 0;
  while (current && guard < 32) {
    chain.push(current);
    current = byId.get(current)?.parentId ?? null;
    guard += 1;
  }
  return chain;
}

/** 收集某篇笔记及其全部后代的 id（用于乐观删除时一次性移出列表） */
function subtreeIds(notes: NoteSummary[], rootId: string): Set<string> {
  const result = new Set([rootId]);
  let added = true;
  while (added) {
    added = false;
    for (const n of notes) {
      if (n.parentId && result.has(n.parentId) && !result.has(n.id)) {
        result.add(n.id);
        added = true;
      }
    }
  }
  return result;
}

export const useNotesStore = create<NotesState>((set, get) => {
  /** 取消待执行的自动保存（切换/卸载时必须调，否则旧笔记的编辑会写到新笔记上） */
  const cancelPending = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };

  const doSave = async () => {
    const { active, saveState } = get();
    if (!active || saveState === 'saving' || saveState === 'saved') return;

    set({ saveState: 'saving' });
    try {
      const saved = await updateNote(active.id, {
        title: active.title,
        content: active.content,
      });
      // 保存期间用户可能已经切走，回来再判断是否还是同一篇
      if (get().activeId !== saved.id) return;

      set({ saveState: 'saved', error: undefined });
      // 列表里的标题/时间要同步，否则侧边栏显示的还是旧标题
      set((state) => ({
        notes: state.notes.map((n) =>
          n.id === saved.id
            ? { ...n, title: saved.title, updatedAt: saved.updatedAt, pinned: saved.pinned }
            : n,
        ),
      }));
    } catch (err) {
      set({ saveState: 'error', error: (err as Error).message || '保存失败' });
    }
  };

  const scheduleSave = () => {
    cancelPending();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void doSave();
    }, AUTOSAVE_DELAY_MS);
  };

  /** 新建一篇笔记（可选挂在某父页面下），并把它设为当前打开项 */
  const createUnder = async (parentId: string | null, title?: string, content?: string) => {
    const note = withNoteShape(
      await apiCreateNote({ title: title ?? '无标题', content: content ?? '', parentId }),
    );

    set((state) => ({
      // 插到列表最前，省一次全量刷新
      notes: [{ ...note, parentId: note.parentId }, ...state.notes],
      // 自动展开父节点，否则新建的子页面立刻看不见
      expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
      activeId: note.id,
      active: note,
      saveState: 'idle',
      error: undefined,
    }));
    return note;
  };

  return {
    notes: [],
    keyword: '',
    listLoading: false,
    expanded: {},
    activeId: undefined,
    active: undefined,
    detailLoading: false,
    saveState: 'idle',
    error: undefined,
    notice: undefined,

    loadNotes: async (keyword) => {
      const kw = keyword ?? get().keyword;
      set({ listLoading: true });
      try {
        const list = await listNotes(kw || undefined);
        set({ notes: Array.isArray(list) ? list : [], listLoading: false });
      } catch (err) {
        set({ listLoading: false, error: (err as Error).message || '加载笔记失败' });
      }
    },

    setKeyword: (keyword) => set({ keyword }),

    toggleExpanded: (id) =>
      set((state) => ({ expanded: { ...state.expanded, [id]: !state.expanded[id] } })),

    /**
     * 打开笔记。
     *
     * 切换前必须先把当前未保存的编辑落盘并取消待执行的定时器，
     * 否则：① 编辑丢失；② 定时器到点后会把旧笔记的内容 PATCH 到新笔记上。
     */
    openNote: async (id) => {
      if (get().activeId === id) return;

      cancelPending();
      await get().flush();

      // 展开其所有祖先，否则从子页面列表跳进来时，侧边栏里看不到它
      const ancestors = ancestorIds(get().notes, id);
      set((state) => ({
        activeId: id,
        detailLoading: true,
        active: undefined,
        saveState: 'idle',
        expanded: ancestors.reduce(
          (acc, aid) => ({ ...acc, [aid]: true }),
          { ...state.expanded },
        ),
      }));

      try {
        const note = await getNote(id);
        set({ active: withNoteShape(note), detailLoading: false });
      } catch (err) {
        set({
          detailLoading: false,
          error: (err as Error).message || '加载笔记失败',
        });
      }
    },

    createNote: async (parentId = null) => {
      cancelPending();
      await get().flush();

      try {
        await createUnder(parentId);
      } catch (err) {
        set({ error: (err as Error).message || '新建笔记失败' });
      }
    },

    editTitle: (title) => {
      const active = get().active;
      if (!active) return;
      set({ active: { ...active, title }, saveState: 'dirty' });
      scheduleSave();
    },

    editContent: (content) => {
      const active = get().active;
      if (!active) return;
      set({ active: { ...active, content }, saveState: 'dirty' });
      scheduleSave();
    },

    flush: async () => {
      cancelPending();
      await doSave();
    },

    togglePin: async () => {
      const active = get().active;
      if (!active) return;

      const next = !active.pinned;
      set({ active: { ...active, pinned: next } });
      try {
        await updateNote(active.id, { pinned: next });
        await get().loadNotes();
      } catch (err) {
        set({ active: { ...active, pinned: !next }, error: (err as Error).message });
      }
    },

    removeNote: async (id) => {
      const { notes, activeId } = get();
      const doomed = subtreeIds(notes, id);

      // 后端删的是整棵子树，所以判断「当前打开的是否被波及」也要用整棵子树
      const activeRemoved = !!activeId && doomed.has(activeId);
      if (activeRemoved) cancelPending();

      const previous = notes;
      // 先移出列表让交互立刻响应，失败再回滚
      set({ notes: previous.filter((n) => !doomed.has(n.id)) });
      if (activeRemoved) set({ activeId: undefined, active: undefined, saveState: 'idle' });

      try {
        await apiDeleteNote(id);
        // 把删掉的节点从展开状态里清出去，避免残留脏键
        set((state) => {
          const expanded = { ...state.expanded };
          for (const gone of doomed) delete expanded[gone];
          return { expanded };
        });
      } catch (err) {
        set({ notes: previous, error: (err as Error).message || '删除失败' });
      }
    },

    uploadFile: async (file) => {
      const { activeId } = get();
      if (!activeId) {
        set({ error: '请先打开或新建一篇笔记再上传附件' });
        return;
      }
      try {
        const att = await uploadAttachment(file, activeId);
        set((state) =>
          state.active
            ? { active: { ...state.active, attachments: [att, ...state.active.attachments] } }
            : {},
        );
      } catch (err) {
        set({ error: (err as Error).message || '上传失败' });
      }
    },

    removeAttachment: async (id) => {
      const active = get().active;
      if (!active) return;

      const previous = active.attachments;
      set({ active: { ...active, attachments: previous.filter((a) => a.id !== id) } });
      try {
        await apiDeleteAttachment(id);
      } catch (err) {
        set({ active: { ...active, attachments: previous }, error: (err as Error).message });
      }
    },

    importFiles: async (files) => {
      if (files.length === 0) return;

      cancelPending();
      await get().flush();

      // 归属：当前打开了笔记就挂到它下面，否则作为顶层页面
      const parentId = get().activeId ?? null;

      const noteFiles = files.filter((f) => detectImportKind(f) !== null);
      const otherFiles = files.filter((f) => detectImportKind(f) === null);

      const failures: string[] = [];
      let imported = 0;
      let firstImportedId: string | undefined;

      for (const file of noteFiles) {
        try {
          const { title, content } = await readNoteFile(file);
          const note = await createUnder(parentId, title, content);
          if (!firstImportedId) firstImportedId = note.id;
          imported += 1;
        } catch (err) {
          failures.push(`${file.name}：${(err as Error).message}`);
        }
      }

      // 非笔记类文件仍按附件处理（拖拽场景下用户不一定分得清）
      let attached = 0;
      if (parentId) {
        for (const file of otherFiles) {
          try {
            await get().uploadFile(file);
            attached += 1;
          } catch {
            failures.push(`${file.name}：上传失败`);
          }
        }
      } else if (otherFiles.length > 0) {
        failures.push('未打开任何笔记，非文本文件已跳过（附件需要先有归属页面）');
      }

      // 打开第一份导入的笔记，并刷新列表把顺序对齐
      if (firstImportedId) {
        await get().loadNotes();
        await get().openNote(firstImportedId);
      }

      const parts: string[] = [];
      if (imported) parts.push(`导入 ${imported} 篇笔记`);
      if (attached) parts.push(`${attached} 个附件`);

      set({
        notice: parts.length ? `已${parts.join('，')}` : undefined,
        error: failures.length ? failures.join('；') : undefined,
      });
    },

    clearError: () => set({ error: undefined }),
    clearNotice: () => set({ notice: undefined }),
  };
});

export type { AttachmentMeta };
