import React, { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * Markdown 渲染。
 *
 * 安全说明：marked 只负责把 Markdown 转成 HTML 字符串，
 * 不做转义。笔记内容由用户自己输入，但渲染时仍走 DOMPurify 清洗 ——
 * 一旦将来支持导入他人分享的 .md 文件，这里就是唯一的 XSS 防线，
 * 现在就装好，比事后补要可靠。
 */
marked.setOptions({
  gfm: true, // 表格、删除线、任务列表
  breaks: true, // 单个换行也渲染成 <br>，更符合笔记书写直觉
});

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

  if (!html) return null;

  return (
    <div
      className={`md-body ${className ?? ''}`}
      // 内容已过 DOMPurify 清洗
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};
