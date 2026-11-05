import React from 'react';
import { Link2 } from 'lucide-react';
import type { NoteBacklink } from '@/types/note';

/**
 * 反向链接区：列出「哪些笔记里写了 `[[这一篇的标题]]`」。
 *
 * 只在有引用时出现 —— 每篇都挂一条空状态会把附件区挤下去，而真正需要
 * 反向链接的人自然会先写出第一个 `[[…]]`。
 */
export const BacklinksPanel: React.FC<{
  backlinks: NoteBacklink[];
  onOpen: (id: string) => void;
}> = ({ backlinks, onOpen }) => {
  if (backlinks.length === 0) return null;

  return (
    <div className="border-t border-slate-200/80 px-4 py-3 sm:px-6">
      <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-slate-400">
        <Link2 className="h-3.5 w-3.5" />
        反向链接
        <span className="text-slate-300">{backlinks.length}</span>
      </div>

      <ul className="space-y-1.5">
        {backlinks.map((link) => (
          <li key={link.id}>
            <button
              type="button"
              onClick={() => onOpen(link.id)}
              className="group flex w-full items-baseline gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-slate-50"
              title={`打开「${link.title}」`}
            >
              <span className="shrink-0 text-[12.5px] font-medium text-slate-700 group-hover:text-indigo-700">
                {link.title || '无标题'}
              </span>
              {/* 摘要压一行，太长就省略 —— 这里只是帮人回忆起是哪一句 */}
              <span className="min-w-0 flex-1 truncate text-[12px] text-slate-400">
                {link.snippet}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
};
