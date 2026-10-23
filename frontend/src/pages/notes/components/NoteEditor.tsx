import React, { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import {
  Check,
  Code2,
  Eye,
  FileUp,
  Loader2,
  Pencil,
  Pin,
  PinOff,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/MarkdownView';
import { useNotesStore } from '@/stores/useNotesStore';
import type { AttachmentMeta, NoteDetail, SaveState } from '@/types/note';
import { PREVIEW_MAX_CHARS, SAVE_LABEL, type ViewMode } from '../constants';
import { extractHeadings } from '../lib/headings';
import { ModeButton } from './ModeButton';
import { ChildPages } from './ChildPages';
import { AttachmentsPanel } from './AttachmentsPanel';
import { OutlinePanel } from './OutlinePanel';

/**
 * 编辑器懒加载。
 *
 * Milkdown + ProseMirror 让 notes 这个 chunk 从 103KB 涨到 562KB（gzip 34→173KB）。
 * 它只在「打开一篇笔记」时才用得上，所以拆成独立 chunk：
 * 先让树和外壳出来，编辑器随后补上。
 */
const MarkdownEditor = React.lazy(() =>
  import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })),
);

/**
 * 编辑区：工具栏 + 标题 + 编辑/预览 + 附件面板。
 *
 * 只负责「这一篇怎么显示、怎么改」，保存策略在 store 里（debounce + flush），
 * 树与导航在 `NoteSidebar` 里 —— 页面组件退化成纯组装。
 */
export const NoteEditor: React.FC<{
  note: NoteDetail;
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  saveState: SaveState;
  /** 大文档下用户手动放行预览 */
  forcePreview: boolean;
  onForcePreview: () => void;
  onTogglePin: () => void;
  /** 附件上传（工具栏「上传」按钮与拖拽都走这里） */
  onUploadFiles: (files: FileList | null) => void;
  /** 触发导入用的 file input（那个 input 常驻在页面根组件里） */
  onSelectImport: () => void;
  importing: boolean;
  /** 当前是否选中了目录 —— 只影响导入按钮的提示文案 */
  hasSelectedDir: boolean;
  /** 拖拽文件时的附件区高亮（页面级拖拽状态） */
  dragging: boolean;
  onPreviewAttachment: (a: AttachmentMeta) => void;
  onRemoveAttachment: (id: string) => void;
  onOpenNote: (id: string) => void;
}> = ({
  note,
  mode,
  onModeChange,
  saveState,
  forcePreview,
  onForcePreview,
  onTogglePin,
  onUploadFiles,
  onSelectImport,
  importing,
  hasSelectedDir,
  dragging,
  onPreviewAttachment,
  onRemoveAttachment,
  onOpenNote,
}) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const sourceRef = useRef<HTMLTextAreaElement>(null);
  /** 包住「编辑器 / 源码 / 预览」三个面板，大纲跳转在它里面找标题元素 */
  const contentRef = useRef<HTMLDivElement>(null);
  const { editTitle, editContent } = useNotesStore();

  /** 预览用的延迟值：输入时优先保证编辑区跟手 */
  const deferredContent = useDeferredValue(note.content);

  const headings = useMemo(() => extractHeadings(note.content), [note.content]);

  /*
   * Ctrl+/ 在「所见即所得」和「源码」之间切。
   *
   * 它是逃生通道：编辑器万一有奇怪的 Markdown 行为，用户得能立刻看到原文，
   * 而不是被迫相信渲染结果。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        onModeChange(mode === 'source' ? 'edit' : 'source');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, onModeChange]);

  /**
   * 大纲跳转。
   *
   * 三种模式定位方式不同：
   * - 所见即所得 / 预览：DOM 里第 N 个 h1~h6
   * - 源码：textarea 没有「滚到第 N 行」的 API，只能按行比例估算 + 选中该行
   */
  const jumpToHeading = (index: number) => {
    const h = headings[index];
    if (!h) return;

    if (mode === 'source' && sourceRef.current) {
      const ta = sourceRef.current;
      ta.focus();
      ta.setSelectionRange(h.offset, h.offset + 1);
      const totalLines = ta.value.split('\n').length;
      const ratio = h.line / Math.max(totalLines - 1, 1);
      ta.scrollTop = Math.max(0, ratio * ta.scrollHeight - ta.clientHeight / 3);
      return;
    }

    const el = contentRef.current?.querySelectorAll('h1,h2,h3,h4,h5,h6')[index] as
      | HTMLElement
      | undefined;
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  return (
    <>
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white/70 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-1.5 rounded-lg bg-slate-100 p-0.5">
          <ModeButton current={mode} value="edit" onClick={onModeChange} icon={Pencil} label="编辑" />
          <ModeButton current={mode} value="source" onClick={onModeChange} icon={Code2} label="源码" />
          <ModeButton current={mode} value="preview" onClick={onModeChange} icon={Eye} label="预览" />
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
          onClick={onTogglePin}
        >
          {note.pinned ? (
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
            onUploadFiles(e.target.files);
            e.target.value = '';
          }}
        />

        <Button
          variant="outline"
          size="sm"
          className="h-8 rounded-lg border-slate-200 px-2.5 text-[12.5px]"
          title={hasSelectedDir ? '导入的文件会作为选中目录的子页面' : '导入的文件会成为一级目录'}
          disabled={importing}
          onClick={onSelectImport}
        >
          {importing ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileUp className="mr-1 h-3.5 w-3.5" />
          )}
          导入
        </Button>
      </div>

      {/* 标题 */}
      <div className="px-4 pt-4 sm:px-6">
        <input
          value={note.title}
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
      {!note.content.trim() && note.children.length > 0 && (
        <div className="px-4 pt-2 sm:px-6">
          <ChildPages children={note.children} onOpen={onOpenNote} />
        </div>
      )}

      {/* 编辑 / 源码 / 预览 + 大纲。拖拽监听已提到页面根容器上，这里不再重复挂 */}
      <div className="flex min-h-0 flex-1 gap-4 px-4 pb-4 pt-2 sm:px-6">
        <div ref={contentRef} className="min-w-0 flex-1">
          {mode === 'edit' && (
            /* 单栏居中、阅读宽度 760px —— 全宽长行读起来很累 */
            /*
             * key={note.id} 是必需的：Milkdown 只在挂载时读一次初始值，
             * 换笔记必须强制重挂载，否则会继续显示上一篇的内容。
             * 用 key 而不是「把新 content 回灌编辑器」，是因为回灌会让
             * 每次输入后光标跳位（编辑 → store → 新值 → 回灌 形成环）。
             */
            <div className="mx-auto h-full max-w-[760px]">
              <React.Suspense
                fallback={
                  <div className="flex h-full items-center justify-center rounded-xl border border-slate-200 bg-white text-[13px] text-slate-400">
                    编辑器加载中…
                  </div>
                }
              >
                <MarkdownEditor
                  key={note.id}
                  initialValue={note.content}
                  onChange={editContent}
                  noteId={note.id}
                />
              </React.Suspense>
            </div>
          )}

          {mode === 'source' && (
            /* 逃生通道：怀疑编辑器改坏了 Markdown 时，看这里 */
            <textarea
              ref={sourceRef}
              value={note.content}
              onChange={(e) => editContent(e.target.value)}
              spellCheck={false}
              placeholder="原始 Markdown。按 Ctrl+/ 回到编辑模式。"
              className="h-full w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-[13px] leading-[1.75] text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          )}

          {mode === 'preview' && (
            <div className="mx-auto h-full max-w-[760px] overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
              {!note.content.trim() ? (
                note.children.length > 0 ? (
                  <p className="text-[13px] text-slate-300">
                    这是一个目录页面，子页面已列在上方。在编辑区输入内容后这里会显示预览。
                  </p>
                ) : (
                  <p className="text-[13px] text-slate-300">编辑区输入内容后这里会实时预览</p>
                )
              ) : note.content.length > PREVIEW_MAX_CHARS && !forcePreview ? (
                <div className="py-6 text-center">
                  <p className="text-[13px] text-slate-500">
                    正文约 {Math.round(note.content.length / 1024)} KB，
                    已暂停实时预览以保证编辑流畅
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3 rounded-lg border-slate-200 text-[12.5px]"
                    onClick={onForcePreview}
                  >
                    仍然渲染预览
                  </Button>
                </div>
              ) : (
                /* useDeferredValue：正文变化时先让输入框保持响应，
                   预览的解析与渲染以较低优先级进行 */
                <MarkdownView content={deferredContent} />
              )}
            </div>
          )}
        </div>

        {/*
          大纲栏。窄屏隐藏 —— 手机上编辑区本来就窄，
          再挤一列会让正文只剩几十个字符宽。
        */}
        <OutlinePanel
          content={note.content}
          onJump={jumpToHeading}
          className="hidden w-[164px] shrink-0 overflow-y-auto border-l border-slate-200/70 py-1 pl-2 xl:block"
        />
      </div>

      <AttachmentsPanel
        attachments={note.attachments}
        dragging={dragging}
        onPreview={onPreviewAttachment}
        onDelete={onRemoveAttachment}
      />
    </>
  );
};
