import React from 'react';
import { FileText, Home } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { NoteSummary, NoteTreeRow } from '@/types/note';

/**
 * 「移动到…」选择器。
 *
 * 拖拽在触屏上不可用，且拖到收起的节点里也没法操作，
 * 所以除了拖拽之外必须有一个显式入口。
 */
export const MoveNoteDialog: React.FC<{
  /** 不为 null 即打开 */
  source: NoteSummary | null;
  /** 全部展开后的扁平行，用来渲染树状选项 */
  rows: NoteTreeRow[];
  /** 不能作为落点的 id 集合：自己 + 自己的全部后代（会成环） */
  blocked: Set<string>;
  onMove: (id: string, parentId: string | null) => void;
  onClose: () => void;
}> = ({ source, rows, blocked, onMove, onClose }) => (
  <Dialog open={!!source} onOpenChange={(v) => !v && onClose()}>
    <DialogContent className="max-w-md gap-3 p-0">
      <DialogHeader className="px-5 pt-5">
        <DialogTitle className="text-[15px] font-medium text-slate-800">
          移动「{source?.title || '无标题'}」
        </DialogTitle>
      </DialogHeader>

      <div className="max-h-[52vh] overflow-y-auto px-2 pb-2">
        {/* 移到顶层 */}
        <button
          type="button"
          onClick={() => {
            if (source) onMove(source.id, null);
            onClose();
          }}
          disabled={source ? source.parentId === null : true}
          className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Home className="h-3.5 w-3.5 shrink-0 text-slate-400" />
          移到顶层
          {source?.parentId === null && (
            <span className="ml-auto text-[11px] text-slate-400">当前位置</span>
          )}
        </button>

        <div className="my-1 border-t border-slate-100" />

        <p className="px-2.5 py-1.5 text-[11.5px] text-slate-400">选择要移入的页面</p>

        {rows.map((row) => {
          const isBlocked = !!source && blocked.has(row.note.id);
          const isCurrent = source?.parentId === row.note.id;
          return (
            <button
              key={row.note.id}
              type="button"
              disabled={isBlocked || isCurrent}
              onClick={() => {
                if (source) onMove(source.id, row.note.id);
                onClose();
              }}
              title={isBlocked ? '不能移动到它自己的子页面下' : undefined}
              className="flex w-full items-center gap-2 rounded-lg py-2 pr-2.5 text-left text-[13px] text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent"
              style={{ paddingLeft: 10 + row.depth * 14 }}
            >
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1 truncate">{row.note.title || '无标题'}</span>
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
);
