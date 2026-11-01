import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';

/**
 * `Ctrl+F` 的查找替换条。
 *
 * 常驻在编辑区顶部（和表格工具条同一个位置思路），命中数用 `n / m` 表示；
 * 没有命中时显示 `0 / 0`，替换按钮自动禁用 —— 比点了没反应好。
 *
 * 键盘在这里全部接管：Enter 下一个、Shift+Enter 上一个、Esc 关闭。
 * 编辑器自己的键盘处理不会收到这些键（输入框在编辑器外面）。
 */
export const FindBar: React.FC<{
  query: string;
  replacement: string;
  /** 命中总数 */
  total: number;
  /** 当前第几个（0 起，-1 表示无） */
  current: number;
  onQueryChange: (v: string) => void;
  onReplacementChange: (v: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
}> = ({
  query,
  replacement,
  total,
  current,
  onQueryChange,
  onReplacementChange,
  onPrev,
  onNext,
  onReplaceOne,
  onReplaceAll,
  onClose,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  // 一打开就聚焦，用户可以直接打字
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  };

  return (
    <div
      className="find-bar"
      role="search"
      aria-label="查找替换"
      onKeyDown={onKeyDown}
    >
      <div className="find-bar-row">
        <Search size={13} className="find-bar-icon" aria-hidden />
        <input
          ref={inputRef}
          className="find-bar-input"
          value={query}
          placeholder="查找"
          onChange={(e) => onQueryChange(e.target.value)}
          aria-label="查找内容"
        />
        <span className="find-bar-count" aria-live="polite">
          {total > 0 ? `${current + 1} / ${total}` : '0 / 0'}
        </span>
        <button
          type="button"
          className="find-bar-btn"
          title="上一个（Shift+Enter）"
          onClick={onPrev}
          disabled={total === 0}
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          className="find-bar-btn"
          title="下一个（Enter）"
          onClick={onNext}
          disabled={total === 0}
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="find-bar-btn"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>

      <div className="find-bar-row">
        <input
          className="find-bar-input"
          value={replacement}
          placeholder="替换为"
          onChange={(e) => onReplacementChange(e.target.value)}
          aria-label="替换为"
        />
        <button
          type="button"
          className="find-bar-text-btn"
          onClick={onReplaceOne}
          disabled={total === 0}
        >
          替换
        </button>
        <button
          type="button"
          className="find-bar-text-btn"
          onClick={onReplaceAll}
          disabled={total === 0}
        >
          全部替换
        </button>
      </div>
    </div>
  );
};
