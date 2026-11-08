import { $inputRule, $node, $remark } from '@milkdown/utils';
import { InputRule } from '@milkdown/prose/inputrules';
import remarkMathPlugin from 'remark-math';

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
 * KaTeX 懒加载。
 *
 * KaTeX 本体（含字体样式）约 250 kB，而**大多数笔记里没有公式**。
 * 静态 import 会把它算进编辑器 chunk，谁打开笔记都要先下它 ——
 * 所以拆成动态 import：只有内容里真的出现 `$` 时才下载
 * （见 `MarkdownEditor` 顶部那道 katexReady 门）。
 *
 * JS 与 CSS 一起 import：只加载 JS 的话，`renderToString` 出来的 HTML
 * 没有 KaTeX 的规则与字体，会先看到一团排错的公式。
 */
type Katex = {
  renderToString: (
    value: string,
    options: { throwOnError: boolean; displayMode: boolean; output: 'html' },
  ) => string;
};

let katexPromise: Promise<Katex> | null = null;

export function preloadKatex(): Promise<Katex> {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
      ([mod]) => ((mod as unknown as { default?: Katex }).default ?? (mod as unknown as Katex)),
    );
  }
  return katexPromise;
}

/**
 * 渲染结果缓存：`toDOM` 每次重绘（光标移动、撤销都可能触发）都会走一遍，
 * 同一份源码不该重复算。键带上 displayMode —— 行内和块级的输出不同。
 */
const htmlCache = new Map<string, string>();

/**
 * 渲染到指定容器。
 *
 * `throwOnError: false` 是刻意的：写错一个 `\frac` 不该让整个编辑器炸掉，
 * 让 KaTeX 自己渲染成红字错误提示，用户还看得见自己写了什么。
 *
 * 还没加载完时先按源码显示，加载好再替换 —— 只有「打开后才开始打公式」
 * 才会走到这一支（打开时就有的公式，外层已经等 KaTeX 就位了）。
 */
function renderInto(dom: HTMLElement, value: string, displayMode: boolean): void {
  if (!value.trim()) return; // 空公式留给 CSS 的 :empty 占位

  const key = `${displayMode ? 'b' : 'i'}:${value}`;
  const cached = htmlCache.get(key);
  if (cached !== undefined) {
    dom.innerHTML = cached;
    return;
  }

  dom.textContent = value;
  void preloadKatex().then((katex) => {
    let html: string;
    try {
      html = katex.renderToString(value, { throwOnError: false, displayMode, output: 'html' });
    } catch {
      return; // 保留源码
    }
    htmlCache.set(key, html);
    // 异步回来时这个节点可能已经被重绘替换掉了
    if (dom.isConnected) dom.innerHTML = html;
  });
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
      /*
       * 段首是 `$$` 时让行内规则闭嘴，交给下面的块级规则。
       * 否则输 `$$x$$` 的过程中，敲到第三个 `$`（文字是 `$$x$`）就会先把
       * `$x$` 抢成行内公式，后面那个 `$` 落单 —— 块级公式永远输不完。
       */
      if (state.doc.resolve(start).parent.textContent.startsWith('$$')) return null;
      // 替换范围正好是 [开 $, 闭 $]，换成一个 1 宽的 atom 后光标自然落到它右边
      return state.tr.replaceWith(start, end, type.create({ value }));
    },
  );
});

/**
 * 输入 `$$…$$` 时转成块级公式。
 *
 * 要求**整段只有这一个公式**（前后允许空白）：块级公式是独立的块，
 * 和正文混在一行里就说不清该按行内还是按块渲染了。
 *
 * ⚠️ 转成 atom 之后没法再改内容（和行内公式同一个取舍）：要改就选中它删掉重打。
 * 想「边写边渲染」得像图表那样走装饰，那是另一个决定。
 */
export const mathBlockInputRule = $inputRule((ctx) => {
  const type = mathBlockSchema.type(ctx);
  return new InputRule(/\$\$([\s\S]+?)\$\$$/, (state, match, start, end) => {
    const value = (match[1] ?? '').trim();
    if (!value) return null;

    const $start = state.doc.resolve(start);
    const parent = $start.parent;
    if (parent.type.name !== 'paragraph') return null;
    /*
     * 公式必须从段首开始。
     *
     * ⚠️ 不能拿 `parent.textContent` 跟 match 比 —— 这条规则执行时**新输入的文字
     * 还没进文档**（state 是插入前的），那段 textContent 是空的；
     * 拿它去比会永远不相等，规则就静默失效（实测踩过）。
     * 段首判断才是不依赖新文本的正确写法。
     */
    if (start !== $start.start()) return null;

    const from = $start.start() - 1;
    const to = from + parent.nodeSize;
    if (end > to) return null;
    return state.tr.replaceWith(from, to, type.create({ value }));
  });
});

