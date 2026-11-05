import { Plugin, PluginKey } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
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
