import React from 'react';
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
} from '@milkdown/prose/tables';
import type { EditorState } from '@milkdown/prose/state';

/**
 * 表格结构操作。
 *
 * 命令签名统一是 `(state, dispatch?, view?) => boolean`，
 * 来自 prosemirror-tables（`@milkdown/prose/tables` 是它的转发）。
 *
 * 不用 gfm preset 的 `*Command`：那套要经过 `commandsCtx`，
 * 而删行删列它根本没提供（只有 selectRow + deleteSelectedCells 的组合，
 * 两次 dispatch 之间选区已经变了，容易删错行）。
 */
export type TableCommand = (
  state: EditorState,
  dispatch?: (tr: EditorState['tr']) => void,
  view?: unknown,
) => boolean;

interface Action {
  key: string;
  label: string;
  hint: string;
  cmd: TableCommand;
  danger?: boolean;
  /** 与上一个按钮之间画一条分隔线 */
  groupStart?: boolean;
}

const ACTIONS: Action[] = [
  { key: 'row-before', label: '↑ 行', hint: '在上方插入一行', cmd: addRowBefore },
  { key: 'row-after', label: '↓ 行', hint: '在下方插入一行', cmd: addRowAfter },
  {
    key: 'col-before',
    label: '← 列',
    hint: '在左侧插入一列',
    cmd: addColumnBefore,
    groupStart: true,
  },
  { key: 'col-after', label: '→ 列', hint: '在右侧插入一列', cmd: addColumnAfter },
  {
    key: 'row-del',
    label: '删行',
    hint: '删除当前行',
    cmd: deleteRow,
    danger: true,
    groupStart: true,
  },
  { key: 'col-del', label: '删列', hint: '删除当前列', cmd: deleteColumn, danger: true },
  { key: 'table-del', label: '删表', hint: '删除整张表格', cmd: deleteTable, danger: true },
];

/**
 * 编辑区顶部的表格工具条。
 *
 * **常驻**，内容随上下文切换：
 * - 光标不在表格里 → 只有一个「+ 表格」
 * - 光标在表格里   → 七个结构操作
 *
 * 为什么常驻：编辑器原本没有任何「插入表格」的入口，用户只能手打
 * Markdown 表格。gfm 其实有个输入规则（输入 `|3x2| ` 自动建表），
 * 但没人猜得到这种语法 —— 等于没有。
 *
 * 为什么粘在顶部而不是「跟着表格走」：
 * 跟随要在每次滚动 / 输入时用 `coordsAtPos` 重算位置，还得处理表格贴边、
 * 浮层超出视口 —— 为几个按钮不值。粘顶的做法和 Notion 的浮动条观感接近，
 * 实现只有一个 sticky。
 */
export const TableToolbar: React.FC<{
  inTable: boolean;
  onCommand: (cmd: TableCommand) => void;
  onInsertTable: () => void;
}> = ({ inTable, onCommand, onInsertTable }) => (
  <div
    className="table-toolbar"
    data-mode={inTable ? 'table' : 'idle'}
    role="toolbar"
    aria-label="表格操作"
  >
    {!inTable && (
      <button
        type="button"
        className="table-toolbar-btn"
        title="插入一个 3×3 表格"
        // 防止点按钮时编辑器失焦、光标位置丢失
        onMouseDown={(e) => e.preventDefault()}
        onClick={onInsertTable}
      >
        ⊞ 表格
      </button>
    )}

    {inTable &&
      ACTIONS.map((action) => (
        <React.Fragment key={action.key}>
          {action.groupStart && <span className="table-toolbar-divider" aria-hidden />}
          <button
            type="button"
            className="table-toolbar-btn"
            data-danger={action.danger ? 'true' : undefined}
            title={action.hint}
            // 同上：否则点按钮时编辑器失焦、选区丢失，
            // 命令执行时找不到「当前单元格」
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onCommand(action.cmd)}
          >
            {action.label}
          </button>
        </React.Fragment>
      ))}
  </div>
);
