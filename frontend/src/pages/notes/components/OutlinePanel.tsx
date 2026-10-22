import React, { useMemo } from 'react';
import { extractHeadings, headingIndent } from '../lib/headings';

/**
 * 大纲栏：按标题生成，点击滚动到对应位置。
 *
 * 定位方式随编辑模式变 —— 所见即所得和预览里是 DOM 元素，
 * 源码模式里是 textarea 的行偏移。所以这里不自己找元素，
 * 只管「点了第几个标题」，由父级按当前模式去滚。
 */
export const OutlinePanel: React.FC<{
  content: string;
  /** 点击第 index 个标题（0 起） */
  onJump: (index: number) => void;
  className?: string;
}> = ({ content, onJump, className }) => {
  const headings = useMemo(() => extractHeadings(content), [content]);

  if (headings.length === 0) {
    return (
      <aside className={className}>
        <p className="px-2 text-[11px] text-slate-400">大纲</p>
        <p className="mt-2 px-2 text-[12px] leading-relaxed text-slate-300">
          用 ## 写小标题后，这里会自动生成目录
        </p>
      </aside>
    );
  }

  const baseLevel = Math.min(...headings.map((h) => h.level));

  return (
    <aside className={className}>
      <p className="mb-2 px-2 text-[11px] text-slate-400">大纲</p>
      <nav className="flex flex-col">
        {headings.map((h, i) => (
          <button
            key={`${h.line}-${h.text}`}
            type="button"
            onClick={() => onJump(i)}
            title={h.text}
            className="truncate rounded-md py-1 pr-2 text-left text-[12px] leading-[1.45] text-slate-500 transition-colors hover:bg-slate-900/[0.04] hover:text-slate-800"
            style={{ paddingLeft: 8 + headingIndent(h.level, baseLevel) }}
          >
            {h.text}
          </button>
        ))}
      </nav>
    </aside>
  );
};
