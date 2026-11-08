import React, { useEffect, useMemo, useRef } from 'react';

/**
 * 菜单项的最小形状。
 *
 * 刻意不直接吃 `SlashItemDef`：这个菜单现在同时服务「`/` 插入命令」和
 * 「`[[` 选笔记」两条路，两者只有 label/hint 是共通的。
 */
export interface MenuItem {
  key: string;
  label: string;
  hint: string;
}

/**
 * `/` 或 `[[` 触发的浮层菜单（同一个组件，两条触发路径）。
 *
 * 定位用 `position: fixed`：坐标直接来自 `coordsAtPos`（视口坐标系），
 * 不用再折算外壳的滚动偏移。代价是页面滚动时菜单不会跟着走 ——
 * 所以外层在滚动时会把它关掉（见 MarkdownEditor 的 scroll 监听）。
 */
export const SlashMenu: React.FC<{
  /** 锚点视口坐标：输入行的左边缘与基线底部 */
  left: number;
  bottom: number;
  items: MenuItem[];
  /** 键盘高亮的第几项 */
  active: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  /** 空列表时的提示，两条路径文案不同 */
  emptyText?: string;
  ariaLabel?: string;
}> = ({ left, bottom, items, active, onPick, onHover, emptyText, ariaLabel }) => {
  const listRef = useRef<HTMLDivElement>(null);

  const style = useMemo(() => {
    const width = 232;
    /*
     * 贴着光标右边放下不合适就靠边 —— 正文窄栏时 `/` 往往在左半边，
     * 但表格里、居中的引用块里都会出现偏右的情况。
     */
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const x = Math.min(Math.max(8, left), maxLeft);

    const rowHeight = 34;
    const height = Math.min(items.length * rowHeight + 12, 300);
    const flip = bottom + 6 + height > window.innerHeight - 8;
    const y = flip ? Math.max(8, bottom - height - 22) : bottom + 6;

    return { left: x, top: y, width } as React.CSSProperties;
  }, [left, bottom, items.length]);

  /*
   * 键盘上下移动时，把高亮项滚进可视区。
   * 不做这一步的话，列表超过 8 项（去重后的命令就有 10 项）时
   * 高亮会跑到看不见的地方，用户以为没反应。
   */
  useEffect(() => {
    const row = listRef.current?.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <div className="slash-menu" style={style} role="listbox" aria-label={ariaLabel ?? '插入'}>
      {items.length === 0 ? (
        <p className="slash-menu-empty">{emptyText ?? '没有匹配的命令'}</p>
      ) : (
        <div className="slash-menu-list" ref={listRef}>
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={i === active}
              className="slash-menu-item"
              data-active={i === active ? 'true' : undefined}
              /*
               * mousedown 必须挡住：否则焦点先离开编辑器，
               * 选区丢失后命令找不到「当前块」，点了没反应。
               */
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => onHover(i)}
              onClick={() => onPick(i)}
            >
              <span className="slash-menu-label">{item.label}</span>
              <span className="slash-menu-hint">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
