import { Plugin } from '@milkdown/prose/state';
import type { EditorState } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';

/**
 * 斜杠命令（`/`）的触发判定。
 *
 * 规则刻意收得很紧，宁可漏触发也不要误触发：
 * - 光标必须是**空选区**，且落在**段落**里
 * - 光标必须在段落末尾（人正在往后打，不是在回头改）
 * - 段落内容以 `/` 开头，且 `/` 后面**没有空白**
 *
 * 最后一条是关键：正文里写「/」很常见（路径、日期、分数），
 * 一旦出现空格就说明这是正常文字，不该弹菜单。
 */
export interface SlashAnchor {
  /** `/` 所在位置，执行命令时要先把它删掉 */
  from: number;
  /** 光标位置（查询词末尾） */
  to: number;
  /** `/` 后面已经输入的内容，用来过滤菜单项 */
  query: string;
  /** 菜单锚点的视口坐标（菜单用 position: fixed 定位） */
  left: number;
  bottom: number;
}

export function detectSlash(
  state: EditorState,
  view: EditorView,
): SlashAnchor | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if ($from.parent.type.name !== 'paragraph') return null;
  if ($from.parentOffset !== $from.parent.content.size) return null;

  const text = $from.parent.textContent;
  if (!text.startsWith('/')) return null;

  const query = text.slice(1);
  if (/\s/.test(query)) return null;

  /*
   * `coordsAtPos` 在极端情况下会给出空对象（节点刚被删、还没布局），
   * 拿不到坐标就当没触发 —— 菜单没地方放，弹出来也是错的。
   */
  const coords = view.coordsAtPos($from.pos);
  if (!coords || coords.left == null || coords.bottom == null) return null;

  return {
    from: $from.start(),
    to: $from.pos,
    query,
    left: coords.left,
    bottom: coords.bottom,
  };
}

/**
 * 把「触发状态 + 键盘」接成 ProseMirror 插件。
 *
 * 为什么不在这里直接做菜单：菜单是 React 组件，要参与渲染与 hover 态；
 * 这里只负责「什么时候该开、按键交给谁」，保持关注点分开。
 */
export function createSlashPlugin(opts: {
  onAnchor: (anchor: SlashAnchor | null) => void;
  /** 返回 true 表示这个键已被菜单吃掉，编辑器不要再处理 */
  onKey: (event: KeyboardEvent) => boolean;
}): Plugin {
  return new Plugin({
    view: () => ({
      update(next) {
        opts.onAnchor(detectSlash(next.state, next));
      },
      destroy() {
        opts.onAnchor(null);
      },
    }),
    props: {
      handleKeyDown: (_view, event) => opts.onKey(event),
    },
  });
}

export type SlashKind =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bullet'
  | 'ordered'
  | 'task'
  | 'quote'
  | 'code'
  | 'table'
  | 'hr';

export interface SlashItemDef {
  kind: SlashKind;
  /** 菜单主文案 */
  label: string;
  /** 右侧灰色说明 */
  hint: string;
  /** 额外的检索词：英文名、常见别名（中文主文案本身也会被检索） */
  keywords: string[];
}

export const SLASH_ITEMS: SlashItemDef[] = [
  { kind: 'h1', label: '一级标题', hint: 'H1', keywords: ['h1', 'title', 'biaoti'] },
  { kind: 'h2', label: '二级标题', hint: 'H2', keywords: ['h2', 'biaoti'] },
  { kind: 'h3', label: '三级标题', hint: 'H3', keywords: ['h3', 'biaoti'] },
  { kind: 'bullet', label: '无序列表', hint: '•', keywords: ['bullet', 'list', 'ul', 'liebiao'] },
  { kind: 'ordered', label: '有序列表', hint: '1.', keywords: ['ordered', 'ol', 'number', 'liebiao'] },
  { kind: 'task', label: '任务清单', hint: '☑', keywords: ['task', 'todo', 'check', 'qingdan'] },
  { kind: 'quote', label: '引用', hint: '❝', keywords: ['quote', 'blockquote', 'yinyong'] },
  { kind: 'code', label: '代码块', hint: '```', keywords: ['code', 'pre', 'daima'] },
  { kind: 'table', label: '表格', hint: '3×3', keywords: ['table', 'biaoge'] },
  { kind: 'hr', label: '分割线', hint: '---', keywords: ['hr', 'divider', 'line', 'fenge'] },
];

/**
 * 按查询词过滤。
 *
 * - 空查询 → 全部
 * - 主文案用 `includes`：中文里「标题」要能命中「一级标题」
 * - 关键词用 `startsWith`：否则 `biao` 会把「列表」（`liebiao`）也召回来，
 *   拼音检索就失去意义了
 */
export function filterSlashItems(query: string): SlashItemDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.label.toLowerCase().includes(q) ||
      item.keywords.some((k) => k.startsWith(q)),
  );
}
