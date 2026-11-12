import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  FileText,
  Folder,
  Image as ImageIcon,
  Menu,
  MessageSquare,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings,
  X,
} from 'lucide-react';
import { KnowledgeTree, type TreeNode } from './components/KnowledgeTree';
import { StarSea } from './components/StarSea';

/**
 * 新工作台（纯 UI 骨架）。
 *
 * ⚠️ 这一版**只有布局与样式，没有任何业务逻辑**：
 * - 不连 store、不发请求、不读登录态
 * - 列表 / 消息 / 树节点全部是下面的 MOCK 常量
 * - 唯一的状态是「切哪个 tab / 显示哪个视图 / 展开哪个目录」，都是本地 useState
 *
 * 接逻辑时按 TODO 替换即可，UI 结构不用动。
 */

/* ------------------------------ MOCK ------------------------------ */
/** TODO: 换成后端返回的笔记树（映射成 TreeNode） */
const MOCK_NOTES: TreeNode[] = [
  { id: 'd1', title: '技术', parentId: null, updatedAt: '2026-11-12' },
  { id: 'n1', title: 'Rust 借用', parentId: 'd1', updatedAt: '2026-11-10' },
  { id: 'n2', title: '向量检索', parentId: 'd1', updatedAt: '2026-11-08' },
  { id: 'n3', title: '编辑器选型', parentId: 'd1', updatedAt: '2026-11-06' },
  { id: 'd2', title: '项目', parentId: null, updatedAt: '2026-11-12' },
  { id: 'n4', title: '工作台改版', parentId: 'd2', updatedAt: '2026-11-11' },
  { id: 'n5', title: 'Agent 工具设计', parentId: 'd2', updatedAt: '2026-11-09' },
  { id: 'd3', title: '阅读', parentId: null, updatedAt: '2026-11-05' },
  { id: 'n6', title: 'Attention 笔记', parentId: 'd3', updatedAt: '2026-11-04' },
  { id: 'd4', title: '归档', parentId: null, updatedAt: '2026-10-28' },
  { id: 'n7', title: '今天想到的', parentId: null, updatedAt: '2026-11-12' },
  { id: 'n8', title: '关于知识的形状', parentId: null, updatedAt: '2026-11-09' },
];

/** TODO: 换成文件列表接口 */
const MOCK_FILES = [
  { id: 'f1', name: 'rust-lifetimes.md', size: '12K', kind: 'text' },
  { id: 'f2', name: '系统架构.md', size: '8K', kind: 'text' },
  { id: 'f3', name: '周报 W45.md', size: '3K', kind: 'text' },
  { id: 'f4', name: 'Attention Is All You Need.pdf', size: '2.1M', kind: 'file' },
  { id: 'f5', name: 'graph-notes.png', size: '640K', kind: 'image' },
  { id: 'f6', name: 'inbox.md', size: '1K', kind: 'text' },
];

/** TODO: 换成 AI 会话列表 */
const MOCK_THREADS = [
  { id: 'c1', title: '解释选中这段', at: '刚刚' },
  { id: 'c2', title: '把周报总结成三点', at: '2h' },
  { id: 'c3', title: '关于检索的笔记', at: '昨天' },
  { id: 'c4', title: '把这篇改短', at: '3d' },
];

/** TODO: 换成当前笔记正文 */
const MOCK_DOC = {
  title: 'Rust 借用',
  meta: '技术 · 418 字 · 3 天前更新',
  body: [
    '借用检查器在**编译期**判断引用是否悬垂，代价是学习曲线陡。它用前期的摩擦换后期几乎不需要排查内存类 bug。',
    '',
    '两条规则：同一时刻要么有任意多个不可变借用，要么有唯一一个可变借用；引用的存活时间不能超过它指向的值。',
  ],
};

/* ------------------------------ 页面 ------------------------------ */

type Tab = 'files' | 'chat' | 'notes';
type View = 'tree' | 'note' | 'file';

/*
 * 配色：冷白系。
 *
 * 之前用的是暖米（#f3f0e9）+ 土赭（#8a5a2b），在显示器上整体发闷偏脏。
 * 现在换成近白底 + 冷灰描边 + 钢蓝强调：亮度上去了，文字对比度反而更高，
 * 也不会像紫蓝渐变那样有「AI 生成」的味道。
 */
/*
 * 配色：冷白系。
 *
 * 之前是暖米（#f3f0e9）+ 土赭（#8a5a2b），整体发闷偏脏。现在换成近白底 +
 * 冷灰描边 + 钢蓝强调：亮度上去了，文字对比度反而更高，也没有紫蓝渐变那种
 * 「AI 生成」的味道。
 */
const COLORS = {
  bg: '#fbfcfe',
  panel: '#ffffff',
  panel2: '#f5f8fb',
  ink: '#1a1f26',
  ink2: '#4a5462',
  ink3: '#8892a0',
  line: '#e7ecf2',
  line2: '#f0f4f8',
  accent: '#3d6ea8',
  accentSoft: '#e9f1fb',
};

export const StudioPage: React.FC = () => {
  /*
   * 移动端适配：窄屏把左右两栏变成抽屉。
   *
   * 固定四列（44 + 268 + 中栏 + 384）在 390px 上必然溢出，中栏会被压成负数宽度。
   * 窄屏只留「活动栏 + 中栏」，左右两栏改成 fixed 覆盖 + 遮罩。
   * 这里只有 UI 状态（是否窄屏、抽屉开没开），不涉及业务逻辑。
   */
  /*
   * 可拖拽分栏（VS Code 那种）。
   *
   * 三个刻意的做法：
   * 1. **拖动过程中不 setState**，只改 CSS 变量 `--left` / `--right`。
   *    每帧 setState 会让整棵子树（含 SVG 树）重渲染，拖动会明显掉帧。
   *    松手才落 state 并写 localStorage，视觉上一样是实时的。
   * 2. 宽度上下限按「中间至少留 360px」动态收紧，避免拖到把内容挤没。
   * 3. 收起用 grid 列宽 0 + `overflow-hidden`，配 180ms 过渡；拖动时关掉过渡，
   *    否则手感会像拖橡皮筋。
   */
  const LEFT_MIN = 200;
  const LEFT_MAX = 480;
  const RIGHT_MIN = 320;
  const RIGHT_MAX = 620;
  const CENTER_MIN = 360;
  const RAIL_W = 44;
  const LEFT_DEFAULT = 268;
  const RIGHT_DEFAULT = 384;

  const readWidth = (key: string, fallback: number, min: number, max: number) => {
    if (typeof window === 'undefined') return fallback;
    const raw = Number(window.localStorage.getItem(key));
    return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
  };

  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ side: 'left' | 'right'; startX: number; startW: number } | null>(null);

  const [leftW, setLeftW] = useState(() => readWidth('studio:left', LEFT_DEFAULT, LEFT_MIN, LEFT_MAX));
  const [rightW, setRightW] = useState(() =>
    readWidth('studio:right', RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX),
  );
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => typeof window !== 'undefined' && window.localStorage.getItem('studio:leftCollapsed') === '1',
  );
  const [dragging, setDragging] = useState<'left' | 'right' | null>(null);

  /** 拖动时允许的最大值：保证中间栏不小于 CENTER_MIN */
  const maxFor = (side: 'left' | 'right', otherW: number) => {
    const budget = window.innerWidth - RAIL_W - otherW - CENTER_MIN;
    return Math.max(side === 'left' ? LEFT_MIN : RIGHT_MIN, Math.min(side === 'left' ? LEFT_MAX : RIGHT_MAX, budget));
  };

  const onDragStart = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { side, startX: e.clientX, startW: side === 'left' ? leftW : rightW };
    setDragging(side);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const delta = e.clientX - d.startX;
    const raw = d.side === 'left' ? d.startW + delta : d.startW - delta;
    const min = d.side === 'left' ? LEFT_MIN : RIGHT_MIN;
    const max = maxFor(d.side, d.side === 'left' ? rightW : leftW);
    const next = Math.round(Math.min(max, Math.max(min, raw)));
    shellRef.current?.style.setProperty(d.side === 'left' ? '--left' : '--right', `${next}px`);
  };

  const onDragEnd = () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(null);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    if (!d) return;
    const key = d.side === 'left' ? '--left' : '--right';
    const raw = Number(shellRef.current?.style.getPropertyValue(key).replace('px', ''));
    if (!Number.isFinite(raw) || raw <= 0) return;
    if (d.side === 'left') {
      setLeftW(raw);
      window.localStorage.setItem('studio:left', String(raw));
    } else {
      setRightW(raw);
      window.localStorage.setItem('studio:right', String(raw));
    }
  };

  /** 双击分隔线：恢复默认宽度（VS Code 也有这个） */
  const resetWidth = (side: 'left' | 'right') => {
    const next = side === 'left' ? LEFT_DEFAULT : RIGHT_DEFAULT;
    shellRef.current?.style.setProperty(side === 'left' ? '--left' : '--right', `${next}px`);
    if (side === 'left') {
      setLeftW(next);
      window.localStorage.removeItem('studio:left');
    } else {
      setRightW(next);
      window.localStorage.removeItem('studio:right');
    }
  };

  /* 窗口缩小后可能撑破中间栏：把两侧宽度收敛回允许范围（VS Code 也这么做） */
  useEffect(() => {
    const onResize = () => {
      if (window.matchMedia('(max-width: 767px)').matches) return;
      const lMax = maxFor('left', rightW);
      const rMax = maxFor('right', leftW);
      setLeftW((w) => (w > lMax ? lMax : w));
      setRightW((w) => (w > rMax ? rMax : w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftW, rightW]);

  /* 窗口缩小后可能撑破中间栏：把两侧宽度收敛回允许范围（VS Code 也这么做） */
  useEffect(() => {
    const onResize = () => {
      if (window.matchMedia('(max-width: 767px)').matches) return;
      const lMax = maxFor('left', rightW);
      const rMax = maxFor('right', leftW);
      setLeftW((w) => (w > lMax ? lMax : w));
      setRightW((w) => (w > rMax ? rMax : w));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftW, rightW]);

  const toggleLeft = () => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem('studio:leftCollapsed', next ? '1' : '0');
      return next;
    });
  };

  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches,
  );
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => {
      setIsNarrow(mq.matches);
      if (!mq.matches) setDrawer(null);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const [tab, setTab] = useState<Tab>('notes');
  const [view, setView] = useState<View>('tree');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [activeFile, setActiveFile] = useState<(typeof MOCK_FILES)[number] | null>(null);

  /** TODO: 换成 notes.length === 0 */
  const isEmpty = false;

  const roots = MOCK_NOTES.filter((n) => !n.parentId);
  const kidsOf = (id: string) => MOCK_NOTES.filter((n) => n.parentId === id);

  const openNote = (id: string) => {
    setActiveNoteId(id);
    setView('note');
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /* ------------------------------ 左栏三张列表 ------------------------------ */
  const notesList = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {roots.map((r) => {
        const kids = kidsOf(r.id);
        const isOpen = expanded.has(r.id);
        return (
          <div key={r.id}>
            <div className="flex h-[26px] items-center gap-1 pr-2 hover:bg-black/[0.035]" style={{ paddingLeft: 8 }}>
              {kids.length > 0 ? (
                <button
                  type="button"
                  aria-label={isOpen ? '收起' : '展开'}
                  onClick={() => toggle(r.id)}
                  className="flex h-[18px] w-[14px] shrink-0 items-center justify-center"
                  style={{ color: COLORS.ink3 }}
                >
                  <ChevronRight
                    size={11}
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}
                  />
                </button>
              ) : (
                <span className="w-[14px] shrink-0" />
              )}
              <button type="button" onClick={() => openNote(r.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                <FileText size={12} className="shrink-0" style={{ color: COLORS.ink3 }} />
                <span className="truncate text-[12.5px]" style={{ color: COLORS.ink2 }}>
                  {r.title}
                </span>
              </button>
              {kids.length > 0 && (
                <span className="shrink-0 font-mono text-[10px]" style={{ color: COLORS.ink3 }}>
                  {kids.length}
                </span>
              )}
            </div>
            {isOpen &&
              kids.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  onClick={() => openNote(k.id)}
                  className="flex h-[26px] w-full items-center pr-2 text-left hover:bg-black/[0.035]"
                  style={{ paddingLeft: 31 }}
                >
                  <span className="truncate text-[12.5px]" style={{ color: COLORS.ink2 }}>
                    {k.title}
                  </span>
                </button>
              ))}
          </div>
        );
      })}
      <button
        type="button"
        className="mt-1 flex h-[28px] w-full items-center gap-1.5 px-3 text-[12px] hover:bg-black/[0.035]"
        style={{ color: COLORS.ink3 }}
      >
        <Plus size={12} />
        新建
      </button>
    </div>
  );

  const filesList = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      {MOCK_FILES.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => {
            setActiveFile(f);
            setView('file');
          }}
          className="flex h-[26px] w-full items-center gap-2 px-3 text-left hover:bg-black/[0.035]"
        >
          {f.kind === 'image' ? (
            <ImageIcon size={12} className="shrink-0" style={{ color: COLORS.ink3 }} />
          ) : (
            <FileText size={12} className="shrink-0" style={{ color: COLORS.ink3 }} />
          )}
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: COLORS.ink2 }}>
            {f.name}
          </span>
          <span className="shrink-0 font-mono text-[10px]" style={{ color: COLORS.ink3 }}>
            {f.size}
          </span>
        </button>
      ))}
    </div>
  );

  const threadsList = (
    <div className="min-h-0 flex-1 overflow-y-auto pb-2">
      <button
        type="button"
        className="flex h-[26px] w-full items-center gap-1.5 px-3 text-[12px] hover:bg-black/[0.035]"
        style={{ color: COLORS.ink3 }}
      >
        <Plus size={12} />
        新对话
      </button>
      {MOCK_THREADS.map((c, i) => (
        <button
          key={c.id}
          type="button"
          className={`flex h-[26px] w-full items-center gap-2 pr-2 text-left hover:bg-black/[0.035] ${
            i === 0 ? 'bg-black/[0.04]' : ''
          }`}
          style={{ paddingLeft: 12 }}
        >
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: COLORS.ink2 }}>
            {c.title}
          </span>
          <span className="shrink-0 font-mono text-[10px]" style={{ color: COLORS.ink3 }}>
            {c.at}
          </span>
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={shellRef}
      className="relative grid h-[100dvh] w-full overflow-hidden"
      style={{
        background: COLORS.bg,
        color: COLORS.ink,
        /* 宽屏：rail | 左（可 0） | 中 | 右；两侧宽度走 CSS 变量，拖动时只改变量 */
        ['--left' as string]: `${leftW}px`,
        ['--right' as string]: `${rightW}px`,
        gridTemplateColumns: isNarrow
          ? `${RAIL_W}px minmax(0,1fr)`
          : `${RAIL_W}px ${leftCollapsed ? '0px' : 'var(--left)'} minmax(${CENTER_MIN}px,1fr) var(--right)`,
        /* 收起/展开的平滑过渡；拖动中关掉，否则像橡皮筋 */
        transition: dragging ? 'none' : 'grid-template-columns 180ms cubic-bezier(.2,.7,.3,1)',
        gridTemplateRows: 'minmax(0,1fr) 26px',
      }}
    >
      {/* 活动栏：工作台 / 聊天（独立模块）/ 设置 */}
      <nav
        className="flex flex-col items-center gap-0.5 py-2.5"
        style={{ background: COLORS.panel2, borderRight: `1px solid ${COLORS.line}` }}
      >
        <button
          type="button"
          title="工作台"
          aria-current="page"
          className="relative grid h-[34px] w-[34px] place-items-center rounded-[9px]"
          style={{ background: 'rgba(0,0,0,.06)' }}
        >
          <span className="absolute bottom-2 -left-1.5 top-2 w-0.5 rounded" style={{ background: COLORS.accent }} />
          <Network size={17} />
        </button>
        <Link
          to="/chat"
          title="聊天"
          className="grid h-[34px] w-[34px] place-items-center rounded-[9px] hover:bg-black/[0.05]"
          style={{ color: COLORS.ink3 }}
        >
          <MessageSquare size={17} />
        </Link>
        <span className="flex-1" />
        <Link
          to="/profile"
          title="设置"
          className="grid h-[34px] w-[34px] place-items-center rounded-[9px] hover:bg-black/[0.05]"
          style={{ color: COLORS.ink3 }}
        >
          <Settings size={17} />
        </Link>
      </nav>

      {/* 左栏 */}
      <aside
        className={
          isNarrow
            ? `fixed inset-y-0 left-0 z-40 flex w-[280px] flex-col overflow-y-auto shadow-xl transition-transform duration-200 ${
                drawer === 'left' ? 'translate-x-0' : '-translate-x-full'
              }`
            : `flex min-h-0 flex-col overflow-hidden ${leftCollapsed ? 'border-r-0' : ''}`
        }
        style={{ background: COLORS.panel2, borderRight: `1px solid ${COLORS.line}` }}
      >
        <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
          <span className="grid h-[18px] w-[18px] place-items-center rounded-[6px]" style={{ background: '#2b2622' }}>
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: COLORS.panel }} />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">Wisora</span>
          {/* 宽屏：收起侧栏（收起后由中栏顶栏的按钮再展开） */}
          {!isNarrow && (
            <button
              type="button"
              aria-label="收起侧栏"
              title="收起侧栏"
              onClick={toggleLeft}
              className="ml-auto grid h-6 w-6 place-items-center rounded-md text-slate-400 transition-colors hover:bg-black/[0.06] hover:text-slate-700"
            >
              <PanelLeftClose size={14} />
            </button>
          )}
          {isNarrow && (
            <button
              type="button"
              aria-label="关闭列表"
              onClick={() => setDrawer(null)}
              className="ml-auto grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-black/[0.06]"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="mx-2.5 mb-2 flex gap-0.5 rounded-lg p-[3px]" style={{ background: 'rgba(0,0,0,.045)' }}>
          {(
            [
              { id: 'files', label: '文件', icon: Folder },
              { id: 'chat', label: '对话', icon: MessageSquare },
              { id: 'notes', label: '笔记', icon: FileText },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-selected={tab === id}
              className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px]"
              style={
                tab === id
                  ? { background: COLORS.panel, color: COLORS.ink, boxShadow: '0 1px 2px rgba(0,0,0,.06)' }
                  : { color: COLORS.ink2 }
              }
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between px-3 pb-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em]" style={{ color: COLORS.ink3 }}>
            {tab === 'notes' ? MOCK_NOTES.length : tab === 'files' ? MOCK_FILES.length : MOCK_THREADS.length}
          </span>
          <button type="button" aria-label="新建" className="rounded px-1.5 text-[12px] hover:bg-black/[0.05]" style={{ color: COLORS.ink3 }}>
            ＋
          </button>
        </div>

        {tab === 'notes' && notesList}
        {tab === 'files' && filesList}
        {tab === 'chat' && threadsList}
      </aside>

      {/* 中栏 */}
      <main className="flex min-w-0 flex-col" style={{ background: COLORS.panel }}>
        <div
          className="flex h-10 shrink-0 items-center gap-2 px-3.5"
          style={{ borderBottom: `1px solid ${COLORS.line}` }}
        >
          {!isNarrow && leftCollapsed && (
            <button
              type="button"
              aria-label="展开侧栏"
              title="展开侧栏"
              onClick={toggleLeft}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-black/[0.05]"
              style={{ color: COLORS.ink2 }}
            >
              <PanelLeftOpen size={16} />
            </button>
          )}
          {isNarrow && (
            <button
              type="button"
              aria-label="打开列表"
              onClick={() => setDrawer('left')}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-black/[0.05]"
              style={{ color: COLORS.ink2 }}
            >
              <Menu size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setView('tree')}
            className="text-[12.5px]"
            style={{ color: view === 'tree' ? COLORS.ink : COLORS.ink3 }}
          >
            知识库
          </button>
          <span style={{ color: COLORS.ink3, opacity: 0.45 }}>/</span>
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
            {view === 'tree'
              ? '知识树'
              : view === 'file'
                ? (activeFile?.name ?? '')
                : (MOCK_NOTES.find((n) => n.id === activeNoteId)?.title ?? MOCK_DOC.title)}
          </span>
          {isNarrow && (
            <button
              type="button"
              aria-label="打开 AI 面板"
              onClick={() => setDrawer('right')}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md hover:bg-black/[0.05]"
              style={{ color: COLORS.ink2 }}
            >
              <MessageSquare size={15} />
            </button>
          )}
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* 知识树 / 空库星海 */}
          {view === 'tree' &&
            (isEmpty ? (
              <div className="relative grid h-full place-items-center">
                <div className="absolute inset-0">
                  <StarSea />
                </div>
                <div className="relative text-center">
                  <p className="mb-4 text-[20px] font-semibold tracking-tight">还没有笔记</p>
                  <button
                    type="button"
                    className="inline-flex h-[34px] items-center gap-1.5 rounded-lg px-3.5 text-[12.5px] font-medium"
                    style={{ background: '#2b2622', color: COLORS.panel }}
                  >
                    <Plus size={13} />
                    新建笔记
                  </button>
                </div>
              </div>
            ) : (
              /* 窄屏时 SVG 等比缩小会把标签压到 ~6px，整体放大一档再居中 */
              <div
                className="h-full w-full"
                style={isNarrow ? { transform: 'scale(1.55)', transformOrigin: '50% 50%' } : undefined}
              >
                <KnowledgeTree notes={MOCK_NOTES} onOpen={openNote} />
              </div>
            ))}

          {/* 笔记正文：TODO 换成编辑器 / Markdown 渲染 */}
          {view === 'note' && (
            <div className="h-full overflow-y-auto px-5 py-8 sm:px-14 sm:py-12">
              <div className="mx-auto max-w-[680px]">
                <h1 className="mb-1.5 text-[27px] font-semibold tracking-tight">{MOCK_DOC.title}</h1>
                <div className="mb-7 font-mono text-[10.5px]" style={{ color: COLORS.ink3 }}>
                  {MOCK_DOC.meta}
                </div>
                {MOCK_DOC.body.map((line, i) =>
                  line === '' ? (
                    <div key={i} className="h-3" />
                  ) : (
                    <p key={i} className="mb-4 text-[14px] leading-[1.9]" style={{ color: COLORS.ink2 }}>
                      {line.split('**').map((seg, j) =>
                        j % 2 === 1 ? (
                          <mark
                            key={j}
                            style={{ background: COLORS.accentSoft, color: COLORS.ink, padding: '1px 2px', borderRadius: 3 }}
                          >
                            {seg}
                          </mark>
                        ) : (
                          <React.Fragment key={j}>{seg}</React.Fragment>
                        ),
                      )}
                    </p>
                  ),
                )}
              </div>
            </div>
          )}

          {/* 文件预览：TODO 接签名直链 */}
          {view === 'file' && activeFile && (
            <div className="flex h-full flex-col">
              <div
                className="flex h-[34px] shrink-0 items-center gap-2 px-3.5 font-mono text-[11px]"
                style={{ borderBottom: `1px solid ${COLORS.line2}`, background: COLORS.panel2, color: COLORS.ink3 }}
              >
                <FileText size={12} />
                <span className="min-w-0 flex-1 truncate">{activeFile.name}</span>
                <span className="uppercase tracking-[0.12em]">readonly</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-10 py-6">
                <pre className="font-mono text-[12px] leading-[1.9]" style={{ color: COLORS.ink2 }}>
                  {'# 文件预览占位\n\n这里放文本内容 / <img> / <iframe>。\nTODO: 用签名直链渲染实际内容。'}
                </pre>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* 右栏：Agent（静态壳，TODO 接流式对话与上下文） */}
      <section
        className={
          isNarrow
            ? `fixed inset-y-0 right-0 z-40 flex w-[92vw] max-w-[420px] flex-col shadow-xl transition-transform duration-200 ${
                drawer === 'right' ? 'translate-x-0' : 'translate-x-full'
              }`
            : 'flex min-h-0 flex-col'
        }
        style={{ borderLeft: `1px solid ${COLORS.line}`, background: COLORS.panel }}
      >
        <div
          className="flex h-10 shrink-0 items-center gap-2 px-3.5"
          style={{ borderBottom: `1px solid ${COLORS.line}` }}
        >
          <span className="text-[12.5px] font-medium">AI</span>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#c9c3b8' }} />
          {isNarrow && (
            <button
              type="button"
              aria-label="关闭 AI 面板"
              onClick={() => setDrawer(null)}
              className="ml-auto grid h-7 w-7 place-items-center rounded-md text-slate-500 hover:bg-black/[0.06]"
            >
              <X size={15} />
            </button>
          )}
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-4">
          <div className="flex flex-col items-end gap-1.5">
            <div
              className="max-w-[92%] rounded-[11px] rounded-br-[4px] px-3 py-2 text-[12.8px] leading-relaxed"
              style={{ background: '#2b2622', color: COLORS.panel }}
            >
              解释我选中的这段。
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <div
              className="flex items-center gap-2 rounded-lg border border-dashed px-2.5 py-1.5 font-mono text-[10.5px]"
              style={{ borderColor: COLORS.line, color: COLORS.ink3 }}
            >
              ✓ 读取《Rust 借用》
            </div>
            <div
              className="max-w-[92%] rounded-[11px] rounded-bl-[4px] border px-3 py-2 text-[12.8px] leading-relaxed"
              style={{ background: COLORS.panel2, borderColor: COLORS.line2, color: COLORS.ink }}
            >
              借用检查器用编译期静态分析把「悬垂引用」拦在运行时之前。
            </div>
          </div>
        </div>

        <div className="shrink-0 px-2.5 pb-2.5 pt-2" style={{ borderTop: `1px solid ${COLORS.line}` }}>
          <div className="rounded-[10px] border" style={{ borderColor: COLORS.line, background: COLORS.panel }}>
            <textarea
              rows={2}
              placeholder="问点什么"
              className="w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-[12.8px] outline-none"
              style={{ color: COLORS.ink }}
            />
            <div className="flex items-center gap-1.5 px-2 pb-2">
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11px]"
                style={{ background: COLORS.accentSoft, color: COLORS.accent }}
              >
                可写
              </button>
              <span className="flex-1" />
              <button
                type="button"
                aria-label="发送"
                className="grid h-[26px] w-[26px] place-items-center rounded-[7px]"
                style={{ background: '#2b2622', color: COLORS.panel }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M5 12h13M13 6l6 6-6 6" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      {/*
        两条拖拽分隔线：绝对定位在面板边界上，4px 热区（VS Code 也是 1px 线 + 宽热区）。
        左边界 = rail + 左栏宽；右边界 = 视口 - 右栏宽。

        颜色刻意不用 VS Code 那种高亮蓝：这套界面是冷白 + 石墨灰，
        突然一条饱和蓝会很跳。改成 `#4a5462`（与正文同族的石墨灰），
        拖起来是「线变实」而不是「线变色」，对比度约 7.8:1，足够看清又不抢内容。
      */}
      {!isNarrow && !leftCollapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左侧面板宽度"
          onPointerDown={onDragStart('left')}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={() => resetWidth('left')}
          className={`absolute inset-y-0 z-20 w-1 cursor-col-resize transition-colors ${
            dragging === 'left' ? 'bg-[#4a5462]' : 'bg-transparent hover:bg-[#cfd7e0]'
          }`}
          style={{ left: `calc(${RAIL_W}px + var(--left) - 2px)` }}
        />
      )}

      {!isNarrow && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧面板宽度"
          onPointerDown={onDragStart('right')}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
          onDoubleClick={() => resetWidth('right')}
          className={`absolute inset-y-0 z-20 w-1 cursor-col-resize transition-colors ${
            dragging === 'right' ? 'bg-[#4a5462]' : 'bg-transparent hover:bg-[#cfd7e0]'
          }`}
          style={{ right: 'calc(var(--right) - 2px)' }}
        />
      )}

      {/* 拖拽时铺一层透明遮罩：防止指针经过 iframe / canvas 时丢事件 */}
      {dragging !== null && <div className="absolute inset-0 z-10 cursor-col-resize" />}

      {/* 窄屏抽屉遮罩 */}
      {isNarrow && drawer !== null && (
        <button
          type="button"
          aria-label="关闭面板"
          onClick={() => setDrawer(null)}
          className="fixed inset-0 z-30 bg-slate-900/25"
        />
      )}

      {/* 状态栏 */}
      <footer
        className="flex items-center gap-3.5 px-3.5 font-mono text-[10px] tracking-wide"
        style={{
          gridColumn: '1 / -1',
          borderTop: `1px solid ${COLORS.line}`,
          background: COLORS.panel2,
          color: COLORS.ink3,
        }}
      >
        <span>{view === 'tree' ? '知识树' : view === 'file' ? '文件' : '笔记'}</span>
        <span className="flex-1" />
        <span>
          {MOCK_NOTES.length} · {roots.length}
        </span>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: COLORS.ink3, opacity: 0.5 }} />
      </footer>
    </div>
  );
};

export default StudioPage;
