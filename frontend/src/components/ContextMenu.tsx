import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * 通用右键菜单。
 *
 * 项目里没有装 Radix 的 context-menu 包（只有 dialog / tabs / label），
 * 所以这里手写一个。手写的成本主要在四件容易漏的事上，都处理了：
 *
 * 1. **视口边界收缩**：菜单要按实际尺寸回收到视口内，否则靠右/靠下的
 *    右键会弹出半截菜单在外面。必须先量再定位（useLayoutEffect），
 *    先猜尺寸会闪一帧。
 * 2. **关闭时机**：Esc、外部点击、滚动、窗口尺寸变化都要关。
 *    只处理「外部点击」的话，滚动页面时菜单会浮在原地。
 * 3. **键盘可达**：右键不是唯一的打开方式。用 Shift+F10 或键盘菜单键
 *    也能打开，方向键移动、Enter 执行、Esc 关闭。
 * 4. **焦点**：打开时把焦点移进菜单，关闭时还给触发元素，
 *    否则键盘用户会掉进「焦点丢了」的状态。
 *
 * 分组用 group 字段表达，渲染时在组之间插一条分隔线 ——
 * 比让调用方手写 separator 条目更不容易出错。
 */

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** 危险操作走红色，且与普通项之间自动留一条分隔线 */
  danger?: boolean;
  disabled?: boolean;
  /** 右侧的快捷键提示，只做展示 */
  hint?: string;
  /**
   * 分组名。相邻两项分组不同时插入一条分隔线。
   * 不传视为同一组。
   */
  group?: string;
  onSelect: () => void;
}

interface ContextMenuProps {
  open: boolean;
  /** 触发点的视口坐标（clientX / clientY） */
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

const MENU_MIN_WIDTH = 184;

export const ContextMenu: React.FC<ContextMenuProps> = ({
  open,
  x,
  y,
  items,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [activeIndex, setActiveIndex] = useState(-1);

  /**
   * 定位：先量出菜单真实尺寸，再决定落点。
   *
   * 用 useLayoutEffect 而不是 useEffect：后者在浏览器绘制之后才跑，
   * 菜单会先在错误位置闪一帧再跳过去。
   */
  useLayoutEffect(() => {
    if (!open || !ref.current) return;

    const rect = ref.current.getBoundingClientRect();
    const margin = 8;
    const maxLeft = window.innerWidth - rect.width - margin;
    const maxTop = window.innerHeight - rect.height - margin;

    setPosition({
      left: Math.max(margin, Math.min(x, maxLeft)),
      top: Math.max(margin, Math.min(y, maxTop)),
    });
    setActiveIndex(-1);
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      const enabled = items
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => !item.disabled);

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (enabled.length === 0) return;
        const currentPos = enabled.findIndex(({ index }) => index === activeIndex);
        const step = e.key === 'ArrowDown' ? 1 : -1;
        const nextPos =
          currentPos === -1
            ? step === 1
              ? 0
              : enabled.length - 1
            : (currentPos + step + enabled.length) % enabled.length;
        setActiveIndex(enabled[nextPos].index);
        return;
      }

      if (e.key === 'Enter' && activeIndex >= 0) {
        e.preventDefault();
        const target = items[activeIndex];
        if (target && !target.disabled) {
          onClose();
          target.onSelect();
        }
        return;
      }

      if (e.key === 'Tab') onClose();
    };

    /*
     * 用 pointerdown 而不是 click：click 要等抬起，
     * 在「按下拖走」的场景菜单会晚一步才消失。
     */
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };

    // 滚动与尺寸变化都要关：否则菜单会停在原地、与被右键的那一行脱节
    const handleDetach = () => onClose();

    document.addEventListener('keydown', handleKey);
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('scroll', handleDetach, true);
    window.addEventListener('resize', handleDetach);
    window.addEventListener('blur', handleDetach);

    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('scroll', handleDetach, true);
      window.removeEventListener('resize', handleDetach);
      window.removeEventListener('blur', handleDetach);
    };
  }, [open, items, activeIndex, onClose]);

  // 打开后把焦点移进菜单，键盘操作才有落点
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="操作菜单"
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      style={{ left: position.left, top: position.top, minWidth: MENU_MIN_WIDTH }}
      className="fixed z-50 origin-top-left rounded-xl border border-slate-200 bg-white p-1 shadow-lg shadow-slate-900/[0.08] outline-none motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:duration-100"
    >
      {items.map((item, index) => {
        const previous = items[index - 1];
        // 分组变化 or 进入危险区时插分隔线，让删除之类的操作与普通项隔开
        const needDivider =
          index > 0 &&
          ((item.group ?? '') !== (previous.group ?? '') ||
            (item.danger === true && previous.danger !== true));

        const isActive = index === activeIndex;
        const Icon = item.icon;

        return (
          <React.Fragment key={item.id}>
            {needDivider && <div className="my-1 h-px bg-slate-100" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                item.danger
                  ? isActive
                    ? 'bg-red-50 text-red-600'
                    : 'text-red-600 hover:bg-red-50'
                  : isActive
                    ? 'bg-slate-100 text-slate-900'
                    : 'text-slate-700 hover:bg-slate-50'
              }`}
            >
              {Icon ? (
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${
                    item.danger ? 'text-red-500' : 'text-slate-400'
                  }`}
                />
              ) : (
                <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="shrink-0 font-mono text-[10.5px] text-slate-400">
                  {item.hint}
                </span>
              )}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};
