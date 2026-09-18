/**
 * HTML → Markdown 转换（浏览器端）。
 *
 * 为什么自己写而不是引 turndown：导入功能只占一个模块的一小块，
 * 为它加一个运行时依赖（还会把 bundle 撑大）不划算；而转换本身
 * 只需要覆盖「网页/文档里真正会出现的标签」，约 100 行可控。
 * 用浏览器自带的 DOMParser，不额外拉解析器。
 *
 * 覆盖范围：标题、段落、列表（含嵌套）、引用、代码块、行内代码、
 * 粗斜体、删除线、链接、图片、分割线、GFM 表格。
 * 丢弃：脚本、样式、导航、页脚、表单控件、内联 SVG —— 这些
 * 进到笔记里只会变成噪声。
 */

/** 直接整棵丢掉的标签 */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'HEAD',
  'NAV',
  'FOOTER',
  'IFRAME',
  'SVG',
  'CANVAS',
  'FORM',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'VIDEO',
  'AUDIO',
]);

/** 顶层块级容器：继续往下递归，自身不产生标记 */
const CONTAINER_TAGS = new Set([
  'DIV',
  'SECTION',
  'ARTICLE',
  'MAIN',
  'HEADER',
  'ASIDE',
  'FIGURE',
  'FIGCAPTION',
  'BODY',
  'FONT',
  'SPAN',
]);

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ');
}

/**
 * 行首转义。
 *
 * 段落的文字里若以 `#`、`-`、`>` 开头，直接输出会被 Markdown
 * 当成标题/列表/引用解析，所以加反斜杠。
 */
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}\s|[-*+]\s|>\s|\d+\.\s)/, '$1\\$2');
}

/** 行内元素 → Markdown */
function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalize(node.textContent ?? '');
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return '';

  const inner = inlineChildren(el);
  const trimmed = inner.trim();

  switch (tag) {
    case 'BR':
      return '\n';
    case 'STRONG':
    case 'B':
      return trimmed ? `**${trimmed}**` : '';
    case 'EM':
    case 'I':
      return trimmed ? `*${trimmed}*` : '';
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return trimmed ? `~~${trimmed}~~` : '';
    case 'CODE':
      return inner ? `\`${inner.replace(/`/g, '\\`')}\`` : '';
    case 'A': {
      const href = el.getAttribute('href') ?? '';
      if (!trimmed) return '';
      // javascript: 之类的伪协议不保留，只留文字
      if (!href || /^\s*(javascript|data):/i.test(href)) return trimmed;
      return `[${trimmed}](${href})`;
    }
    case 'IMG': {
      const src = el.getAttribute('src') ?? '';
      if (!src) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/[\[\]]/g, '');
      return `![${alt}](${src})`;
    }
    default:
      return inner;
  }
}

function inlineChildren(el: Element): string {
  return Array.from(el.childNodes).map(inline).join('');
}

/** 取元素的行内文本（用于标题、表格单元格这类只应有一行的位置） */
function inlineText(el: Element): string {
  return inlineChildren(el).replace(/\s*\n\s*/g, ' ').trim();
}

/** 列表 → Markdown（支持嵌套，按层级缩进两格） */
function list(el: Element, depth: number): string {
  const ordered = el.tagName === 'OL';
  const start = Number(el.getAttribute('start') ?? '1') || 1;
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  let index = start;

  for (const child of Array.from(el.children)) {
    if (child.tagName !== 'LI') continue;

    // 收集该 LI 的直接内容（跳过嵌套列表，它们单独处理）
    const ownParts: string[] = [];
    const nested: Element[] = [];
    for (const node of Array.from(child.childNodes)) {
      if (
        node.nodeType === Node.ELEMENT_NODE &&
        ((node as Element).tagName === 'UL' || (node as Element).tagName === 'OL')
      ) {
        nested.push(node as Element);
      } else if (node.nodeType === Node.ELEMENT_NODE && (node as Element).tagName === 'P') {
        ownParts.push(inlineText(node as Element));
      } else {
        ownParts.push(inline(node));
      }
    }

    const text = ownParts.join('').replace(/\s*\n\s*/g, ' ').trim();
    const marker = ordered ? `${index}. ` : '- ';
    // 空项（只用来承载子列表）不输出标记行，避免出现孤立的 "-"
    if (text) {
      lines.push(`${indent}${marker}${escapeLineStart(text).replace(/^\\/, '')}`);
    }
    for (const n of nested) {
      lines.push(list(n, text ? depth + 1 : depth).replace(/\n+$/, ''));
    }
    index += 1;
  }

  return lines.filter(Boolean).join('\n') + '\n\n';
}

/** 表格 → GFM 表格 */
function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const grid = rows.map((tr) =>
    Array.from(tr.querySelectorAll('th,td')).map((cell) => inlineText(cell as Element)),
  );
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return '';

  const pad = (r: string[]) =>
    Array.from({ length: width }, (_, i) => (r[i] ?? '').replace(/\|/g, '\\|'));

  const header = pad(grid[0]);
  const body = grid.slice(1).map(pad);

  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ];
  return lines.join('\n') + '\n\n';
}

/** 代码块：尽量从 class 里认出语言 */
function pre(el: Element): string {
  const code = el.querySelector('code');
  const cls = code?.className ?? el.className ?? '';
  const lang = /(?:language|lang)-([\w+#-]+)/i.exec(cls)?.[1] ?? '';
  const text = (code?.textContent ?? el.textContent ?? '').replace(/\n+$/, '');
  // 内容里已有 ``` 时用更长的围栏，避免提前闭合
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${lang}\n${text}\n${fence}\n\n`;
}

function block(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalize(node.textContent ?? '').trim();
    return text ? `${escapeLineStart(text)}\n\n` : '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as Element;
  const tag = el.tagName;
  if (SKIP_TAGS.has(tag)) return '';

  // 标题 h1..h6
  const heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    const text = inlineText(el);
    return text ? `${'#'.repeat(Number(heading[1]))} ${text}\n\n` : '';
  }

  switch (tag) {
    case 'P': {
      const text = inlineChildren(el).trim();
      return text ? `${escapeLineStart(text.replace(/\s*\n\s*/g, ' '))}\n\n` : '';
    }
    case 'HR':
      return '---\n\n';
    case 'PRE':
      return pre(el);
    case 'BLOCKQUOTE': {
      const inner = blocksOf(el).trim();
      if (!inner) return '';
      return (
        inner
          .split('\n')
          .map((l) => (l ? `> ${l}` : '>'))
          .join('\n') + '\n\n'
      );
    }
    case 'UL':
    case 'OL':
      return list(el, 0);
    case 'TABLE':
      return table(el);
    case 'BR':
      return '\n';
    case 'IMG':
      return `${inline(el)}\n\n`;
    default:
      if (CONTAINER_TAGS.has(tag)) return blocksOf(el);
      // 未识别的标签：内容是块的按块处理，否则当行内段落
      return `${inlineChildren(el).trim()}\n\n`;
  }
}

function blocksOf(el: Element): string {
  return Array.from(el.childNodes).map(block).join('');
}

/** 收尾：合并多余空行、去掉行尾空格 */
function tidy(md: string): string {
  return md
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 把 HTML 文本转成 Markdown */
export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return tidy(blocksOf(doc.body));
  } catch {
    // 解析失败时退化成「去掉标签的纯文本」，总比什么都不导入好
    return tidy(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
}

/** 从 HTML 里取标题：<title> 优先，其次第一个 h1 */
export function extractHtmlTitle(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const title = doc.querySelector('title')?.textContent?.trim();
    if (title) return title;
    return doc.querySelector('h1')?.textContent?.trim() ?? '';
  } catch {
    return '';
  }
}
