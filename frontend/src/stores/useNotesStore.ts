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
import type { NoteEvent } from '../request/realtime';
import { detectImportKind, readNoteFile } from '../lib/import-note';
import { apiErrorMessage } from '../lib/api-error';

/** 自动保存防抖时长：输入停顿这么久才发请求 */
const AUTOSAVE_DELAY_MS = 800;

interface NotesState {
  notes: NoteSummary[]; // 全部笔记的扁平列表（树由它按 parentId 现场组装）
  keyword: string; // 已生效的搜索词（输入框的实时值由页面自己持有并防抖后再写进来）
  listLoading: boolean; // 列表请求进行中，侧边栏显示骨架

  /** 树里哪些节点是展开的。用对象而非 Set，便于 zustand 里做不可变更新 */
  expanded: Record<string, boolean>;

  activeId?: string; // 当前打开的笔记 id；undefined 表示没选中
  active?: NoteDetail; // 当前打开的笔记详情（含正文、子页面、附件）
  detailLoading: boolean; // 详情请求进行中，编辑器显示骨架屏

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

  saveState: SaveState; // 正文保存状态；编辑器顶部据此显示「保存中/已保存」
  error?: string; // 页面级错误文案，红色横幅展示（列表失败就走这里，不再弹 toast）
  /** 一次性成功提示（如「已导入 3 个文件」），展示后由 clearNotice 清掉 */
  notice?: string;

  /**
   * 清空全部状态。
   *
   * 退出登录时必须调：笔记是写在内存里的，不清的话换个账号登录，
   * 前一个人的笔记标题与正文会直接显示给新用户。
   */
  reset: () => void;
  loadNotes: (keyword?: string) => Promise<void>; // 拉列表；不传关键词则沿用当前 keyword
  setKeyword: (keyword: string) => void; // 只写关键词，什么时候发请求由页面的防抖 effect 决定
  toggleExpanded: (id: string) => void; // 展开 / 收起某个节点的子页面
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
   * 回读当前打开的那篇（多端 / Agent 改过之后用）。
   *
   * 与 `openNote({force:true})` 的区别：**不置 detailLoading**、不清空 active，
   * 所以编辑器不会闪一下「加载中」—— 只有内容真的变了（`updatedAt` 不同）
   * 才会替换 active，编辑器靠 `key` 里的 updatedAt 重挂载拿到新正文。
   *
   * - `dirty`：本地有未保存改动，**不覆盖**（宁可本地赢）
   * - `unchanged`：服务端版本没变
   */
  reloadActive: () => Promise<'no-op' | 'dirty' | 'unchanged' | 'reloaded'>;
  /**
   * 收到「笔记被改了」的推送（多端 / Agent）。
   *
   * 自己写进去的那次会被 `lastKnownUpdatedAt` 挡掉，所以重复调用是安全的。
   */
  applyRemoteNoteChange: (event: NoteEvent) => Promise<void>;
  /**
   * 新建笔记。
   * - 传 parentId：挂到指定页面下（行内「+」用）
   * - 传 null：建为一级目录
   * - 不传：按当前选中的目录决定 —— 选中了就作为它的子页面，否则一级目录
   */
  createNote: (parentId?: string | null) => Promise<void>;
  editTitle: (title: string) => void; // 改标题：先写本地，再进自动保存队列
  editContent: (content: string) => void; // 改正文：先写本地，再进自动保存队列
  /** 立即落盘（离开编辑器、切换笔记前调用） */
  flush: () => Promise<void>;
  togglePin: (noteId?: string) => Promise<void>; // 置顶 / 取消置顶；不传则作用于当前打开的笔记
  removeNote: (id: string) => Promise<void>; // 删除笔记（子页面由后端级联处理）
  /** 把某篇笔记移动到另一个页面下（null 表示移到顶层） */
  moveNote: (id: string, parentId: string | null) => Promise<void>;
  uploadFile: (file: File) => Promise<void>; // 上传附件并挂到当前笔记
  removeAttachment: (id: string) => Promise<void>; // 删附件记录 + 磁盘文件
  /**
   * 导入文件。md/html/txt 变成笔记，其余走附件。
   * 归属规则：当前打开了某篇笔记 → 作为它的子页面；否则作为顶层页面。
   */
  importFiles: (files: File[]) => Promise<void>;
  clearError: () => void; // 关掉红色横幅
  clearNotice: () => void; // 关掉绿色成功提示
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 编辑版本号 / 已保存版本号。
 *
 * 为什么不能只看 `saveState`：它是「界面状态」，不是「数据是否落库」。
 * 一次保存在飞的时候用户继续打字，回来时 `set({ saveState: 'saved' })` 会把
 * 期间置上的 `dirty` 覆盖掉，紧接着触发的保存又因为「已经是 saved」直接
 * 早退 —— 那段编辑就静默丢了（实测撞到过：编辑器里 3 个公式，库里只有 2 个）。
 * 两个计数器把「有没有新改动」和「界面显示什么」彻底分开。
 */
let editSeq = 0;
let savedSeq = 0;

/**
 * 本地「已知的最新 updatedAt」。
 *
 * 多端回读时用它判断服务端是否真的变了：不能拿 `active.updatedAt` 比 ——
 * 本地保存成功后 `active` 并不会跟着更新（那是刻意的，否则每次保存都会让
 * 编辑器重挂载、光标乱跳）。所以自己存一份，保存成功时推进它。
 */
let lastKnownUpdatedAt = '';

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
    if (!active) return;
    // 正在保存：等它回来，回来时若还有新改动会自动补一次，这里不用再排队
    if (saveState === 'saving') return;
    // 没有新改动（版本号没动）就不必打接口
    if (editSeq === savedSeq) return;

    const seq = editSeq;
    const snapshot = { title: active.title, content: active.content };

    set({ saveState: 'saving' });
    try {
      const saved = await updateNote(active.id, snapshot);
      // 只有这次请求覆盖到的那个版本才算「已保存」
      savedSeq = seq;
      // 保存期间用户可能已经切走，回来再判断是否还是同一篇
      if (get().activeId !== saved.id) return;

      // 自己刚存过，这个 updatedAt 就是「已知最新」，别让多端回读把自己当外部改动
      lastKnownUpdatedAt = saved.updatedAt;

      // 期间又编辑过就别显示「已保存」——那会让用户以为改动已经落库
      set({ saveState: editSeq === seq ? 'saved' : 'dirty', error: undefined });
      // 列表里的标题/时间要同步，否则侧边栏显示的还是旧标题
      set((state) => ({
        notes: state.notes.map((n) =>
          n.id === saved.id
            ? { ...n, title: saved.title, updatedAt: saved.updatedAt, pinned: saved.pinned }
            : n,
        ),
      }));

      // 保存期间攒下的新改动：补一次，别等用户下次动键盘
      if (editSeq !== savedSeq) scheduleSave();
    } catch {
      /**
       * 保存失败：顶栏的保存状态本身就是可见反馈（会变成「保存失败」），
       * 再往横幅塞一份就成了一次失败提示两处。文案交给请求层 toast。
       */
      set({ saveState: 'error' });
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
    // 刚建出来的就是库里的样子，别把它当成为保存的改动
    savedSeq = editSeq;
    lastKnownUpdatedAt = note.updatedAt;
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

    reset: () => {
      // 先取消待执行的自动保存，否则定时器到点会把内容写进已登出的会话
      cancelPending();
      // 换账号后「已知最新」必须清掉，否则下一篇会被误判成「没变」
      lastKnownUpdatedAt = '';
      set({
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
      });
    },

    loadNotes: async (keyword) => {
      const kw = keyword ?? get().keyword;
      set({ listLoading: true });
      try {
        const list = await listNotes(kw || undefined);
        set({ notes: Array.isArray(list) ? list : [], listLoading: false });
      } catch (err) {
        /**
         * 用 `apiErrorMessage` 而不是 `err.message`：
         * axios 的 message 是 `Request failed with status code 500`（给开发者看的），
         * 后端的 `msg` 才是给用户看的。见 `lib/api-error.ts`。
         */
        set({
          listLoading: false,
          error: apiErrorMessage(err, '加载笔记失败'),
        });
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
        // 刚从库里取回来的就是已落库版本，避免下次 flush 把没改的内容再 PATCH 一遍
        savedSeq = editSeq;
        lastKnownUpdatedAt = note.updatedAt;
      } catch (err) {
        set({
          detailLoading: false,
          error: apiErrorMessage(err, '加载笔记失败'),
        });
      }
    },

    reloadActive: async () => {
      const { activeId, active } = get();
      if (!activeId || !active) return 'no-op';
      /*
       * 本地有未保存改动就不回读。
       *
       * 这里的取舍是「本地赢」：用户正在写的东西比远端新版本重要，
       * 悄悄把他手上的内容换掉是更糟的体验（他自己会发现文字跳了）。
       * 真要做到「提示 + 让用户选」，得有一条可见的冲突提示条，
       * 那是另一个决定（见 docs §12）。
       */
      if (editSeq !== savedSeq) return 'dirty';

      const fresh = await getNote(activeId).catch(() => null);
      if (!fresh) return 'unchanged';
      // 比的是「已知最新」，不是 active.updatedAt —— 后者在本地保存后并不会推进
      if (lastKnownUpdatedAt === fresh.updatedAt) return 'unchanged';

      set({ active: withNoteShape(fresh) });
      savedSeq = editSeq;
      lastKnownUpdatedAt = fresh.updatedAt;
      return 'reloaded';
    },

    applyRemoteNoteChange: async (event) => {
      if (event.type === 'note.removed') {
        // 正开着的那篇被别人删了：直接放掉，别留一个打不开的页面
        if (get().activeId === event.noteId) {
          set({ activeId: undefined, active: undefined, saveState: 'idle' });
        }
        await get().loadNotes();
        return;
      }

      // 自己刚存下的那次推送：`lastKnownUpdatedAt` 就是它，忽略（否则白重挂载）
      if (event.updatedAt === lastKnownUpdatedAt) return;

      if (get().activeId === event.noteId) {
        // 有未保存改动时 reloadActive 会返回 'dirty'，不覆盖本地
        await get().reloadActive();
      }
      // 标题、排序、别处新建的笔记都只在列表里体现
      await get().loadNotes();
    },

    createNote: async (parentId) => {
      cancelPending();
      await get().flush();

      // 不传 parentId 时按「当前选中的目录」决定
      const target = parentId === undefined ? (get().selectedId ?? null) : parentId;

      try {
        await createUnder(target);
      } catch {
        // 新建失败只走 toast，不占横幅
      }
    },

    editTitle: (title) => {
      const active = get().active;
      if (!active) return;
      editSeq += 1;
      set({ active: { ...active, title }, saveState: 'dirty' });
      scheduleSave();
    },

    editContent: (content) => {
      const active = get().active;
      if (!active) return;
      editSeq += 1;
      set({ active: { ...active, content }, saveState: 'dirty' });
      scheduleSave();
    },

    flush: async () => {
      cancelPending();
      await doSave();
    },

    /**
     * 置顶 / 取消置顶。
     *
     * 不传 id 时作用于当前打开的笔记（编辑器顶部的按钮用法）；
     * 传 id 则作用于指定笔记 —— 右键菜单要能置顶任意一行，
     * 而不只是"被打开的那一篇"。
     */
    togglePin: async (noteId) => {
      const { notes, active, activeId } = get();
      const targetId = noteId ?? activeId;
      if (!targetId) return;

      const summary = notes.find((n) => n.id === targetId);
      const currentPinned = summary?.pinned ?? active?.pinned ?? false;
      const next = !currentPinned;

      // 乐观更新 + 失败回滚：置顶是高频轻量操作，
      // 等接口回来再变色会有明显的迟滞感
      const previousNotes = notes;
      const previousActive = active;

      set((state) => ({
        notes: state.notes.map((n) => (n.id === targetId ? { ...n, pinned: next } : n)),
        // 只有被改的正好是打开的那篇时才动 active
        ...(state.active && state.active.id === targetId
          ? { active: { ...state.active, pinned: next } }
          : {}),
      }));

      try {
        await updateNote(targetId, { pinned: next });
        await get().loadNotes();
      } catch {
        // 回滚列表与详情；文案交给 toast，不再占用横幅
        set({
          notes: previousNotes,
          active: previousActive,
        });
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
      } catch {
        // 删除失败：恢复列表原样，文案交给 toast
        set({ notes: previous });
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
      } catch {
        // 移动失败：恢复列表原样，文案交给 toast
        set({ notes: previous });
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
      } catch {
        // 上传失败只走 toast
      }
    },

    removeAttachment: async (id) => {
      const active = get().active;
      if (!active) return;

      const previous = active.attachments;
      set({ active: { ...active, attachments: previous.filter((a) => a.id !== id) } });
      try {
        await apiDeleteAttachment(id);
      } catch {
        // 附件删除失败：恢复附件列表，文案交给 toast
        set({ active: { ...active, attachments: previous } });
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
