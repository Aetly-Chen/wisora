import React, { useEffect, useRef } from 'react';
import {
  Editor,
  defaultValueCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { prism, prismConfig } from '@milkdown/plugin-prism';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Plugin } from '@milkdown/prose/state';
// 副作用导入：注册 jsx / tsx 与一批别名。Prism 插件用的是**同一个** refractor
// 实例（模块单例），所以这里注册完，插件那边直接能查到。
import { sharedRefractor } from '@/lib/code-highlight';
import './markdown-editor.css';

/** 复制按钮：编辑区与预览区样式一致，行为也一致 */
function createCopyButton(getCode: () => string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.contentEditable = 'false';
  btn.textContent = '复制';

  /*
   * mousedown 必须 preventDefault。
   * 否则点按钮时浏览器先把光标移到按钮上 —— 代码块失焦、
   * 浮动工具条消失，接着 click 又触发一次重排，观感是「点了没反应」。
   */
  btn.addEventListener('mousedown', (e) => e.preventDefault());

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const text = getCode();
    if (!text) return;

    void navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '已复制';
      btn.dataset.state = 'done';
      window.setTimeout(() => {
        btn.textContent = '复制';
        delete btn.dataset.state;
      }, 1400);
    });
  });

  return btn;
}

/**
 * 任务清单可勾选。
 *
 * gfm preset 把任务项渲染成 `li[data-item-type="task"][data-checked]`，
 * 那个方框是 `span::before` 画的 —— **纯 CSS 装饰，没有真实 input**，
 * 所以默认点不动，勾选状态只能靠改 Markdown 源码。
 *
 * 这里刻意不改成真实 `<input type="checkbox">`：那要推翻 preset 的 toDOM
 * 并重写整套列表样式，等于为了一个交互和内置实现打架。
 * 改为在 click 上判定「点的位置是不是方框那一块」——
 * 方框画在 `span` 左侧（负 margin），所以 `clientX` 落在 span 左边界之外
 * 就是点在框上；点文字照常交给 ProseMirror 放光标。
 */
const taskCheckboxPlugin = new Plugin({
  props: {
    handleClick(view, _pos, event) {
      const target = event.target as HTMLElement | null;
      const item = target?.closest?.('li[data-item-type="task"]') as HTMLElement | null;
      if (!item) return false;

      /*
       * 任务项的内容容器是 `<p>`，不是 `<span>` ——
       * 这是 gfm preset 现在的 toDOM（`['li', ['p', 0]]`），
       * 原样式表里写的 `> span` 从来没匹配上（方框一直没画出来）。
       * 两种都认，避免再被结构变化坑一次。
       */
      const label = item.querySelector(':scope > p, :scope > span');
      if (!label) return false;

      /*
       * 方框是 `p::before` —— 在 `<p>` **内容区的最左边**，不是 p 的外面。
       * 它宽 13px、margin-right 0.5em（≈6.5px），所以水平方向前 19px 属于方框。
       * 落在这个区间内算点方框，右边一律交给 ProseMirror 放光标。
       */
      const rect = label.getBoundingClientRect();
      if (event.clientX < rect.left - 2 || event.clientX >= rect.left + 19) return false;

      const $pos = view.state.doc.resolve(view.posAtDOM(item, 0));
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.name !== 'list_item') continue;

        const itemPos = $pos.before(depth);
        const node = view.state.doc.nodeAt(itemPos);
        if (!node || node.attrs.checked == null) return false;

        view.dispatch(
          view.state.tr.setNodeMarkup(itemPos, undefined, {
            ...node.attrs,
            checked: !node.attrs.checked,
          }),
        );

        /*
         * handleClick 返回 true 会阻止浏览器的默认聚焦，
         * 勾完再打字发现输入不进去。补一次 focus。
         */
        view.focus();
        return true;
      }
      return false;
    },
  },
});

interface CodeBlockNode {
  type: { name: string };
  attrs: { language?: string | null };
}

/**
 * `code_block` 的自定义渲染。
 *
 * 为什么必须用 NodeView 而不是在 ProseMirror 外面加点缀：
 * 代码块的 DOM 由编辑器全权重渲染，任何手动 `appendChild` 进去的节点
 * 都会在下一次 re-render 时被丢掉。NodeView 是唯一能稳定持有额外 DOM
 * 的位置。
 *
 * `contentDOM` 指向 `<code>`，因此 Prism 的 inline decoration 仍然作用在
 * 正确的文本节点上 —— 高亮和按钮互不干扰。
 */
function codeBlockNodeView(initialNode: CodeBlockNode) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  const langLabel = document.createElement('span');
  const btn = createCopyButton(() => code.textContent ?? '');

  langLabel.className = 'code-lang';
  // 顺序有意义：按钮绝对定位，标签跟在 code 后面、不参与正文流
  pre.append(code, langLabel, btn);

  const sync = (node: CodeBlockNode) => {
    const language = (node.attrs.language ?? '').trim();
    langLabel.textContent = language;
    langLabel.hidden = language === '';
  };
  sync(initialNode);

  return {
    dom: pre,
    contentDOM: code,
    update(node: CodeBlockNode) {
      if (node.type.name !== 'code_block') return false;
      sync(node);
      return true;
    },
  };
}/** 编辑器内部：Milkdown 实例必须活在 Provider 里面 */
const Inner: React.FC<{
  /** 仅作初始值。之后的正文变化由编辑器自己产生，不再回灌 —— 见下方说明 */
  initialValue: string;
  onChange: (markdown: string) => void;
}> = ({ initialValue, onChange }) => {
  /*
   * 用 ref 转一层，而不是把 onChange 塞进 useEditor 的依赖数组。
   *
   * 依赖数组一变，useEditor 会销毁重建整个 ProseMirror 实例 ——
   * 表现就是「每敲一个字光标跳到开头」。而父级每次渲染都会传一个新的
   * 回调函数（inline arrow），所以这个 ref 是必须的。
   */
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /*
   * 初始值同样只读一次。
   *
   * 这里刻意**不**把父级传下来的 value 持续同步进编辑器：
   * 编辑 → 回调 → store 更新 → 新 value → 回灌编辑器，
   * 这条环会让光标在每次输入后跳位。
   * 切换笔记靠外层 `key={note.id}` 强制重挂载，而不是同步内容。
   */
  const initialRef = useRef(initialValue);

  const { loading } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialRef.current);

          /*
           * 序列化选项：把无序列表符号和分隔线改回 `-` / `---`。
           *
           * remark 默认输出 `*` 开头、`***` 分隔线 —— 渲染上等价，但会让
           * **每一篇存量笔记在第一次编辑后被整体改写一遍**，看着像被动了手脚。
           *
           * ⚠️ 必须用 `update` 合并、不能用 `set`：这个 ctx 的默认值里还带着
           * `handlers`（ProseMirror 节点 → mdast 的映射）与 `encode: []`，
           * 直接 set 一个只含 bullet/rule 的对象会把它们冲掉 —— 代码块会退化成
           * 缩进式、表格和图片直接序列化失败。这一点在探针里实测确认过。
           */
          ctx.update(remarkStringifyOptionsCtx, (prev) => ({
            ...prev,
            bullet: '-',
            rule: '-',
          }));

          /*
           * 代码高亮。
           *
           * `configureRefractor` 的默认实现是空函数，插件内部直接用的是
           * refractor 的模块单例 —— 而 jsx / tsx 与那批别名已经在
           * `@/lib/code-highlight` 里注册过一次，这里把同一个实例显式交回去，
           * 保证「注册过」和「用来高亮」的是同一个对象。
           *
           * 用 `update` 合并而不是 `set`：这个 ctx 的类型是 Options 对象，
           * 将来插件加字段时 set 会静默丢掉新字段。
           */
          ctx.update(prismConfig.key, (prev) => ({
            ...prev,
            configureRefractor: () => sharedRefractor,
          }));

          /*
           * 接管 code_block 的渲染，放进复制按钮与语言标签。
           *
           * 只覆盖 `code_block`，其余节点仍走 preset 默认实现 ——
           * nodeViews 是「按节点名覆盖」，不需要把默认的抄一遍。
           */
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            nodeViews: {
              ...prev.nodeViews,
              code_block: codeBlockNodeView,
            },
          }));

          // 任务清单勾选（见 taskCheckboxPlugin 的说明）
          ctx.update(prosePluginsCtx, (prev) => [...prev, taskCheckboxPlugin]);

          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(prism)
        .use(history)
        .use(listener),
    [],
  );

  return (
    /*
     * `md-body` 不能少：编辑区的标题/列表/表格/引用排版全部复用预览区那套规则，
     * 这样「所见」和「所得」才是同一套字号与间距。
     * 少了这个类，ProseMirror 会退化成浏览器默认样式（标题不放大、列表没圆点）。
     */
    <div className="md-editor-shell md-body">
      {loading && (
        <div className="md-editor-loading" aria-hidden>
          编辑器加载中…
        </div>
      )}
      <Milkdown />
    </div>
  );
};

/**
 * 所见即所得 Markdown 编辑器（Milkdown / ProseMirror）。
 *
 * **数据契约不变**：进来是 Markdown 字符串，出去也是 Markdown 字符串。
 * 后端 `rag/chunk.ts` 按 `#{1,4}` 切块、AI 工具按 md 文本读写、
 * 导入导出以 `.md` 为契约 —— 所以这里绝不能用块 JSON 做存储格式。
 *
 * 换笔记时请在外层用 `key={note.id}`，不要依赖 `initialValue` 变化。
 */
export const MarkdownEditor: React.FC<{
  initialValue: string;
  onChange: (markdown: string) => void;
}> = ({ initialValue, onChange }) => (
  <MilkdownProvider>
    <Inner initialValue={initialValue} onChange={onChange} />
  </MilkdownProvider>
);
