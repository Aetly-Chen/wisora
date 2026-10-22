import React from 'react';
import { ChevronRight, FolderInput, Pin, Plus, Trash2 } from 'lucide-react';
import type { NoteTreeRow } from '@/types/note';
import { formatTime } from '../lib/format';

/**
 * 侧边栏目录树的一行。
 *
 * 纯展示 + 事件回调，不持有状态 —— 拖拽状态由父级 `NoteSidebar` 掌管，
 * 因为「谁在拖、拖到谁上面」是跨行的信息。
 */
export const NoteTreeItem: React.FC<{
  row: NoteTreeRow;
  active: boolean;
  expanded: boolean;
  /** 正在被拖动的那一行 */
  dragging: boolean;
  /** 当前拖到这一行上方 */
  dragOver: boolean;
  /** 不能作为落点（自己或自己的后代） */
  invalidTarget: boolean;
  /** 用户选中的目录 —— 新建/导入会作为它的子页面 */
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onAddChild: () => void;
  onDelete: () => void;
  onMoveRequest: () => void;
  /** 右键菜单。除了行内 hover 按钮，右键是第二条操作入口 */
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragOverRow: (e: React.DragEvent) => void;
  onDragLeaveRow: () => void;
  onDropRow: (e: React.DragEvent) => void;
}> = ({
  row,
  active,
  expanded,
  dragging,
  dragOver,
  invalidTarget,
  selected,
  onOpen,
  onToggle,
  onAddChild,
  onDelete,
  onMoveRequest,
  onContextMenu,
  onDragStart,
  onDragOverRow,
  onDragLeaveRow,
  onDropRow,
}) => {
  const { note, depth, hasChildren } = row;

  return (
    <div
      // 整行可拖：拖到别的行上即为「移动」
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragLeaveRow}
      onDragOver={onDragOverRow}
      onDragLeave={onDragLeaveRow}
      onDrop={onDropRow}
      onContextMenu={onContextMenu}
      className={`group flex h-full items-center rounded-lg pr-1 transition-colors ${
        dragging ? 'opacity-40' : ''
      } ${
        dragOver && !invalidTarget
          ? 'bg-indigo-50 ring-2 ring-inset ring-indigo-400'
          : active
            ? 'bg-white shadow-sm ring-1 ring-slate-900/5'
            : 'hover:bg-slate-900/[0.035]'
      }`}
      // 选中标记用 inset 阴影而不是左边框：加边框会让内容右移 2px，
      // 同一层的标题就对不齐了
      title={selected ? '已选中：新建与导入会作为它的子页面' : undefined}
      style={{
        paddingLeft: 6 + depth * 14,
        boxShadow: selected ? 'inset 2px 0 0 0 #818cf8' : undefined,
      }}
      data-note-row={note.id}
    >
      {/*
        展开箭头。没有子页面时用等宽占位 —— 否则同一层的标题
        会因有无子页面而左右错开一格，看着像没对齐。
      */}
      {hasChildren ? (
        <button
          type="button"
          aria-label={expanded ? `收起「${note.title}」的子页面` : `展开「${note.title}」的子页面`}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="mr-0.5 shrink-0 rounded p-0.5 text-slate-400 transition-colors hover:bg-slate-900/5 hover:text-slate-600"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </button>
      ) : (
        <span className="mr-0.5 h-4 w-4 shrink-0" aria-hidden />
      )}

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-2 text-left"
      >
        {note.pinned && <Pin className="h-3 w-3 shrink-0 text-indigo-500" />}
        <span className="truncate text-[13.5px] font-medium text-slate-800">
          {note.title || '无标题'}
        </span>
      </button>

      {/* 平时显示更新时间，hover 时让位给操作按钮 —— 一行放不下两者 */}
      <span className="shrink-0 text-[10.5px] text-slate-400 group-hover:hidden">
        {formatTime(note.updatedAt)}
      </span>

      <div className="hidden shrink-0 items-center group-hover:flex">
        <button
          type="button"
          aria-label={`移动「${note.title}」`}
          title="移动到…（也可以直接把这一行拖到别的页面上）"
          onClick={onMoveRequest}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
        >
          <FolderInput className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`在「${note.title}」下新建子页面`}
          title="新建子页面"
          onClick={onAddChild}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-indigo-50 hover:text-indigo-600"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${note.title}`}
          title={hasChildren ? '删除该页面及其全部子页面' : '删除'}
          onClick={onDelete}
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-600"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
};
