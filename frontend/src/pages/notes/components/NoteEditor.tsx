import React, { useDeferredValue, useRef } from 'react';
import {
  Check,
  Columns2,
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
import { ModeButton } from './ModeButton';
import { ChildPages } from './ChildPages';
import { AttachmentsPanel } from './AttachmentsPanel';

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
  const { editTitle, editContent } = useNotesStore();

  /** 预览用的延迟值：输入时优先保证编辑区跟手 */
  const deferredContent = useDeferredValue(note.content);

  return (
    <>
      {/* 工具栏 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white/70 px-4 py-2.5 sm:px-6">
        <div className="flex items-center gap-1.5 rounded-lg bg-slate-100 p-0.5">
          <ModeButton current={mode} value="edit" onClick={onModeChange} icon={Pencil} label="编辑" />
          <ModeButton current={mode} value="split" onClick={onModeChange} icon={Columns2} label="分栏" />
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

      {/* 编辑 / 预览。拖拽监听已提到页面根容器上，这里不再重复挂 */}
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-4 pt-2 sm:px-6">
        <div
          className={`grid h-full gap-4 ${
            mode === 'split' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'
          }`}
        >
          {mode !== 'preview' && (
            <textarea
              value={note.content}
              onChange={(e) => editContent(e.target.value)}
              spellCheck={false}
              placeholder="开始写点什么。支持 Markdown：标题、列表、表格、代码块、任务清单。"
              className="h-full w-full resize-none rounded-xl border border-slate-200 bg-white p-4 font-mono text-[13px] leading-[1.75] text-slate-800 outline-none transition-colors placeholder:text-slate-300 focus:border-indigo-300 focus:ring-2 focus:ring-indigo-100"
            />
          )}

          {mode !== 'edit' && (
            <div className="h-full overflow-y-auto rounded-xl border border-slate-200 bg-white p-4">
              {!note.content.trim() ? (
                note.children.length > 0 ? (
                  <p className="text-[13px] text-slate-300">
                    这是一个目录页面，子页面已列在上方。在左侧输入内容后这里会显示预览。
                  </p>
                ) : (
                  <p className="text-[13px] text-slate-300">左侧输入内容后这里会实时预览</p>
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
