import { create } from 'zustand';
import type { AttachmentMeta, NoteDetail, NoteSummary, SaveState } from '../types/note';
import {
  createNote as apiCreateNote,
  deleteAttachment as apiDeleteAttachment,
  deleteNote as apiDeleteNote,
  getNote,
  listNotes,
  updateNote,
  uploadAttachment,
} from '../request/notes';

/** 自动保存防抖时长：输入停顿这么久才发请求 */
const AUTOSAVE_DELAY_MS = 800;

interface NotesState {
  notes: NoteSummary[];
  keyword: string;
  listLoading: boolean;

  activeId?: string;
  active?: NoteDetail;
  detailLoading: boolean;

  saveState: SaveState;
  error?: string;

  loadNotes: (keyword?: string) => Promise<void>;
  setKeyword: (keyword: string) => void;
  openNote: (id: string) => Promise<void>;
  createNote: () => Promise<void>;
  editTitle: (title: string) => void;
  editContent: (content: string) => void;
  /** 立即落盘（离开编辑器、切换笔记前调用） */
  flush: () => Promise<void>;
  togglePin: () => Promise<void>;
  removeNote: (id: string) => Promise<void>;
  uploadFile: (file: File) => Promise<void>;
  removeAttachment: (id: string) => Promise<void>;
  clearError: () => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 兜底补齐 attachments。
 *
 * 后端若某个接口漏返回该字段，页面会在 `attachments.length` 处整页崩掉。
 * TS 类型管不住运行时（axios 的泛型只是断言），所以在这里再兜一层。
 */
function withAttachments(note: NoteDetail): NoteDetail {
  return { ...note, attachments: note.attachments ?? [] };
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

  return {
    notes: [],
    keyword: '',
    listLoading: false,
    activeId: undefined,
    active: undefined,
    detailLoading: false,
    saveState: 'idle',
    error: undefined,

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

      set({ activeId: id, detailLoading: true, active: undefined, saveState: 'idle' });
      try {
        const note = await getNote(id);
        set({ active: withAttachments(note), detailLoading: false });
      } catch (err) {
        set({
          detailLoading: false,
          error: (err as Error).message || '加载笔记失败',
        });
      }
    },

    createNote: async () => {
      cancelPending();
      await get().flush();

      try {
        const note = withAttachments(await apiCreateNote({ title: '无标题', content: '' }));
        // 新笔记插到列表最前，省一次全量刷新
        set((state) => ({
          notes: [{ ...note, pinned: note.pinned }, ...state.notes],
          activeId: note.id,
          active: note,
          saveState: 'idle',
        }));
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
      const wasActive = get().activeId === id;
      if (wasActive) cancelPending();

      const previous = get().notes;
      // 先移出列表让交互立刻响应，失败再回滚
      set({ notes: previous.filter((n) => n.id !== id) });
      if (wasActive) set({ activeId: undefined, active: undefined, saveState: 'idle' });

      try {
        await apiDeleteNote(id);
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

    clearError: () => set({ error: undefined }),
  };
});

export type { AttachmentMeta };
