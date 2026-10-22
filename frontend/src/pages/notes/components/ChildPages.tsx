import React from 'react';
import { ChevronRight, FileText, Pin } from 'lucide-react';
import type { NoteChildSummary } from '@/types/note';
import { formatTime } from '../lib/format';

/**
 * 子页面列表（父页面内容为空时展示）。
 *
 * 父页面没有正文时把它当「目录」用：直接列出子页面标题，点标题跳转。
 * 有正文时不展示 —— 那时正文才是主体，子页面列表会喧宾夺主。
 */
export const ChildPages: React.FC<{
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
