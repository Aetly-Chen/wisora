/**
 * 代码高亮：编辑区与预览区共用同一套语言注册和配色。
 *
 * ## 为什么是 refractor，不是 prismjs
 *
 * prismjs 的语言包是 `(function (Prism) {...}(Prism))` 形式的 IIFE，
 * 直接读全局 `Prism` 变量；而 prismjs 核心在 ESM 下**不会**把它挂到 window 上
 * （实测 `tail -c 400 prism.js`：整个文件就是一个 IIFE，没有 `global.Prism =`）。
 * 所以在 Vite 里 `import 'prismjs/components/prism-typescript'` 会抛
 * `Prism is not defined`。要修就得靠 `window.Prism = Prism` + 动态 import
 * 控制执行顺序，既脏又不可靠。
 *
 * refractor 是同一套算法的 ESM 封装，`@milkdown/plugin-prism` 内部用的就是它，
 * 模块化、无全局状态。两侧共用同一个实例，语言只注册一次。
 *
 * ## 为什么自己写 hast → HTML
 *
 * refractor 的 `highlight()` 返回 hast 树。标准转换工具是 `hast-util-to-html`，
 * 但它会带进来 10 个依赖，而 hast 在本场景里只可能产生 `span` 和 `text`
 * 两种节点 —— 一个 20 行的序列化器足够。输出还会经过 DOMPurify 清洗，
 * 多一道兜底。
 */
import { refractor } from 'refractor';
import jsx from 'refractor/jsx';
import tsx from 'refractor/tsx';

/*
 * commonmark 预设只注册了 30 种常用语言，不含 jsx/tsx ——
 * 而这两个恰好是前端笔记里出现频率最高的。
 * `register` 内部按 displayName 去重，重复调用安全。
 */
refractor.register(jsx);
refractor.register(tsx);

/**
 * 补充别名。
 *
 * refractor 自带一部分（`js`→javascript、`ts`→typescript、`sh`→bash 实测可查），
 * 但 `vue` / `node` / `mjs` / `console` 这些**没有**。缺了会怎样：
 * `@milkdown/plugin-prism` 用 `listLanguages().includes(language)` 判断，
 * 命中不了就 `console.warn` —— 一篇笔记里十几个 `````vue````` 就是十几条警告。
 */
function safeAlias(from: string, aliases: string[]) {
  // 源语言没注册时不能建别名，否则会在 languages 里塞一个 undefined，
  // 后续 highlight 直接崩在 undefined 上
  if (!refractor.registered(from)) return;
  refractor.alias(from, aliases);
}

safeAlias('markup', ['html', 'xml', 'svg', 'vue', 'htm']);
safeAlias('javascript', ['node', 'mjs', 'cjs']);
safeAlias('bash', ['shell', 'zsh', 'console', 'dotenv']);
safeAlias('yaml', ['yml']);
safeAlias('markdown', ['md']);
safeAlias('python', ['py']);

/**
 * 交给 `@milkdown/plugin-prism` 的实例。
 *
 * 它和本模块的 `highlightToHtml` 必须是**同一个对象** —— 否则会出现
 * 「预览区高亮正常、编辑区全是白板，控制台还刷 Unsupported language」。
 */
export const sharedRefractor = refractor;

/** 明确「不要高亮」的语言标记 —— 显示为纯文本，不报错 */
const PLAIN = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'none']);

export function normalizeLang(lang: string | null | undefined): string {
  if (!lang) return '';
  const key = lang.trim().toLowerCase();
  return PLAIN.has(key) ? '' : key;
}

/** 语言是否真的支持（用于决定要不要显示语言标签） */
export function isLangSupported(lang: string): boolean {
  const key = normalizeLang(lang);
  return key !== '' && refractor.registered(key);
}

type HastNode =
  | { type: 'text'; value: string }
  | {
      type: 'element';
      tagName: string;
      properties?: Record<string, unknown>;
      children: HastNode[];
    };

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPE_MAP[c]);

function serialize(node: HastNode): string {
  if (node.type === 'text') return escapeHtml(node.value);

  const cls = node.properties?.className;
  const attr =
    Array.isArray(cls) && cls.length > 0
      ? ` class="${escapeHtml(cls.join(' '))}"`
      : '';

  return `<${node.tagName}${attr}>${node.children.map(serialize).join('')}</${node.tagName}>`;
}

/**
 * 把一段代码渲染成带 `<span class="token xxx">` 的 HTML。
 * 不支持的语言返回转义后的纯文本（而不是抛错）。
 */
export function highlightToHtml(code: string, lang: string): string {
  const key = normalizeLang(lang);
  if (!key || !refractor.registered(key)) return escapeHtml(code);

  try {
    return refractor.highlight(code, key).children.map(serialize).join('');
  } catch {
    // 语法包本身抛错不该让整篇笔记渲染失败
    return escapeHtml(code);
  }
}
