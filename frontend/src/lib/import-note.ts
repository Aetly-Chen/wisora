import { extractHtmlTitle, htmlToMarkdown } from './html-to-markdown';

/** 单次导入的文件体积上限：再大编辑器会卡，也没必要 */
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** 标题最多取这么多个字符，避免把一整段正文塞进标题 */
const MAX_TITLE_LENGTH = 80;

export type ImportableKind = 'markdown' | 'html' | 'text';

/**
 * 判断一个文件是否属于「可导入为笔记」的类型。
 *
 * 拖拽上传时要靠这个把文件和附件区分开：md/html/txt 变成笔记，
 * 其余（PDF、图片等）仍然走附件流程。
 * 优先看扩展名 —— 浏览器给出的 MIME 对 .md 往往是空串或
 * application/octet-stream，不可靠。
 */
export function detectImportKind(file: File): ImportableKind | null {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'txt' || ext === 'text') return 'text';

  // 扩展名认不出时退回 MIME
  if (file.type === 'text/markdown') return 'markdown';
  if (file.type === 'text/html') return 'html';
  if (file.type === 'text/plain') return 'text';
  return null;
}

export interface ImportedNote {
  title: string;
  content: string;
}

function fallbackTitle(filename: string): string {
  return filename.replace(/\.[^.]+$/, '').trim() || '导入的笔记';
}

/**
 * 从 Markdown 文本里推断标题。
 *
 * 若用的是开头的 `# 标题`，一并把这一行从正文里去掉 ——
 * 笔记标题已经显示在编辑器上方了，正文里再来一个一模一样的 H1
 * 就是重复。
 */
function titleFromMarkdown(text: string): { title: string; content: string } {
  const lines = text.split('\n');
  let firstContentIndex = 0;

  while (firstContentIndex < lines.length && !lines[firstContentIndex].trim()) {
    firstContentIndex += 1;
  }

  const first = lines[firstContentIndex] ?? '';
  const h1 = /^#\s+(.+)$/.exec(first.trim());
  if (h1) {
    return {
      title: h1[1].trim().slice(0, MAX_TITLE_LENGTH),
      content: lines.slice(firstContentIndex + 1).join('\n').trim(),
    };
  }

  if (first.trim()) {
    return {
      title: first.trim().slice(0, MAX_TITLE_LENGTH),
      content: text.trim(),
    };
  }

  return { title: '', content: text.trim() };
}

/**
 * 读取一个文件并转成「标题 + Markdown 正文」。
 *
 * 全部在浏览器里完成，不经过后端 —— 导入是纯文本处理，
 * 传一遍服务器既慢又占带宽，还会让后端多一个上传解析的入口。
 */
export async function readNoteFile(file: File): Promise<ImportedNote> {
  if (file.size > MAX_IMPORT_BYTES) {
    throw new Error(
      `「${file.name}」超过 ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)}MB，暂不支持导入`,
    );
  }

  const kind = detectImportKind(file);
  const raw = await file.text();

  if (kind === 'html') {
    const parsed = titleFromMarkdown(htmlToMarkdown(raw));
    const htmlTitle = extractHtmlTitle(raw).slice(0, MAX_TITLE_LENGTH);
    return {
      // <title> 通常比正文首个标题更贴近文档名
      title: htmlTitle || parsed.title || fallbackTitle(file.name),
      content: parsed.content,
    };
  }

  const parsed = titleFromMarkdown(raw);
  return {
    title: parsed.title || fallbackTitle(file.name),
    content: parsed.content,
  };
}
