import React, { useEffect, useRef, useState } from 'react';

/**
 * 固定行高的轻量虚拟列表。
 *
 * 列表可能积累到几千条，全量渲染会让首屏变慢、滚动掉帧。
 * 这里只渲染视口内的行 + 上下各 OVERSCAN 行缓冲。
 *
 * 为什么自己写而不引第三方：列表行高固定、无需动态测量，
 * 核心逻辑不到 30 行；为这点功能增加一个运行时依赖不划算。
 *
 * 两个必须遵守的约束：
 * 1. ROW_HEIGHT 必须与实际行高严格一致，否则滚动位置会漂移
 * 2. 滚动容器必须始终挂载（空状态放在容器内部）——
 *    若写成 `if (count === 0) return empty`，首次渲染时容器不存在，
 *    effect 里的 ref.current 为 null 直接退出且依赖为空不会重跑，
 *    等数据到达容器才挂载，viewportHeight 会永远停在 0
 */
export const ROW_HEIGHT = 44;
const OVERSCAN = 6;

interface VirtualListProps {
  count: number;
  renderRow: (index: number) => React.ReactNode;
  className?: string;
  empty?: React.ReactNode;
  'data-testid'?: string;
}

export const VirtualList: React.FC<VirtualListProps> = ({
  count,
  renderRow,
  className,
  empty,
  'data-testid': testId,
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const sync = () => setViewportHeight(el.clientHeight);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(
    count,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  const rows: React.ReactNode[] = [];
  for (let i = start; i < end; i++) {
    rows.push(
      <div key={i} style={{ height: ROW_HEIGHT }}>
        {renderRow(i)}
      </div>,
    );
  }

  return (
    <div
      ref={ref}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      className={className}
      data-virtual-scroll
      data-testid={testId}
    >
      {count === 0 ? (
        empty
      ) : (
        <div style={{ height: count * ROW_HEIGHT, position: 'relative' }}>
          <div style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>{rows}</div>
        </div>
      )}
    </div>
  );
};
