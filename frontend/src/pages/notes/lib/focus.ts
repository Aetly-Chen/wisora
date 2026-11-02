import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { Decoration, DecorationSet } from '@milkdown/prose/view';

/**
 * 专注模式。
 *
 * 两个效果，都只影响**观感**，不碰文档：
 * 1. 只高亮光标所在的那一段（顶层的块），其余淡化 —— 由 CSS 按
 *    `.focus-block` 决定，这里只负责标出「当前是哪一块」
 * 2. 打字机滚动：光标跑出「中间带」就把容器滚回来，让正在写的那行
 *    始终停在视口偏上位置
 *
 * 为什么块级装饰而不是逐字符：笔记是长段落写作，按段淡化比按行淡化
 * 更稳（不会因为一行折行就闪）。
 */
export function createFocusPlugin(opts: {
  /** 用 getter 而不是布尔值：插件只在创建时捕获一次，开关会变 */
  isEnabled: () => boolean;
}): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        if (!opts.isEnabled()) return null;

        const { $from } = state.selection;
        if ($from.depth < 1) return null;

        // 光标所在的**顶层块**（段落 / 标题 / 列表 / 引用 / 代码块…）
        const pos = $from.before(1);
        const node = state.doc.nodeAt(pos);
        if (!node) return null;

        return DecorationSet.create(state.doc, [
          Decoration.node(pos, pos + node.nodeSize, { class: 'focus-block' }),
        ]);
      },
    },
    view: () => ({
      update(view, prev) {
        if (!opts.isEnabled()) return;
        if (prev.doc.eq(view.state.doc) && prev.selection.eq(view.state.selection)) {
          return;
        }
        keepCaretInBand(view);
      },
    }),
  });
}

/** 光标离开「视野中间带」时把滚动容器拉回来 */
function keepCaretInBand(view: EditorView): void {
  const shell = view.dom.closest('.md-editor-shell') as HTMLElement | null;
  if (!shell) return;

  let caret: { top: number; bottom: number };
  try {
    caret = view.coordsAtPos(view.state.selection.head);
  } catch {
    // 文档刚被清空 / 还没布局时拿不到坐标，下一次 update 再说
    return;
  }

  const rect = shell.getBoundingClientRect();
  if (rect.height === 0) return;

  const bandTop = rect.top + rect.height * 0.22;
  const bandBottom = rect.top + rect.height * 0.62;
  if (caret.top >= bandTop && caret.bottom <= bandBottom) return;

  /*
   * 直接把光标推到 38% 高度处。
   * 不用 `scrollIntoView`：它会把整块滚到顶部（长段落时等于跳页），
   * 打字机滚动的诉求恰恰是「细碎地跟着走」。
   */
  shell.scrollTop += caret.top - (rect.top + rect.height * 0.38);
}
