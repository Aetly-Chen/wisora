import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  FileText,
  Folder,
  Image as ImageIcon,
  MessageSquare,
  Network,
  Plus,
  Settings,
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

const COLORS = {
  bg: '#f3f0e9',
  panel: '#fbf9f5',
  panel2: '#f7f4ee',
  ink: '#1a1917',
  ink2: '#55504a',
  ink3: '#8c857a',
  line: '#e3ddd1',
  line2: '#ede8de',
  accent: '#8a5a2b',
  accentSoft: '#f0e5d6',
};

export const StudioPage: React.FC = () => {
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
      className="grid h-[100dvh] w-full overflow-hidden"
      style={{
        background: COLORS.bg,
        color: COLORS.ink,
        gridTemplateColumns: '44px 268px minmax(0,1fr) 384px',
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
        className="flex min-h-0 flex-col"
        style={{ background: COLORS.panel2, borderRight: `1px solid ${COLORS.line}` }}
      >
        <div className="flex items-center gap-1.5 px-3 pb-2 pt-3">
          <span className="grid h-[18px] w-[18px] place-items-center rounded-[6px]" style={{ background: '#2b2622' }}>
            <span className="h-[6px] w-[6px] rounded-full" style={{ background: COLORS.panel }} />
          </span>
          <span className="text-[13px] font-semibold tracking-tight">Wisora</span>
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
          <button
            type="button"
            onClick={() => setView('tree')}
            className="text-[12.5px]"
            style={{ color: view === 'tree' ? COLORS.ink : COLORS.ink3 }}
          >
            知识库
          </button>
          <span style={{ color: COLORS.ink3, opacity: 0.45 }}>/</span>
          <span className="truncate text-[12.5px] font-medium">
            {view === 'tree'
              ? '知识树'
              : view === 'file'
                ? (activeFile?.name ?? '')
                : (MOCK_NOTES.find((n) => n.id === activeNoteId)?.title ?? MOCK_DOC.title)}
          </span>
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
              <KnowledgeTree notes={MOCK_NOTES} onOpen={openNote} />
            ))}

          {/* 笔记正文：TODO 换成编辑器 / Markdown 渲染 */}
          {view === 'note' && (
            <div className="h-full overflow-y-auto px-14 py-12">
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
        className="flex min-h-0 flex-col"
        style={{ borderLeft: `1px solid ${COLORS.line}`, background: COLORS.panel }}
      >
        <div
          className="flex h-10 shrink-0 items-center gap-2 px-3.5"
          style={{ borderBottom: `1px solid ${COLORS.line}` }}
        >
          <span className="text-[12.5px] font-medium">AI</span>
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: '#c9c3b8' }} />
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
