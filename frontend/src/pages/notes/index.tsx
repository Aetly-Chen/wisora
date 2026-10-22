import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileUp, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ShareToFriendDialog } from '@/components/chat/ShareToFriendDialog';
import { useNotesStore } from '@/stores/useNotesStore';
import type { AttachmentMeta } from '@/types/note';
import type { SharedNotePayload } from '@/types/chat';
import type { ViewMode } from './constants';
import { NoteSidebar } from './components/NoteSidebar';
import { NoteEditor } from './components/NoteEditor';
import { AttachmentPreview } from './components/AttachmentPreview';
import { EmptyState } from './components/EmptyState';

/**
 * 笔记页：只做「组装 + 页面级副作用」。
 *
 * 三块职责已经拆开：
 * - `NoteSidebar`   —— 树、搜索、拖拽移动、右键菜单（自带相关状态）
 * - `NoteEditor`    —— 工具栏、标题、编辑/预览、附件区
 * - 本组件          —— 整页拖拽导入、深链、空状态、分享弹窗、提示条
 *
 * 拆分动机：换编辑器（textarea → 所见即所得）时，改动应该只落在 `NoteEditor`，
 * 而不是在一个 1200 行的文件里翻找。
 */
const NotesPage: React.FC = () => {
  const {
    notes,
    keyword,
    selectedId,
    active,
    activeId,
    detailLoading,
    saveState,
    error,
    notice,
    loadNotes,
    flush,
    openNote,
    createNote,
    togglePin,
    removeAttachment,
    uploadFile,
    importFiles,
    clearError,
    clearNotice,
  } = useNotesStore();

  const [mode, setMode] = useState<ViewMode>('edit');
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState<AttachmentMeta | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  /** 大文档下用户手动放行预览 */
  const [forcePreview, setForcePreview] = useState(false);
  /** 分享弹窗的目标快照；null 表示关闭 */
  const [shareTarget, setShareTarget] = useState<SharedNotePayload | null>(null);
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

  // 换了一篇就收回「仍然渲染」的放行，避免上一篇的选择影响下一篇
  useEffect(() => {
    setForcePreview(false);
  }, [activeId]);

  /*
   * 深链：/notes?note=<id> 直接打开指定笔记。
   *
   * 聊天里收到分享卡片时点「打开」就是走这里。
   * 读完立刻把参数清掉，否则用户在里面切到别的笔记后刷新页面，
   * 又会被拽回分享的那一篇。
   */
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    const noteId = searchParams.get('note');
    if (!noteId) return;

    void openNote(noteId, { force: true });

    const next = new URLSearchParams(searchParams);
    next.delete('note');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openNote]);

  /** 遮罩文案要用的选中目录对象 */
  const selected = selectedId ? notes.find((n) => n.id === selectedId) : undefined;

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
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        handleDrop(e.dataTransfer.files);
      }}
    >
      <NoteSidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onShare={setShareTarget}
      />

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
          <NoteEditor
            note={active}
            mode={mode}
            onModeChange={setMode}
            saveState={saveState}
            forcePreview={forcePreview}
            onForcePreview={() => setForcePreview(true)}
            onTogglePin={() => void togglePin()}
            onUploadFiles={handleFiles}
            onSelectImport={() => importRef.current?.click()}
            importing={importing}
            hasSelectedDir={!!selectedId}
            dragging={dragging}
            onPreviewAttachment={setPreviewing}
            onRemoveAttachment={(id) => void removeAttachment(id)}
            onOpenNote={(id) => void openNote(id)}
          />
        )}
      </main>

      <AttachmentPreview attachment={previewing} onClose={() => setPreviewing(null)} />

      {/*
        分享给好友。传的是笔记快照而不是 id：
        弹窗不该依赖笔记页的状态，也方便同一篇被反复分享。
      */}
      <ShareToFriendDialog target={shareTarget} onClose={() => setShareTarget(null)} />

      {/*
        导入用的 file input 必须常驻。
        原先它渲染在工具栏内部，而工具栏只在「已打开笔记」时才渲染，
        于是空状态那个「导入文件」按钮点了等于没点 ——
        ref 指向 null，click() 静默失败。
      */}
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
              {selected
                ? `md / html / txt 会作为「${selected.title || '选中目录'}」的子页面`
                : 'md / html / txt 会成为一级目录'}
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

export default NotesPage;
