import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorState } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { EditorView } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';

/**
 * 双向链接：正文里的 `[[标题]]` 渲染成可点的引用块。
 *
 * 存储上是**纯文本** —— `Note.content` 里就是 `[[标题]]`，没有自定义节点、
 * 没有链接表。理由见 `docs/notes-editor-redesign.md` §11：
 *
 * - 纯文本意味着原文可读、可搜索，RAG 切块和 AI 工具不用为它加任何逻辑；
 * - 不建链接表就不存在「表与正文不一致」，也不用后台抽取任务；
 * - 代价是**标题改名旧引用就断**（和 Obsidian 不带别名的 `[[标题]]` 一致）。
 *
 * ⚠️ 用装饰而不是自定义节点：`[[…]]` 是行内文本，做成 atom 会打断输入
 * （打一半就被吃掉）。装饰只在观感层加个 class，源码一个字都不动。
 */

/** 标题最长 120 字（与后端 TITLE_MAX_LENGTH 对齐），这里放宽到能吃满 */
const WIKILINK_RE = /\[\[([^[\]\n]{1,120})\]\]/g;

export interface WikilinkOptions {
  /** 标题 → 笔记 id；找不到返回 undefined（渲染成「未解析」样式） */
  resolve: (title: string) => string | undefined;
  /** 点击已解析的引用时调用 */
  open: (id: string) => void;
}

function buildDecorations(doc: ProseNode, opts: WikilinkOptions): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return true;
    // 文本节点在第 `pos` 个位置开始，第 i 个字符的文档位置就是 `pos + i`
    // （别加 1 —— 加了会整体右移一格，chip 少吞一个 `[`、多吞一个标点，实测踩过）
    for (const match of node.text.matchAll(WIKILINK_RE)) {
      const start = pos + (match.index ?? 0);
      const end = start + match[0].length;
      const title = match[1];
      const known = opts.resolve(title) !== undefined;
      decorations.push(
        Decoration.inline(start, end, {
          class: known ? 'md-wikilink' : 'md-wikilink md-wikilink--missing',
          title: known ? `打开「${title}」` : `找不到标题为「${title}」的笔记`,
        }),
      );
    }
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

/** 从点击到的元素上还原标题 —— 比用 pos 反推稳，装饰 span 里就是原文 */
function titleFromTarget(target: EventTarget | null): string | null {
  const el = (target as HTMLElement | null)?.closest?.('.md-wikilink');
  return el ? (el.textContent ?? '').replace(/^\[\[|\]\]$/g, '') : null;
}

export function createWikilinkPlugin(opts: WikilinkOptions): Plugin {
  const key = new PluginKey('wikilink');
  return new Plugin({
    key,
    state: {
      init: (_config, state) => buildDecorations(state.doc, opts),
      apply: (tr, value, _old, newState) =>
        tr.docChanged ? buildDecorations(newState.doc, opts) : value,
    },
    props: {
      decorations(state) {
        return key.getState(state) ?? DecorationSet.empty;
      },
      /**
       * 只吃「点中已解析引用」这一种情况。
       *
       * 未解析的引用返回 false，让 ProseMirror 走默认行为（选中文本），
       * 否则用户点一下就被吞掉、光标也没了。
       */
      handleClick(_view, _pos, event) {
        const title = titleFromTarget(event.target);
        if (!title) return false;
        const id = opts.resolve(title);
        if (!id) return false;
        event.preventDefault();
        opts.open(id);
        return true;
      },
    },
  });
}

/* ---------------- `[[` 触发选笔记 ---------------- */

export interface WikilinkAnchor {
  /** 第一个 `[` 的文档位置（插入时要连同它一起替换） */
  from: number;
  /** 光标位置 */
  to: number;
  /** `[[` 之后已经输入的内容，用来过滤笔记 */
  query: string;
  /** 菜单锚点的视口坐标（菜单用 position: fixed 定位） */
  left: number;
  bottom: number;
}

/**
 * 光标前是不是「正在输入 `[[…`」。
 *
 * 只看**当前文本块**内、光标之前的文字：`[[` 出现在前面段落里不该弹菜单。
 * 查询词里一旦出现 `[` / `]` / 换行就认为不是链接了（用户大概率在写
 * `[[1,2],[3,4]]` 这种矩阵），菜单自己关掉。
 */
export function detectWikilink(
  state: EditorState,
  view: EditorView,
): WikilinkAnchor | null {
  const { selection } = state;
  if (!selection.empty) return null;

  const { $from } = selection;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return null;

  const before = $from.parent.textContent.slice(0, $from.parentOffset);
  const match = /\[\[([^[\]\n]{0,60})$/.exec(before);
  if (!match) return null;

  const coords = view.coordsAtPos($from.pos);
  if (!coords || coords.left == null || coords.bottom == null) return null;

  return {
    from: $from.start() + match.index,
    to: $from.pos,
    query: match[1],
    left: coords.left,
    bottom: coords.bottom,
  };
}

/**
 * 把 `[[query` 整段换成 `[[标题]]`。
 *
 * 用 `insertText` 而不是插节点：链接在文档里就是文本，换完光标自然落在
 * `]]` 后面，继续打字是正文。
 */
export function insertWikilink(view: EditorView, anchor: WikilinkAnchor, title: string): void {
  view.dispatch(view.state.tr.insertText(`[[${title}]]`, anchor.from, anchor.to));
}

/**
 * 触发/键盘插件：和斜杠命令那套同构 —— 这里只负责「什么时候该开、
 * 按键交给谁」，菜单是 React 组件（见 SlashMenu）。
 */
export function createWikilinkSuggestPlugin(opts: {
  onAnchor: (anchor: WikilinkAnchor | null) => void;
  onKey: (event: KeyboardEvent) => boolean;
}): Plugin {
  return new Plugin({
    key: new PluginKey('wikilink-suggest'),
    view: () => ({
      update(next) {
        opts.onAnchor(detectWikilink(next.state, next));
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

/* ---------------- 序列化侧的转义 ---------------- */

/**
 * remark-stringify 会把正文里的 `[[` 转义成 `\[\[`。
 *
 * 因为 `[` 在 Markdown 里是链接起点，serializer 一律保守转义。后果是：
 * 用户打的 `[[周报]]` 存进库变成 `\[\[周报]]` —— 读回来虽然还能渲染成 chip
 * （反解析会把 `\[` 还原成 `[`），但**后端按 `content.includes('[[标题]]')`
 * 匹配反链时会全部落空**（真机验出来的：库里就是 `\[\[周报 2026-11]]`，
 * 而目标笔记的反链面板是空的）。
 *
 * 所以在交给上层保存之前把这种转义还原掉。
 *
 * ⚠️ 用 `split/join` 而不是正则字面量：这个模式里「一个反斜杠 + 一个 `[`」
 * 在正则字面量里要写成三个反斜杠，落到文件里极易被某层转义吃掉一个，
 * 变成非法正则（`Unmatched ')'`）—— 整页白屏，而且只有打开笔记才暴露。
 * 普通字符串没有这个问题。
 */
const ESCAPED_OPEN = '\\[\\[';

export function unescapeWikilinks(markdown: string): string {
  return markdown.split(ESCAPED_OPEN).join('[[');
}
