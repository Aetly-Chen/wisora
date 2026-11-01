import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorState } from '@milkdown/prose/state';
import type { Node as PMNode } from '@milkdown/prose/model';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

/**
 * 查找替换的「文档侧」：算命中区间、给命中画装饰。
 *
 * 为什么不用浏览器自带的 `window.find`：它选中的是 DOM 文本，
 * 拿不到 ProseMirror 的位置，替换就没法落成一次事务（撤销会变成一串碎操作）。
 */

export interface FindMatch {
  from: number;
  to: number;
}

export interface FindState {
  query: string;
  matches: FindMatch[];
  /** 当前高亮第几个，-1 表示没有 */
  current: number;
}

export const findKey = new PluginKey<FindState>('notes-find');

const EMPTY: FindState = { query: '', matches: [], current: -1 };

/**
 * 在一篇文档里找 `query`。
 *
 * 逐**文本块**拼字符串，同时记下每个字符的文档位置 —— 这样跨 inline 节点
 * （`**加粗**` 切开的两段文字）也能命中，而位置仍然对得上。
 *
 * 非文本的 inline 节点（图片、行内公式）占一个占位符：占位符不会等于
 * 任何查询词，但能让后面的字符位置保持正确。
 */
export function findMatches(doc: PMNode, query: string): FindMatch[] {
  if (!query) return [];

  const needle = query.toLowerCase();
  const out: FindMatch[] = [];

  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;

    const chars: string[] = [];
    const posAt: number[] = [];

    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText) {
        const text = child.text ?? '';
        for (let i = 0; i < text.length; i += 1) {
          chars.push(text[i]);
          posAt.push(start + i);
        }
      } else {
        chars.push('\u0000');
        posAt.push(start);
      }
    });

    const joined = chars.join('').toLowerCase();
    let index = joined.indexOf(needle);
    while (index !== -1) {
      out.push({
        from: posAt[index],
        to: posAt[index + needle.length - 1] + 1,
      });
      index = joined.indexOf(needle, index + needle.length);
    }

    // 文本块已经处理完，不需要再往里走
    return false;
  });

  return out;
}

/** 把「查询词 / 当前项」写进插件状态 */
export function setFind(state: EditorState, patch: Partial<FindState>) {
  return state.tr.setMeta(findKey, patch);
}

/**
 * 装饰 + 状态维护。
 *
 * 状态在这里重算，而不是在 React 里：文档一变（包括被 AI 工具改写），
 * 命中区间必须跟着变，否则高亮会落在错的位置上。
 */
export function createFindPlugin(opts: {
  onState: (state: FindState) => void;
}): Plugin {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => EMPTY,
      apply(tr, prev, _old, next) {
        const patch = tr.getMeta(findKey) as Partial<FindState> | undefined;

        let next_ = patch ? { ...prev, ...patch } : prev;

        // 查询词变了 → 从头算
        if (patch && patch.query !== undefined) {
          const matches = findMatches(next.doc, next_.query);
          next_ = { ...next_, matches, current: matches.length > 0 ? 0 : -1 };
        } else if (tr.docChanged && prev.query) {
          const matches = findMatches(next.doc, prev.query);
          next_ = {
            ...next_,
            matches,
            current: matches.length > 0
              ? Math.min(Math.max(prev.current, 0), matches.length - 1)
              : -1,
          };
        }

        return next_;
      },
    },
    view: () => ({
      update: (view) => opts.onState(findKey.getState(view.state) ?? EMPTY),
    }),
    props: {
      decorations(state) {
        const s = findKey.getState(state);
        if (!s || s.matches.length === 0) return null;
        return DecorationSet.create(
          state.doc,
          s.matches.map((m, i) =>
            Decoration.inline(m.from, m.to, {
              class:
                i === s.current ? 'find-hit find-hit-current' : 'find-hit',
            }),
          ),
        );
      },
    },
  });
}
