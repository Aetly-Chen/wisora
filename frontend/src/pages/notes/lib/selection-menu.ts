import { $prose } from '@milkdown/utils';
import { Plugin } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import type { EditorState } from '@milkdown/prose/state';

/**
 * 「选中文本 → 右键 → 问 Agent」的编辑器侧。
 *
 * 两件事：① 把选区摘出来交给宿主；② 提供「把 AI 的改写结果写回选区」的入口。
 * 都不碰 UI、不发请求。
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

/**
 * 当前编辑器 view（最近一次真实交互时记下的那个）。
 *
 * ⚠️ 别在 `$prose` 工厂里取：那里拿到的 `editorViewCtx` 是 Milkdown 建实例时的
 * **临时 view**，建完就被替换/销毁了。真机上表现为点「应用到选区」抛
 * `Cannot destructure property 'doc' of 'view.state' as it is undefined`。
 * 所以改成「用户每次在编辑器里按下鼠标/右键时记一份」，那时拿到的必然是活的。
 */
let currentView: EditorView | null = null;

export type ReplaceResult = 'ok' | 'stale' | 'no-view';

/**
 * 把改写结果写回某个区间。
 *
 * ⚠️ 必须先校验锚点：AI 流式输出要几秒到几十秒，这期间用户可能继续编辑，
 * `from/to` 早就漂了。原文对不上就**不写**，让调用方提示用户，而不是
 * 把错位的内容插进文档 —— 那是最难被用户发现的一类破坏。
 *
 * 成功时走 `tr.insertText`，自动进入 undo 栈（Cmd+Z 可撤销）；
 * 之后 `markdownUpdated` 会触发 store 的 editContent → 自动保存，不用另外处理。
 */
export function replaceRange(params: {
  from: number;
  to: number;
  expected: string;
  text: string;
}): ReplaceResult {
  const view = currentView;
  // 被销毁的 view 上 `state` 是 undefined —— 当成不可用，别让异常冒出去
  if (!view || !view.state) return 'no-view';

  const { from, to, expected, text } = params;
  const { doc } = view.state;
  if (to > doc.content.size) return 'stale';

  // 只比空白归一化后的文本：Markdown 里软换行/行尾空格不该导致「对不上」
  const normalize = (v: string) => v.replace(/\s+/g, ' ').trim();
  if (normalize(doc.textBetween(from, to, '\n')) !== normalize(expected)) {
    return 'stale';
  }

  view.dispatch(view.state.tr.insertText(text, from, to).scrollIntoView());
  view.focus();
  return 'ok';
}

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
          // 每次按下鼠标都记一份：这是最便宜的「拿到活 view」的时机
          mousedown(view: EditorView) {
            currentView = view;
            return false;
          },
          contextmenu(view: EditorView, event: Event) {
            currentView = view;
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
