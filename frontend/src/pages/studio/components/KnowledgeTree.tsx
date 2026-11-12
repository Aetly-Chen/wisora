import React, { useMemo, useState } from 'react';

/**
 * 知识树只认这个最小结构 —— 不依赖笔记模块的类型。
 * 接真实数据时，把后端返回的节点映射成 TreeNode 传进来即可。
 */
export interface TreeNode {
  id: string;
  title: string;
  /** null = 顶层 */
  parentId: string | null;
  updatedAt: string;
}

/**
 * 知识树（首页）。
 *
 * 交互规则（按需求）：
 * - 中心圆点 = 知识库根；**悬停**它 → 一级以半透明预览；**点击**它 → 一级实体化
 * - **点击有子页面的节点** → 展开/收起它的子级
 * - **点击叶子节点** → 打开这篇笔记
 *
 * 为什么用 viewBox 固定坐标系而不是读容器尺寸：
 * 树的位置只跟「可见节点数」有关，用 1000×800 的虚拟画布 + `preserveAspectRatio`
 * 就能自适应任意容器，省掉 ResizeObserver 与重排（换窗口时树不会抖）。
 */
const VB_W = 1000;
const VB_H = 800;
const CX = VB_W / 2;
const CY = VB_H / 2;
const R_MAX = Math.min(VB_W, VB_H) / 2 - 80;

interface Props {
  notes: TreeNode[];
  onOpen: (id: string) => void;
}

interface Node {
  note: TreeNode;
  depth: 1 | 2;
  children: TreeNode[];
}

export const KnowledgeTree: React.FC<Props> = ({ notes, onOpen }) => {
  const [openRoot, setOpenRoot] = useState(true);
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [previewRoot, setPreviewRoot] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);

  /* 扁平列表 → 树。顶层 = parentId 为 null */
  const roots = useMemo(() => notes.filter((n) => !n.parentId), [notes]);
  const childrenOf = useMemo(() => {
    const map = new Map<string, TreeNode[]>();
    for (const n of notes) {
      if (!n.parentId) continue;
      const arr = map.get(n.parentId) ?? [];
      arr.push(n);
      map.set(n.parentId, arr);
    }
    return map;
  }, [notes]);

  const visible = useMemo<Node[]>(() => {
    const showL1 = openRoot || previewRoot;
    if (!showL1) return [];
    const out: Node[] = [];
    for (const r of roots) {
      const kids = childrenOf.get(r.id) ?? [];
      out.push({ note: r, depth: 1, children: kids });
      if (kids.length > 0 && openDirs.has(r.id)) {
        for (const k of kids) out.push({ note: k, depth: 2, children: [] });
      }
    }
    return out;
  }, [roots, childrenOf, openRoot, previewRoot, openDirs]);

  /* 极坐标：一级均分整圈，二级围绕父角度扇开 */
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number; a: number }>();
    const r1 = R_MAX * 0.66;
    const level1 = visible.filter((v) => v.depth === 1);
    level1.forEach((v, i) => {
      const a = -Math.PI / 2 + (i / Math.max(level1.length, 1)) * Math.PI * 2;
      pos.set(v.note.id, { x: CX + Math.cos(a) * r1, y: CY + Math.sin(a) * r1, a });
    });
    const r2 = R_MAX * 1.0;
    for (const v of level1) {
      if (!openDirs.has(v.note.id)) continue;
      const kids = visible.filter((k) => k.note.parentId === v.note.id);
      const pa = pos.get(v.note.id)?.a ?? 0;
      const spread = Math.min(1.0, 0.4 * kids.length);
      kids.forEach((k, i) => {
        const a = kids.length === 1 ? pa : pa - spread / 2 + (i / (kids.length - 1)) * spread;
        pos.set(k.note.id, { x: CX + Math.cos(a) * r2, y: CY + Math.sin(a) * r2, a });
      });
    }
    return pos;
  }, [visible, openDirs]);

  const toggleDir = (id: string) => {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleClick = (v: Node) => {
    if (v.children.length > 0) toggleDir(v.note.id);
    else onOpen(v.note.id);
  };

  const hovered = hoverId ? visible.find((v) => v.note.id === hoverId) : null;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="h-full w-full select-none"
      role="tree"
      aria-label="知识树"
    >
      {/* 一级轨道：极淡，给层级一点空间感 */}
      {visible.length > 0 && (
        <circle
          cx={CX}
          cy={CY}
          r={R_MAX * 0.66}
          fill="none"
          stroke="#8c857a"
          strokeWidth={0.8}
          strokeDasharray="2 7"
          opacity={0.22}
        />
      )}

      {/* 连线 */}
      {visible.map((v) => {
        const p = layout.get(v.note.id);
        const parent = v.note.parentId ? layout.get(v.note.parentId) : { x: CX, y: CY };
        if (!p || !parent) return null;
        const hot = hoverId !== null && (hoverId === v.note.id || hoverId === v.note.parentId);
        return (
          <line
            key={`l-${v.note.id}`}
            x1={parent.x}
            y1={parent.y}
            x2={p.x}
            y2={p.y}
            stroke={hot ? '#8a5a2b' : '#e3ddd1'}
            strokeWidth={hot ? 1.6 : 1}
            style={{ transition: 'stroke .2s ease' }}
          />
        );
      })}

      {/* 根 */}
      <g
        transform={`translate(${CX},${CY})`}
        className="cursor-pointer"
        onMouseEnter={() => setPreviewRoot(true)}
        onMouseLeave={() => setPreviewRoot(false)}
        onClick={() => {
          setPreviewRoot(false);
          setOpenRoot((v) => !v);
        }}
      >
        <circle r={50} fill="none" stroke="#2b2622" strokeWidth={1} opacity={0.12} />
        <circle r={7} fill="#2b2622" />
        <text y={30} textAnchor="middle" fontSize={13} fill="#55504a">
          知识库
        </text>
      </g>

      {/* 节点 */}
      {visible.map((v) => {
        const p = layout.get(v.note.id);
        if (!p) return null;
        const isDir = v.children.length > 0;
        const isOpen = openDirs.has(v.note.id);
        const isHover = hoverId === v.note.id;
        const ghost = previewRoot && !openRoot;
        const count = v.children.length;
        return (
          <g
            key={v.note.id}
            transform={`translate(${p.x},${p.y})`}
            className="cursor-pointer"
            opacity={ghost ? 0.4 : 1}
            style={{ transition: 'transform .32s cubic-bezier(.22,.61,.36,1), opacity .25s ease' }}
            onMouseEnter={() => setHoverId(v.note.id)}
            onMouseLeave={() => setHoverId((cur) => (cur === v.note.id ? null : cur))}
            onClick={(e) => {
              e.stopPropagation();
              handleClick(v);
            }}
          >
            {isHover && <circle r={13} fill="none" stroke="#8a5a2b" strokeWidth={1} />}
            <circle
              r={isDir ? 5 : 3.4}
              fill={isDir ? '#fbf9f5' : isHover ? '#8a5a2b' : '#8c857a'}
              stroke={isDir ? (isOpen || isHover ? '#8a5a2b' : '#55504a') : 'none'}
              strokeWidth={isDir ? 1.5 : 0}
            />
            <text x={11} y={4} fontSize={12.5} fill={isHover ? '#1a1917' : '#55504a'}>
              {v.note.title || '无标题'}
            </text>
            {isDir && (
              <text x={11} y={18} fontSize={10} fill="#8c857a" fontFamily="ui-monospace, monospace">
                {count}
              </text>
            )}
          </g>
        );
      })}

      {/* 悬停提示：只在有数据时出现，文案压到最短 */}
      {hovered && (
        <g pointerEvents="none" transform={`translate(${CX},${VB_H - 34})`}>
          <text textAnchor="middle" fontSize={11} fill="#8c857a" fontFamily="ui-monospace, monospace">
            {hovered.note.title || '无标题'}
            {hovered.children.length > 0
              ? ` · ${hovered.children.length}`
              : ` · ${new Date(hovered.note.updatedAt).toLocaleDateString('zh-CN')}`}
          </text>
        </g>
      )}
    </svg>
  );
};

export default KnowledgeTree;
