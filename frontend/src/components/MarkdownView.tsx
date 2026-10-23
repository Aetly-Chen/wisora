import React, { useEffect, useMemo, useRef } from 'react';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import DOMPurify from 'dompurify';
import { highlightToHtml } from '@/lib/code-highlight';

/**
 * Markdown 渲染。
 *
 * 安全说明：marked 只负责把 Markdown 转成 HTML 字符串，
 * 不做转义。笔记内容由用户自己输入，但渲染时仍走 DOMPurify 清洗 ——
 * 一旦将来支持导入他人分享的 .md 文件，这里就是唯一的 XSS 防线，
 * 现在就装好，比事后补要可靠。
 *
 * ⚠️ `marked.use()` 是**累积**的：同一个扩展注册两次会让代码块被高亮两遍
 * （第二遍的 HTML 被当成源码再转义一次，屏幕上直接出现 `<span>` 字样）。
 * HMR 下模块会重复执行，所以用一个模块级标记兜住。
 */
marked.setOptions({
  gfm: true, // 表格、删除线、任务列表
  breaks: true, // 单个换行也渲染成 <br>，更符合笔记书写直觉
});

const MARKED_HIGHLIGHT_FLAG = '__wisoraHighlightReady';

if (!(marked as unknown as Record<string, unknown>)[MARKED_HIGHLIGHT_FLAG]) {
  marked.use(
    markedHighlight({
      langPrefix: 'language-',
      highlight(code, lang) {
        return highlightToHtml(code, lang);
      },
    }),
  );
  (marked as unknown as Record<string, unknown>)[MARKED_HIGHLIGHT_FLAG] = true;
}

interface MarkdownViewProps {
  content: string;
  className?: string;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content, className }) => {
  const html = useMemo(() => {
    if (!content.trim()) return '';
    const raw = marked.parse(content, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [content]);

  const rootRef = useRef<HTMLDivElement>(null);

  /*
   * 复制按钮走 DOM 注入而不是 marked renderer 扩展：
   *
   * renderer 只能产出字符串，按钮的点击回调还是得靠事件委托找回来；
   * 而每次 html 变化 React 都会重建这段 DOM，所以按钮也必须在同一轮
   * effect 里重新挂 —— 用 `[html]` 做依赖天然对齐。
   *
   * 读文本时取 `code` 而不是 `pre.textContent`：按钮自己的「复制」
   * 两个字也是 pre 的子节点，直接读 pre 会把它一起复制进去。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const cleanups: (() => void)[] = [];

    root.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector(':scope > .code-copy')) return;

      /*
       * 语言标签。编辑区是 NodeView 从 node.attrs.language 拿的，
       * 这里只能从 `<code class="language-xxx">` 反解 —— 两边的类名和位置
       * 必须一致，否则「所见」和「所得」又是两个样子。
       */
      const lang = /language-([^\s]+)/.exec(
        pre.querySelector('code')?.className ?? '',
      )?.[1];
      if (lang) {
        const tag = document.createElement('span');
        tag.className = 'code-lang';
        tag.textContent = lang;
        pre.appendChild(tag);
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.textContent = '复制';
      btn.setAttribute('aria-label', '复制代码');

      const onClick = () => {
        const code = pre.querySelector('code')?.textContent ?? '';
        if (!code) return;
        void navigator.clipboard.writeText(code).then(() => {
          btn.textContent = '已复制';
          btn.dataset.state = 'done';
          window.setTimeout(() => {
            btn.textContent = '复制';
            delete btn.dataset.state;
          }, 1400);
        });
      };

      btn.addEventListener('click', onClick);
      pre.appendChild(btn);
      cleanups.push(() => btn.removeEventListener('click', onClick));
    });

    return () => cleanups.forEach((fn) => fn());
  }, [html]);

  if (!html) return null;

  return (
    <div
      ref={rootRef}
      className={`md-body ${className ?? ''}`}
      // 内容已过 DOMPurify 清洗
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
