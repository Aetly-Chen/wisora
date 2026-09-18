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
  moveNote as apiMoveNote,
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

  /**
   * 用户「显式选中」的目录，决定新建/导入的归属。
   *
   * 为什么要与 activeId 分开：导入成功后会把导入的笔记设为 active
   * （用户要求「导入后直接展示内容」），若归属也跟着 active 走，
   * 连续导入就会一层层嵌套（第二次挂到第一次下面）—— 而那篇并不是
   * 用户主动选的。所以只有「用户自己点开某篇」才算选中，
   * 程序化切换（导入后自动展示）不算。
   */
  selectedId?: string;

  saveState: SaveState;
  error?: string;
  /** 一次性成功提示（如「已导入 3 个文件」），展示后由 clearNotice 清掉 */
  notice?: string;

  loadNotes: (keyword?: string) => Promise<void>;
  setKeyword: (keyword: string) => void;
  toggleExpanded: (id: string) => void;
  /**
   * 打开笔记。
   * @param opts.keepSelection 程序化打开（导入后自动展示）传 true，
   *        此时不改变用户选中的目录
   */
  openNote: (
    id: string,
    opts?: { force?: boolean; keepSelection?: boolean },
  ) => Promise<void>;
  /**
   * 新建笔记。
   * - 传 parentId：挂到指定页面下（行内「+」用）
   * - 传 null：建为一级目录
   * - 不传：按当前选中的目录决定 —— 选中了就作为它的子页面，否则一级目录
   */
  createNote: (parentId?: string | null) => Promise<void>;
  editTitle: (title: string) => void;
  editContent: (content: string) => void;
  /** 立即落盘（离开编辑器、切换笔记前调用） */
  flush: () => Promise<void>;
  togglePin: () => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  /** 把某篇笔记移动到另一个页面下（null 表示移到顶层） */
  moveNote: (id: string, parentId: string | null) => Promise<void>;
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

/** 收集某篇笔记及其全部后代的 id（删除时移出列表；移动时判断非法落点） */
export function subtreeIds(notes: NoteSummary[], rootId: string): Set<string> {
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
    selectedId: undefined,
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
    openNote: async (id, opts = {}) => {
      const { force = false, keepSelection = false } = opts;
      // force 用于程序化回读：此时 activeId 可能已经是这篇了，但内容要重取
      if (!force && get().activeId === id) return;

      cancelPending();
      await get().flush();

      // 展开其所有祖先，否则从子页面列表跳进来时，侧边栏里看不到它
      const ancestors = ancestorIds(get().notes, id);
      set((state) => ({
        activeId: id,
        detailLoading: true,
        active: undefined,
        saveState: 'idle',
        // 只有用户主动打开才算「选中」；程序化切换保持原选中项
        selectedId: keepSelection ? state.selectedId : id,
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

    createNote: async (parentId) => {
      cancelPending();
      await get().flush();

      // 不传 parentId 时按「当前选中的目录」决定
      const target = parentId === undefined ? (get().selectedId ?? null) : parentId;

      try {
        await createUnder(target);
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

    moveNote: async (id, parentId) => {
      const { notes, activeId } = get();
      const target = parentId ? notes.find((n) => n.id === parentId) : undefined;
      if (parentId && !target) return;

      // 先落盘，避免下面强制刷新详情时把未保存的编辑冲掉
      cancelPending();
      await get().flush();

      const previous = notes;
      // 乐观更新，交互立刻跟手；失败再回滚
      set((state) => ({
        notes: state.notes.map((n) => (n.id === id ? { ...n, parentId } : n)),
        // 展开目标位置，否则移动完这篇会「消失」在收起的节点里
        expanded: parentId ? { ...state.expanded, [parentId]: true } : state.expanded,
      }));

      try {
        await apiMoveNote(id, parentId);
        // 新旧父页面的 children 都变了，重新拉一次列表与当前详情
        await get().loadNotes();
        // 程序化刷新详情，不改动用户选中的目录
        if (activeId) await get().openNote(activeId, { force: true, keepSelection: true });
      } catch (err) {
        set({ notes: previous, error: (err as Error).message || '移动失败' });
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

      /*
       * 归属：只看「用户显式选中的目录」。
       * 没选中任何目录时导入的内容就是一级目录。
       * 这里刻意不用 activeId —— 导入后 active 会切到导入的笔记，
       * 若按 active 判定，连续导入会一层层嵌套下去。
       */
      const parentId = get().selectedId ?? null;

      const noteFiles = files.filter((f) => detectImportKind(f) !== null);
      const otherFiles = files.filter((f) => detectImportKind(f) === null);

      const failures: string[] = [];

      /*
       * 并行读取与创建。
       *
       * 原先是一个 for + await 逐个串行，N 个文件就是 N 次串行往返；
       * 而且每个文件都调一次 createUnder，也就 set() 一次、整树重渲染一次。
       * 现在改为一次 Promise.allSettled 发出全部请求，再一次性写状态。
       * allSettled 会保持输入顺序，所以「展示第一篇」的语义不变。
       */
      const settled = await Promise.allSettled(
        noteFiles.map(async (file) => {
          const { title, content } = await readNoteFile(file);
          return withNoteShape(await apiCreateNote({ title, content, parentId }));
        }),
      );

      const created: NoteDetail[] = [];
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          created.push(result.value);
        } else {
          const reason = result.reason as Error | undefined;
          failures.push(`${noteFiles[index].name}：${reason?.message ?? '导入失败'}`);
        }
      });

      if (created.length > 0) {
        // 一次 set 把全部导入结果落进列表。
        // 新建接口返回的就是完整详情（含正文与空的子页面/附件），
        // 所以这里不需要再 loadNotes() 全量刷新，也不需要再回读详情 ——
        // 原先这两步是纯多余的两个往返。
        set((state) => ({
          notes: [...created, ...state.notes],
          expanded: parentId
            ? { ...state.expanded, [parentId]: true }
            : state.expanded,
          // 直接展示第一篇导入的内容；不改变 selectedId
          activeId: created[0].id,
          active: created[0],
          saveState: 'idle',
        }));
      }

      /*
       * 非笔记类文件按附件处理（拖拽场景下用户不一定分得清）。
       * 附件要挂到「拖拽发生时就打开着的那篇」——
       * 上面已经把 active 换成导入的笔记了，所以锚点要先记下来。
       */
      let attached = 0;
      const anchorNoteId = parentId ?? created[0]?.id ?? null;
      if (otherFiles.length > 0 && anchorNoteId) {
        const uploads = await Promise.allSettled(
          otherFiles.map(async (file) => uploadAttachment(file, anchorNoteId)),
        );
        const fresh: AttachmentMeta[] = [];
        uploads.forEach((result, index) => {
          if (result.status === 'fulfilled') {
            fresh.push(result.value);
            attached += 1;
          } else {
            failures.push(`${otherFiles[index].name}：上传失败`);
          }
        });
        // 附件挂在锚点笔记上，只有当它正好是当前打开的那篇时才回填界面
        if (fresh.length > 0 && anchorNoteId === created[0]?.id) {
          set((state) =>
            state.active
              ? { active: { ...state.active, attachments: [...fresh, ...state.active.attachments] } }
              : {},
          );
        }
      } else if (otherFiles.length > 0) {
        failures.push('未选中任何目录，非文本文件已跳过（附件需要先有归属页面）');
      }

      const parts: string[] = [];
      if (created.length) parts.push(`导入 ${created.length} 篇笔记`);
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
