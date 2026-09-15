import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft,
  Check,
  Columns2,
  Eye,
  FileText,
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
import { useNotesStore } from '@/stores/useNotesStore';
import { downloadAttachment, fetchAttachmentBlob } from '@/request/notes';
import type { AttachmentMeta, NoteSummary } from '@/types/note';

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
/* 侧边栏列表项                                                          */
/* ------------------------------------------------------------------ */

const NoteListItem: React.FC<{
  note: NoteSummary;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}> = ({ note, active, onOpen, onDelete }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={onOpen}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onOpen();
      }
    }}
    className={`group relative cursor-pointer rounded-lg px-3 py-2.5 transition-colors ${
      active ? 'bg-white shadow-sm ring-1 ring-slate-900/5' : 'hover:bg-slate-900/[0.035]'
    }`}
  >
    <div className="flex items-center gap-2">
      {note.pinned && <Pin className="h-3 w-3 shrink-0 text-indigo-500" />}
      <span className="truncate text-[13.5px] font-medium text-slate-800">
        {note.title || '无标题'}
      </span>
    </div>
    <div className="mt-0.5 text-[11.5px] text-slate-400">{formatTime(note.updatedAt)}</div>

    <button
      type="button"
      aria-label={`删除 ${note.title}`}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      className="absolute right-2 top-1/2 hidden -translate-y-1/2 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600 group-hover:block"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
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
        {dragging ? '松开即可上传' : '把 PDF、图片或 Markdown 拖到这里，或点上方「上传」'}
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
    active,
    activeId,
    detailLoading,
    saveState,
    error,
    loadNotes,
    setKeyword,
    openNote,
    createNote,
    editTitle,
    editContent,
    flush,
    togglePin,
    removeNote,
    uploadFile,
    removeAttachment,
    clearError,
  } = useNotesStore();

  const [mode, setMode] = useState<ViewMode>('split');
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState<AttachmentMeta | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const sortedNotes = useMemo(() => notes, [notes]);

  const handleFiles = (files: FileList | null) => {
    if (!files?.length) return;
    Array.from(files).forEach((f) => void uploadFile(f));
  };

  return (
    <div className="flex h-[100dvh] bg-[#fafaf8] text-slate-800">
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
            onClick={() => {
              void createNote();
              setSidebarOpen(false);
            }}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            新建
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

        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {listLoading && notes.length === 0 ? (
            <div className="space-y-1.5 px-1 pt-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[52px] animate-pulse rounded-lg bg-slate-900/[0.045]" />
              ))}
            </div>
          ) : sortedNotes.length === 0 ? (
            <div className="px-3 py-10 text-center">
              <p className="text-[13px] text-slate-500">
                {keyword ? '没有匹配的笔记' : '还没有笔记'}
              </p>
              {!keyword && (
                <button
                  type="button"
                  onClick={() => void createNote()}
                  className="mt-2 text-[12.5px] text-indigo-600 hover:underline"
                >
                  新建第一篇
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {sortedNotes.map((n) => (
                <NoteListItem
                  key={n.id}
                  note={n}
                  active={n.id === activeId}
                  onOpen={() => {
                    void openNote(n.id);
                    setSidebarOpen(false);
                  }}
                  onDelete={() => void removeNote(n.id)}
                />
              ))}
            </div>
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
          <EmptyState onCreate={() => void createNote()} />
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

            {/* 编辑 / 预览 */}
            <div
              className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-2 sm:px-6"
              onDragEnter={(e) => {
                e.preventDefault();
                dragDepth.current += 1;
                setDragging(true);
              }}
              onDragOver={(e) => e.preventDefault()}
              onDragLeave={() => {
                dragDepth.current -= 1;
                if (dragDepth.current <= 0) {
                  dragDepth.current = 0;
                  setDragging(false);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                dragDepth.current = 0;
                setDragging(false);
                handleFiles(e.dataTransfer.files);
              }}
            >
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

      {error && (
        <div className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-red-200 bg-white px-4 py-2.5 text-[13px] text-red-700 shadow-lg">
          <span>{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="rounded p-0.5 text-red-400 hover:text-red-700"
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

const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="flex flex-1 items-center justify-center px-6">
    <div className="max-w-sm text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-900/[0.04]">
        <FileText className="h-5 w-5 text-slate-400" />
      </div>
      <h2 className="text-[15px] font-medium text-slate-700">还没有打开笔记</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-500">
        从左侧选择一篇，或者新建一篇。支持 Markdown 写作，PDF 与图片可以直接拖进来。
      </p>
      <Button
        variant="brand"
        size="sm"
        className="mt-5 rounded-lg text-[13px]"
        onClick={onCreate}
      >
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        新建笔记
      </Button>
    </div>
  </div>
);

export default NotesPage;
