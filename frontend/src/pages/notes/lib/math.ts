import { $inputRule, $node, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
import remarkMathPlugin from 'remark-math';
import katex from 'katex';

/**
 * 公式支持（行内 `$…$` + 块级 `$$…$$`）。
 *
 * 为什么不是装插件：`@milkdown/plugin-math` 在 7.22 这一代已经不再发布
 * （最高只到 7.5.9，与 core 7.22 的 ctx 不兼容），官方 crepe 也是自己用
 * `remark-math` + `katex` 拼出来的。所以这里按同样的路子自己接：
 *
 *   remark-math  负责把 `$…$` 解析成 mdast 的 `inlineMath` / `math`
 *   $node        负责 ProseMirror 侧的两个 atom 节点，以及双向映射
 *   toDOM        直接调 KaTeX 渲染
 *
 * ⚠️ 为什么在 `toDOM` 里渲染、而不是写 NodeView：`$view` 的注册发生在
 * `await ctx.wait(SchemaReady)` 之后，而 EditorView 构造时读的是当时的
 * `nodeViewCtx` 快照 —— 两个 handler 是并行跑的，谁先完成不定。实测在
 * 7.22 上必输，结果就是「节点是 math 节点、DOM 却是纯文本」。crepe 的
 * latex feature 也没用 NodeView，一样在 `toDOM` 里 `katex.render`。
 *
 * ⚠️ 文档契约：`Note.content` 必须是 Markdown，公式在库里的形态就是
 * `$x^2$` / `$$…$$`。序列化一旦写成别的形态，存量笔记会被整体改写，
 * RAG 的切块与 AI 工具读到的内容也跟着变 —— 所以 handlers 只加这两个，
 * 其余仍走 remark 默认。
 */
export const remarkMath = $remark('remarkMath', () => remarkMathPlugin);

/**
 * 渲染到指定容器。
 *
 * `throwOnError: false` 是刻意的：写错一个 `\frac` 不该让整个编辑器炸掉，
 * 让 KaTeX 自己渲染成红字错误提示，用户还看得见自己写了什么。
 */
function renderInto(dom: HTMLElement, value: string, displayMode: boolean): void {
  if (!value.trim()) return; // 空公式留给 CSS 的 :empty 占位
  try {
    katex.render(value, dom, { throwOnError: false, displayMode, output: 'html' });
  } catch {
    // 理论上 throwOnError:false 不会抛，留一层兜底避免单条公式带崩整篇渲染
    dom.textContent = value;
  }
}

/** 行内公式：`$E = mc^2$` */
export const mathInlineSchema = $node('math_inline', () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-math-inline]',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.mathInline ?? '' }),
    },
  ],
  toDOM: (node) => {
    const dom = document.createElement('span');
    dom.className = 'md-math-inline';
    dom.dataset.mathInline = node.attrs.value;
    renderInto(dom, node.attrs.value, false);
    return dom;
  },
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'inlineMath',
    runner: (state: any, node: any, type: any) => {
      state.addNode(type, { value: String(node.value ?? '') });
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'math_inline',
    // ⚠️ 序列化侧的签名是 addNode(type, children, value, props)，
    // 不是解析侧的 addNode(type, attrs, content)。把 attrs 塞在第二参会
    // 被当成 children 去 reduce，整个编辑器挂掉（children.reduce is not a function）。
    runner: (state: any, node: any) => {
      state.addNode('inlineMath', undefined, String(node.attrs.value ?? ''));
    },
  },
}));

/** 块级公式：`$$ … $$` */export const mathBlockSchema = $node('math_block', () => ({
  group: 'block',
  atom: true,
  selectable: true,
  attrs: { value: { default: '' } },
  parseDOM: [
    {
      tag: 'div[data-math-block]',
      getAttrs: (dom: HTMLElement) => ({ value: dom.dataset.mathBlock ?? '' }),
    },
  ],
  toDOM: (node) => {
    const dom = document.createElement('div');
    dom.className = 'md-math-block';
    dom.dataset.mathBlock = node.attrs.value;
    renderInto(dom, node.attrs.value, true);
    return dom;
  },
  parseMarkdown: {
    match: ({ type }: { type: string }) => type === 'math',
    runner: (state: any, node: any, type: any) => {
      state.addNode(type, { value: String(node.value ?? '') });
    },
  },
  toMarkdown: {
    match: (node: any) => node.type.name === 'math_block',
    runner: (state: any, node: any) => {
      state.addNode('math', undefined, String(node.attrs.value ?? ''));
    },
  },
}));

/**
 * 输入 `$…$` 时即时转成公式节点。
 *
 * 为什么必须有这条规则：**remark-stringify 会把用户手打的 `$` 转义成 `\$`**
 * （remark-math 把 `$` 加进了 unsafe 字符集）。也就是说「纯文本写的公式」
 * 存进库是 `\$y^2\$`，再打开时已经不再是公式了 —— 用户永远造不出公式。
 * 真机实测确认过这一点，所以入口只能走 input rule：转成节点后由我们自己的
 * handler 序列化成 `$y^2$`，才是干净可回读的形态。
 *
 * `inCode` 默认 false，代码块里打 `$` 不会触发，不用额外判断。
 */
export const mathInlineInputRule = $inputRule((ctx) => {
  const type = mathInlineSchema.type(ctx);
  return new InputRule(
    /\$([^$\n]+)\$$/,
    (state, match, start, end) => {
      const value = match[1] ?? '';
      if (!value.trim()) return null;
      // 替换范围正好是 [开 $, 闭 $]，换成一个 1 宽的 atom 后光标自然落到它右边
      return state.tr.replaceWith(start, end, type.create({ value }));
    },
  );
});

