import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Columns2,
  Eye,
  FileText,
  FileUp,
  FolderInput,
  Home,
  Loader2,
  Paperclip,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { MarkdownView } from '@/components/MarkdownView';
import { VirtualList } from '@/components/VirtualList';
import { flattenNotes, subtreeIds, useNotesStore } from '@/stores/useNotesStore';
import { downloadAttachment, fetchAttachmentBlob } from '@/request/notes';
import type { AttachmentMeta, NoteChildSummary, NoteTreeRow } from '@/types/note';

/* ------------------------------------------------------------------ */
/* 工具函数                                                             */
/* ------------------------------------------------------------------ */

/** 列表里的相对时间：今天显示时分，今年显示月日，更早显示年月 */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 是否可在页面内直接预览 */
function isPreviewable(mime: string): boolean {
  return mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('text/');
}

/* ------------------------------------------------------------------ */
/* 侧边栏目录树的一行                                                    */
/* ------------------------------------------------------------------ */

const NoteTreeItem: React.FC<{
  row: NoteTreeRow;
  active: boolean;
  expanded: boolean;
  /** 正在被拖动的那一行 */
  dragging: boolean;
  /** 当前拖到这一行上方 */
  dragOver: boolean;
  /** 不能作为落点（自己或自己的后代） */
  invalidTarget: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onAddChild: () => void;
  onDelete: () => void;
  onMoveRequest: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOverRow: (e: React.DragEvent) => void;
  onDragLeaveRow: () => void;
  onDropRow: (e: React.DragEvent) => void;
}> = ({
  row,
  active,
  expanded,
  dragging,
  dragOver,
  invalidTarget,
  onOpen,
  onToggle,
  onAddChild,
  onDelete,
  onMoveRequest,
  onDragStart,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}) => {
  const { note, depth, hasChildren } = row;

  return (
    <div
      // 整行可拖：拖到别的行上即为「移动」
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragLeaveRow}
      onDragOver={onDragOverRow}
      onDragLeave={onDragLeaveRow}
      onDrop={onDropRow}
      className={`group flex h-full items-center rounded-lg pr-1 transition-colors ${
        dragging ? 'opacity-40' : ''
      } ${
        dragOver && !invalidTarget
          ? 'bg-indigo-50 ring-2 ring-inset ring-indigo-400'
          : active
            ? 'bg-white shadow-sm ring-1 ring-slate-900/5'
            : 'hover:bg-slate-900/[0.035]'
      }`}
      style={{ paddingLeft: 6 + depth * 14 }}
      data-note-row={note.id}
    >
      {/*
        展开箭头。没有子页面时用等宽占位 —— 否则同一层的标题
        会因有无子页面而左右错开一格，看着像没对齐。
      */}
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? `收起「${note.title}」的子页面` : `展开「${note.title}」的子页面`}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mr-0.5 shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-600"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
      >
        {note.pinned && <Pin className="h-3 w-3 shrink-0 text-indigo-500" />}
        <span className="truncate text-[13.5px] font-medium text-slate-800">
          {note.title || '无标题'}
        </span>
      </button>

      {/* 平时显示更新时间，hover 时让位给操作按钮 —— 一行放不下两者 */}
      <span className="shrink-0 text-[10.5px] text-slate-400 group-hover:hidden">
        {formatTime(note.updatedAt)}
      </span>

      <div className="hidden shrink-0 items-center group-hover:flex">
        <button
          type="button"
          aria-label={`移动「${note.title}」`}
          title="移动到…（也可以直接把这一行拖到别的页面上）"
          onClick={onMoveRequest}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`在「${note.title}」下新建子页面`}
          title="新建子页面"
          onClick={onAddChild}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${note.title}`}
          title={hasChildren ? '删除该页面及其全部子页面' : '删除'}
          onClick={onDelete}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 子页面列表（父页面内容为空时展示）                                     */
/* ------------------------------------------------------------------ */

const ChildPages: React.FC<{
  children: NoteChildSummary[];
  onOpen: (id: string) => void;
}> = ({ children, onOpen }) => (
  <div className="rounded-xl border border-slate-200 bg-white p-1.5" data-testid="child-pages">
    <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] font-medium uppercase tracking-wide text-slate-400">
      <FileText className="h-3.5 w-3.5" />
      子页面
      <span className="text-slate-300">{children.length}</span>
    </div>
    <ul>
      {children.map((child) => (
        <li key={child.id}>
          <button
            type="button"
            onClick={() => onOpen(child.id)}
            className="group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-slate-50"
          >
            {child.pinned ? (
              <Pin className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-300" />
            )}
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-slate-700 group-hover:text-slate-900">
              {child.title || '无标题'}
            </span>
            <span className="shrink-0 text-[10.5px] text-slate-400">
              {formatTime(child.updatedAt)}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500" />
          </button>
        </li>
      ))}
    </ul>
  </div>
);

/* ------------------------------------------------------------------ */
/* 附件区                                                               */
/* ------------------------------------------------------------------ */

const AttachmentsPanel: React.FC<{
  attachments: AttachmentMeta[];
  dragging: boolean;
  onPreview: (a: AttachmentMeta) => void;
  onDelete: (id: string) => void;
}> = ({ attachments, dragging, onPreview, onDelete }) => (
  <div
    className={`border-t border-slate-200/80 px-4 py-3 transition-colors sm:px-6 ${
      dragging ? 'bg-indigo-50/60' : ''
    }`}
  >
    <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-slate-400">
      <Paperclip className="h-3.5 w-3.5" />
      附件
      {attachments.length > 0 && <span className="text-slate-300">{attachments.length}</span>}
    </div>

    {attachments.length === 0 ? (
      <p className="text-[12.5px] text-slate-400">
        {dragging
          ? '松开即可 · md / html / txt 会导入为笔记'
          : 'PDF、图片等拖到这里作为附件；md / html / txt 会导入为笔记'}
      </p>
    ) : (
      <ul className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <li
            key={a.id}
            className="group flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px]"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <button
              type="button"
              onClick={() => (isPreviewable(a.mimeType) ? onPreview(a) : downloadAttachment(a.id, a.filename))}
              className="max-w-[180px] truncate text-slate-700 hover:text-indigo-700"
              title={a.filename}
            >
              {a.filename}
            </button>
            <span className="text-slate-400">{formatSize(a.size)}</span>
            <button
              type="button"
              aria-label={`删除附件 ${a.filename}`}
              onClick={() => onDelete(a.id)}
              className="rounded p-0.5 text-slate-300 transition-colors hover:text-red-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
);

/* ------------------------------------------------------------------ */
/* 附件预览弹窗                                                          */
/* ------------------------------------------------------------------ */

const AttachmentPreview: React.FC<{
  attachment: AttachmentMeta | null;
  onClose: () => void;
}> = ({ attachment, onClose }) => {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    if (!attachment) {
      setUrl(undefined);
      setFailed(undefined);
      return;
    }
    let objectUrl: string | undefined;
    let cancelled = false;

    // 附件接口需要 Authorization 头，iframe 带不上，
    // 所以先取 Blob 再转 objectURL 交给浏览器原生渲染
    fetchAttachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (!cancelled) setFailed(err.message);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  return (
    <Dialog open={!!attachment} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl gap-3 p-4 sm:p-5">
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate text-[14px] font-medium text-slate-800">
            {attachment?.filename}
          </DialogTitle>
        </DialogHeader>

        <div className="flex h-[68vh] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {failed ? (
            <p className="px-6 text-center text-[13px] text-slate-500">{failed}</p>
          ) : !url ? (
            <span className="flex items-center gap-2 text-[13px] text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载
            </span>
          ) : attachment?.mimeType.startsWith('image/') ? (
            <img src={url} alt={attachment.filename} className="max-h-full max-w-full object-contain" />
          ) : (
            <iframe src={url} title={attachment?.filename} className="h-full w-full" />
          )}
        </div>

        {attachment && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg text-[12.5px]"
              onClick={() => downloadAttachment(attachment.id, attachment.filename)}
            >
              下载原文件
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

/* ------------------------------------------------------------------ */
/* 页面                                                                 */
/* ------------------------------------------------------------------ */

type ViewMode = 'edit' | 'split' | 'preview';

const SAVE_LABEL: Record<string, string> = {
  idle: '',
  dirty: '待保存',
  saving: '保存中',
  saved: '已保存',
  error: '保存失败',
};

const NotesPage: React.FC = () => {
  const {
    notes,
    keyword,
    listLoading,
    expanded,
    active,
    activeId,
    detailLoading,
    saveState,
    error,
    notice,
    loadNotes,
    setKeyword,
    toggleExpanded,
    openNote,
    createNote,
    editTitle,
    editContent,
    flush,
    togglePin,
    removeNote,
    uploadFile,
    removeAttachment,
    importFiles,
    moveNote,
    clearError,
    clearNotice,
  } = useNotesStore();

  const [mode, setMode] = useState<ViewMode>('split');
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState<AttachmentMeta | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 正在被拖动的笔记 id（拖拽移动） */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 当前悬停的落点 id，用于高亮 */
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  /** 「移动到…」弹窗的源笔记 id */
  const [moveSourceId, setMoveSourceId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    void loadNotes();
  }, [loadNotes]);

  // 搜索防抖，避免每敲一个字打一次接口
  useEffect(() => {
    const t = setTimeout(() => void loadNotes(keyword), 300);
    return () => clearTimeout(t);
  }, [keyword, loadNotes]);

  // 离开页面前把未保存内容落盘
  useEffect(() => () => void flush(), [flush]);

  /*
   * 树摊平。
   *
   * 搜索时走扁平行：命中项散落在各层，硬接回原树会出现一堆
   * 「父级没命中却因为子级命中而冒出来」的中间节点，反而更难读。
   */
  const treeRows = useMemo(
    () => flattenNotes(notes, expanded, !!keyword.trim()),
    [notes, expanded, keyword],
  );

  /**
   * 非法的移动落点：自己 + 自己的全部后代。
   *
   * 把 A 移到 A 的后代下会形成环（A 的父是 B、B 的父是 A），
   * 两棵子树互相嵌套后谁也遍历不出来，侧边栏里会整片消失。
   * 后端也有同样的校验，这里挡一道是为了不给出会失败的交互暗示。
   */
  const invalidMoveTargets = useMemo(
    () => (draggingId ? subtreeIds(notes, draggingId) : new Set<string>()),
    [draggingId, notes],
  );

  /** 移动弹窗用的完整树（全部展开，不跟随侧边栏的收起状态） */
  const movePickerRows = useMemo(() => {
    const allExpanded = Object.fromEntries(notes.map((n) => [n.id, true]));
    return flattenNotes(notes, allExpanded);
  }, [notes]);

  const moveSource = moveSourceId
    ? notes.find((n) => n.id === moveSourceId)
    : undefined;
  const moveSourceSubtree = useMemo(
    () => (moveSourceId ? subtreeIds(notes, moveSourceId) : new Set<string>()),
    [moveSourceId, notes],
  );

  const handleMove = (id: string, parentId: string | null) => {
    void moveNote(id, parentId);
  };

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).forEach((f) => void uploadFile(f));
  };

  /**
   * 拖拽落下的文件。
   *
   * 拖拽是「用户没明说要干什么」的入口，所以按类型自动分流：
   * md/html/txt 视为要导入的笔记，其余按附件处理 ——
   * 让用户先选一次「你要导入还是上传」反而更打断。
   */
  const handleDrop = (files: FileList | null) => {
    if (!files?.length) return;
    void importFiles(Array.from(files));
  };

  const handleImportPick = async (files: FileList | null) => {
    if (!files?.length) return;
    setImporting(true);
    try {
      await importFiles(Array.from(files));
    } finally {
      setImporting(false);
    }
  };

  /** 侧边栏「新建」：当前有打开的页面就作为它的子页面，否则建顶层页面 */
  const handleCreate = () => {
    void createNote(activeId ?? null);
  };

  return (
    /*
     * 拖拽监听挂在根容器上，而不是编辑器区域。
     *
     * 原先只挂在编辑器那一小块，导致三个常见位置全部无效：
     * 标题区、侧边栏，以及「还没打开任何笔记」时的整个页面 ——
     * 而最后那种恰恰是最常见的导入场景（先拖文件再谈编辑）。
     */
    <div
      className="flex h-[100dvh] bg-[#fafaf8] text-slate-800"
      data-testid="notes-root"
      onDragEnter={(e) => {
        // 只在真的拖着文件时响应，避免拖选文字也触发遮罩
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types?.includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      // 拖拽移动收尾：松手在任意位置都要清掉拖动态
      onDragEnd={() => {
        setDraggingId(null);
        setDragOverId(null);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleDrop(e.dataTransfer.files);
      }}
    >
      {/* ============ 侧边栏 ============ */}
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[276px] flex-col border-r border-slate-200/80 bg-[#f6f5f2] transition-transform md:static md:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-2 px-4 pb-3 pt-4">
          <Link
            to="/"
            aria-label="返回首页"
            title="返回首页"
            className="rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <h1 className="text-[15px] font-semibold tracking-tight text-slate-900">笔记</h1>
          <span className="text-[11.5px] text-slate-400">{notes.length}</span>
          <div className="flex-1" />
          <button
            type="button"
            aria-label="关闭列表"
            onClick={() => setSidebarOpen(false)}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-900/5 md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
          <Button
            size="sm"
            variant="brand"
            className="h-8 rounded-lg px-3 text-[12.5px]"
            title={activeId ? '在「当前页面」下新建子页面' : '新建顶层页面'}
            onClick={() => {
              handleCreate();
              setSidebarOpen(false);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            {activeId ? '新建子页面' : '新建'}
          </Button>
        </div>

        <div className="px-4 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="搜索标题或正文"
              className="h-9 rounded-lg border-slate-200 bg-white pl-8 text-[13px] placeholder:text-slate-400"
            />
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          {listLoading && notes.length === 0 ? (
            <div className="space-y-1 px-1 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-11 animate-pulse rounded-lg bg-slate-900/[0.045]" />
              ))}
            </div>
          ) : treeRows.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] text-slate-500">
                {keyword ? '没有匹配的笔记' : '还没有笔记'}
              </p>
              {!keyword && (
                <button
                  type="button"
                  onClick={() => void createNote(null)}
                  className="mt-2 text-[12.5px] text-indigo-600 hover:underline"
                >
                  新建第一篇
                </button>
              )}
            </div>
          ) : (
            <VirtualList
              count={treeRows.length}
              className="min-h-0 flex-1 overflow-y-auto pr-1"
              data-testid="notes-tree"
              renderRow={(index) => {
                const row = treeRows[index];
                const note = row.note;
                return (
                  <NoteTreeItem
                    row={row}
                    active={note.id === activeId}
                    expanded={!!expanded[note.id]}
                    dragging={draggingId === note.id}
                    dragOver={dragOverId === note.id}
                    invalidTarget={invalidMoveTargets.has(note.id)}
                    onToggle={() => toggleExpanded(note.id)}
                    onOpen={() => {
                      void openNote(note.id);
                      setSidebarOpen(false);
                    }}
                    onAddChild={() => void createNote(note.id)}
                    onDelete={() => void removeNote(note.id)}
                    onMoveRequest={() => setMoveSourceId(note.id)}
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/note-id', note.id);
                      e.dataTransfer.effectAllowed = 'move';
                      setDraggingId(note.id);
                    }}
                    onDragOverRow={(e) => {
                      // 没有拖动源 / 落点是非法目标时不接受 —— 不 preventDefault
                      // 浏览器就不会显示可放置光标，交互上更诚实
                      if (!draggingId || invalidMoveTargets.has(note.id)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (dragOverId !== note.id) setDragOverId(note.id);
                    }}
                    onDragLeaveRow={() => {
                      setDragOverId((cur) => (cur === note.id ? null : cur));
                    }}
                    onDropRow={(e) => {
                      const sourceId = e.dataTransfer.getData('text/note-id');
                      setDraggingId(null);
                      setDragOverId(null);
                      if (!sourceId || sourceId === note.id) return;
                      if (invalidMoveTargets.has(note.id)) return;
                      e.preventDefault();
                      e.stopPropagation();
                      handleMove(sourceId, note.id);
                    }}
                  />
                );
              }}
            />
          )}

          {/* 顶层页面的固定入口：头部按钮在「有打开的页面」时会变成新建子页面，
              这里是唯一能随时建顶层页面的地方 */}
          {!keyword && (
            <button
              type="button"
              onClick={() => void createNote(null)}
              className="mt-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-2 text-[12.5px] text-slate-500 transition-colors hover:bg-slate-900/[0.035] hover:text-slate-700"
            >
              <Plus className="h-3.5 w-3.5" />
              新建顶层页面
            </button>
          )}
        </div>
      </aside>

      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-slate-900/20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ============ 主区 ============ */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 移动端顶栏 */}
        <div className="flex items-center gap-2 border-b border-slate-200/80 bg-white/80 px-3 py-2 md:hidden">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 rounded-lg px-2 text-[13px]"
            onClick={() => setSidebarOpen(true)}
          >
            笔记列表
          </Button>
          <div className="flex-1" />
        </div>

        {detailLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-slate-300" />
          </div>
        ) : !active ? (
          <EmptyState
            onCreate={() => void createNote(null)}
            onImport={() => importRef.current?.click()}
            importing={importing}
          />
        ) : (
          <>
            {/* 工具栏 */}
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white/70 px-4 py-2.5 sm:px-6">
              <div className="flex items-center gap-1.5 rounded-lg bg-slate-100 p-0.5">
                <ModeButton current={mode} value="edit" onClick={setMode} icon={Pencil} label="编辑" />
                <ModeButton current={mode} value="split" onClick={setMode} icon={Columns2} label="分栏" />
                <ModeButton current={mode} value="preview" onClick={setMode} icon={Eye} label="预览" />
              </div>

              <div className="flex-1" />

              <span className="flex items-center gap-1.5 text-[12px] text-slate-400">
                {saveState === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saveState === 'saved' && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                <span className={saveState === 'error' ? 'text-red-600' : ''}>
                  {SAVE_LABEL[saveState]}
                </span>
              </span>

              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-lg px-2.5 text-[12.5px] text-slate-600"
                onClick={() => void togglePin()}
              >
                {active.pinned ? (
                  <>
                    <PinOff className="mr-1 h-3.5 w-3.5" />
                    取消置顶
                  </>
                ) : (
                  <>
                    <Pin className="mr-1 h-3.5 w-3.5" />
                    置顶
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-lg border-slate-200 px-2.5 text-[12.5px]"
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="mr-1 h-3.5 w-3.5" />
                上传
              </Button>
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                accept=".pdf,.md,.txt,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />

              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-lg border-slate-200 px-2.5 text-[12.5px]"
                title={
                  activeId
                    ? '导入的文件会作为当前页面的子页面'
                    : '导入的文件会成为顶层页面'
                }
                disabled={importing}
                onClick={() => importRef.current?.click()}
              >
                {importing ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileUp className="mr-1 h-3.5 w-3.5" />
                )}
                导入
              </Button>
              <input
                ref={importRef}
                type="file"
                multiple
                hidden
                accept=".md,.markdown,.html,.htm,.txt"
                onChange={(e) => {
                  void handleImportPick(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>

            {/* 标题 */}
            <div className="px-4 pt-4 sm:px-6">
              <input
                value={active.title}
                onChange={(e) => editTitle(e.target.value)}
                placeholder="无标题"
                className="w-full border-none bg-transparent text-[22px] font-semibold tracking-tight text-slate-900 outline-none placeholder:text-slate-300"
              />
            </div>

            {/*
              父页面没有正文时，把它当成「目录」来用：
              直接列出子页面标题，点标题即可跳转。
              有正文时就不展示 —— 那时正文才是主体，子页面列表会喧宾夺主。
            */}
            {!active.content.trim() && active.children.length > 0 && (
              <div className="px-4 pt-2 sm:px-6">
                <ChildPages
                  children={active.children}
                  onOpen={(id) => void openNote(id)}
                />
              </div>
            )}

            {/* 编辑 / 预览。拖拽监听已提到页面根容器上，这里不再重复挂 */}
            <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-2 sm:px-6">
              <div
                className={`grid h-full gap-4 ${
                  mode === 'split' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
                }`}
              >
                {mode !== 'preview' && (
                  <textarea
                    value={active.content}
                    onChange={(e) => editContent(e.target.value)}
                    spellCheck={false}
                    placeholder="开始写点什么。支持 Markdown：标题、列表、表格、代码块、任务清单。"
                    className="h-full w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-[13px] leading-[1.75] text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
                  />
                )}

                {mode !== 'edit' && (
                  <div className="h-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
                    {active.content.trim() ? (
                      <MarkdownView content={active.content} />
                    ) : active.children.length > 0 ? (
                      <p className="text-[13px] text-slate-300">
                        这是一个目录页面，子页面已列在上方。在左侧输入内容后这里会显示预览。
                      </p>
                    ) : (
                      <p className="text-[13px] text-slate-300">左侧输入内容后这里会实时预览</p>
                    )}
                  </div>
                )}
              </div>
            </div>

            <AttachmentsPanel
              attachments={active.attachments}
              dragging={dragging}
              onPreview={setPreviewing}
              onDelete={(id) => void removeAttachment(id)}
            />
          </>
        )}
      </main>

      <AttachmentPreview attachment={previewing} onClose={() => setPreviewing(null)} />

      {/*
        「移动到…」选择器。
        拖拽在触屏上不可用，且拖到收起的节点里也没法操作，
        所以除了拖拽之外必须有一个显式入口。
      */}
      <Dialog open={!!moveSourceId} onOpenChange={(v) => !v && setMoveSourceId(null)}>
        <DialogContent className="max-w-md gap-3 p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="text-[15px] font-medium text-slate-800">
              移动「{moveSource?.title || '无标题'}」
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[52vh] overflow-y-auto px-2 pb-2">
            {/* 移到顶层 */}
            <button
              type="button"
              onClick={() => {
                if (moveSourceId) handleMove(moveSourceId, null);
                setMoveSourceId(null);
              }}
              disabled={moveSource ? moveSource.parentId === null : true}
              className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Home className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              移到顶层
              {moveSource?.parentId === null && (
                <span className="ml-auto text-[11px] text-slate-400">当前位置</span>
              )}
            </button>

            <div className="my-1 border-t border-slate-100" />

            <p className="px-2.5 py-1.5 text-[11.5px] text-slate-400">
              选择要移入的页面
            </p>

            {movePickerRows.map((row) => {
              const blocked =
                !!moveSourceId && moveSourceSubtree.has(row.note.id);
              const isCurrent = moveSource?.parentId === row.note.id;
              return (
                <button
                  key={row.note.id}
                  type="button"
                  disabled={blocked || isCurrent}
                  onClick={() => {
                    if (moveSourceId) handleMove(moveSourceId, row.note.id);
                    setMoveSourceId(null);
                  }}
                  title={blocked ? '不能移动到它自己的子页面下' : undefined}
                  className="flex w-full items-center gap-2 rounded-lg py-2 pr-2.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
                  style={{ paddingLeft: 10 + row.depth * 14 }}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="min-w-0 flex-1 truncate">
                    {row.note.title || '无标题'}
                  </span>
                  {isCurrent && (
                    <span className="shrink-0 text-[11px] text-slate-400">当前位置</span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="px-5 pb-4 text-[11.5px] leading-relaxed text-slate-400">
            移入后，该页面下的全部子页面会跟着一起移动。
          </p>
        </DialogContent>
      </Dialog>

      {/*
        整页拖拽遮罩。pointer-events-none 是必须的 ——
        否则遮罩会接住 drop 事件，根容器反而收不到。
      */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-indigo-50/70 backdrop-blur-[2px]">
          <div className="rounded-2xl border-2 border-dashed border-indigo-300 bg-white/95 px-8 py-6 text-center shadow-xl">
            <FileUp className="mx-auto mb-3 h-7 w-7 text-indigo-500" />
            <p className="text-[15px] font-medium text-slate-800">松开即可导入</p>
            <p className="mt-1 text-[12.5px] text-slate-500">
              {active
                ? `md / html / txt 会作为「${active.title || '当前页面'}」的子页面`
                : 'md / html / txt 会成为顶层页面'}
              ，其它文件作为附件
            </p>
          </div>
        </div>
      )}

      {/*
        提示条：错误优先。导入成功这类一次性反馈也走这里，
        免得为了一个「已导入 3 篇」再引一套 toast 依赖。
      */}
      {(error || notice) && (
        <div
          className={`fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-white px-4 py-2.5 text-[13px] shadow-lg ${
            error ? 'border-red-200 text-red-700' : 'border-emerald-200 text-emerald-700'
          }`}
        >
          <span className="max-w-[70vw]">{error || notice}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => (error ? clearError() : clearNotice())}
            className={`rounded p-0.5 ${
              error ? 'text-red-400 hover:text-red-700' : 'text-emerald-400 hover:text-emerald-700'
            }`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 模块顶层的子组件                                                      */
/* ------------------------------------------------------------------ */

const ModeButton: React.FC<{
  current: ViewMode;
  value: ViewMode;
  onClick: (v: ViewMode) => void;
  icon: React.ElementType;
  label: string;
}> = ({ current, value, onClick, icon: Icon, label }) => (
  <button
    type="button"
    onClick={() => onClick(value)}
    aria-pressed={current === value}
    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors ${
      current === value
        ? 'bg-white text-slate-900 shadow-sm'
        : 'text-slate-500 hover:text-slate-700'
    }`}
  >
    <Icon className="h-3.5 w-3.5" />
    {label}
  </button>
);

const EmptyState: React.FC<{
  onCreate: () => void;
  onImport: () => void;
  importing: boolean;
}> = ({ onCreate, onImport, importing }) => (
  <div className="flex flex-1 items-center justify-center px-6">
    <div className="max-w-md text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/[0.04]">
        <FileText className="h-5 w-5 text-slate-400" />
      </div>
      <h2 className="text-[15px] font-medium text-slate-700">还没有打开笔记</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
        从左侧选择一篇，或者新建一篇。
        <br />
        也可以直接把 <span className="font-medium text-slate-600">Markdown / HTML / 文本</span>
        文件拖到页面任意位置导入。
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        <Button variant="brand" size="sm" className="rounded-lg text-[13px]" onClick={onCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          新建笔记
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="rounded-lg border-slate-200 text-[13px]"
          disabled={importing}
          onClick={onImport}
        >
          {importing ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileUp className="mr-1.5 h-3.5 w-3.5" />
          )}
          导入文件
        </Button>
      </div>
    </div>
  </div>
);

export default NotesPage;
