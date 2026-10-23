/**
 * 把一篇笔记导出成可独立使用的 .md 文件。
 *
 * ## 为什么要把图片内联成 base64
 *
 * 正文里的图片是 `attachment:<id>` —— 这是**应用内的引用**，离开后端
 * 就是一段无意义的字符串。直接导出的话，用户拿到的 .md 里所有图都是坏的。
 *
 * 换成签名直链也不行：那是 1 小时就过期的临时凭证。
 *
 * 所以导出时把每张图取回来、转成 `data:image/...;base64,...` 内嵌进去。
 * 代价是体积膨胀约 33%，换来的是「这个文件在 Typora / GitHub / 任何编辑器里
 * 都能直接看」—— 导出本来就该是这个意思。
 *
 * 取图失败（附件被删、链接拿不到）时保留原始 `attachment:<id>`，
 * 而不是静默丢掉 —— 用户至少能看到「这里原本有张图」。
 */
import { collectAttachmentIds, ensureSigned, getAttachmentUrl } from './attachment-url';

export interface ExportResult {
  filename: string;
  /** 成功内联的图片数 */
  inlined: number;
  /** 取不回来、保留了原引用的图片数 */
  failed: number;
}

/** 文件名里不能出现的字符（Windows 限制最严，按它来） */
const INVALID_FILENAME = /[\\/:*?"<>|\u0000-\u001f]/g;

function sanitizeFilename(title: string): string {
  const cleaned = title.replace(INVALID_FILENAME, ' ').replace(/\s+/g, ' ').trim();
  // 留余量：Windows 路径总长有限制，标题过长时截断
  const clipped = cleaned.slice(0, 80).trim();
  return clipped.length > 0 ? clipped : '未命名';
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export async function exportNoteAsMarkdown(
  title: string,
  content: string,
): Promise<ExportResult> {
  const ids = collectAttachmentIds(content);
  let markdown = content;
  let inlined = 0;
  let failed = 0;

  if (ids.length > 0) {
    await ensureSigned(ids);

    for (const id of ids) {
      const url = getAttachmentUrl(id);
      if (!url) {
        failed += 1;
        continue;
      }

      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const dataUrl = await blobToDataUrl(await res.blob());

        // 用 split/join 而不是 replace：同一个附件可能在正文里出现多次
        markdown = markdown.split(`attachment:${id}`).join(dataUrl);
        inlined += 1;
      } catch {
        failed += 1;
      }
    }
  }

  const filename = `${sanitizeFilename(title)}.md`;
  triggerDownload(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), filename);

  return { filename, inlined, failed };
}
