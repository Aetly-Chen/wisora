import React from 'react';
import type { ViewMode } from '../constants';

/** 「编辑 / 分栏 / 预览」三选一按钮 */
export const ModeButton: React.FC<{
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
