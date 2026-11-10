import { $prose } from '@milkdown/utils';
import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { EditorState } from '@milkdown/prose/state';

/**
 * 「选中文本 → 右键 → 问 Agent」的编辑器侧。
 *
 * 这里只做一件事：**把选区摘出来交给宿主**，不碰 UI、不发请求。
 * 菜单与发送都在页面层（工作台），因为：
 * - 菜单要用已有的 `components/ContextMenu`（视口收缩/键盘/焦点都做好了）
 * - 「发给谁」是页面的事：`/notes` 里没有 Agent 面板，`/workbench` 右侧才有
 *
 * 为什么用模块级 setter 而不是 props 传进插件：
 * 插件在编辑器构建时创建，而回调随页面变化；照 `lib/find.ts` 的
 * `setFind` 同一套路（模块级桥 + 插件里读），避免为它重建整个编辑器。
 */
export interface SelectionPayload {
  /** 选中的纯文本（块之间用换行连接） */
  text: string;
  /** ProseMirror 文档位置，供将来「回写」使用 */
  from: number;
  to: number;
  /** 右键时的视口坐标，菜单据此定位 */
  x: number;
  y: number;
  /**
   * 选区是否落在同一个块内。
   *
   * 「改写」只支持单块：跨块的选区被 AI 改写成一段纯 Markdown 后
   * `insertText` 会把结构拍平（标题+列表变成一个段落），不如先不做。
   */
  singleBlock: boolean;
}

type Handler = (payload: SelectionPayload) => void;

let handler: Handler | null = null;

/** 由页面在挂载时注册、卸载时传 null 清掉 */
export function setSelectionMenuHandler(fn: Handler | null): void {
  handler = fn;
}

/**
 * 选区是否只覆盖一个文本块（用于判断「改写」能不能安全回写）。
 *
 * 为什么不直接 `$from.sameParent($to)`：三击选段落、或从段尾往下拖一点，
 * 选区会把**块结束标记**吃进去，`to` 落在下一块的开头 → sameParent 为 false，
 * 于是「改写」在最常见的手势下反而被禁用。
 *
 * 所以先看一个更直接的判据：`textBetween` 用 '
' 作块间分隔符，
 * **选区文本里没有换行**就说明没跨块（三击段落正是这种情况）。
 * 再退一步才去数非空文本块（应对块内软换行这类情况）。
 */
function isSingleBlock(state: EditorState): boolean {
  const { from, to } = state.selection;
  let count = 0;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock || node.content.size === 0) return true;
    count += 1;
    // 已经两块了，没必要继续遍历
    return count < 2;
  });
  return count <= 1;
}

export const selectionMenuPlugin = $prose(
  () =>
    new Plugin({
      props: {
        handleDOMEvents: {
          contextmenu(view: EditorView, event: Event) {
            if (!handler) return false;
            const mouse = event as MouseEvent;
            const { selection } = view.state;

            // 没选中就把右键还给浏览器（查找、拼写检查还得用）
            if (selection.empty) return false;

            const text = view.state.doc.textBetween(selection.from, selection.to, '\n');
            if (!text.trim()) return false;

            event.preventDefault();
            handler({
              text,
              from: selection.from,
              to: selection.to,
              x: mouse.clientX,
              y: mouse.clientY,
              singleBlock: !text.trim().includes('\n') || isSingleBlock(view.state),
            });
            return true;
          },
        },
      },
    }),
);
