/**
 * 从 Markdown 里提取标题，供大纲栏使用。
 *
 * 两个必须处理的细节：
 * 1. **代码围栏里的 `#` 不是标题** —— 笔记里大量出现 shell 注释、Python 注释，
 *    不跳过围栏会让大纲里冒出 `# 安装依赖` 这种假条目。
 * 2. **记录行号与字符偏移** —— 源码模式下点击大纲要能定位到那一行，
 *    只给个序号没法定位。
 */

export interface Heading {
  /** 1~6 */
  level: number;
  text: string; // 标题文字（已去掉 # 号与尾部 #，用于大纲显示）
  /** 行号（从 0 开始） */
  line: number;
  /** 该行首字符在原文里的偏移 */
  offset: number;
}

const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;

export function extractHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  const lines = markdown.split(/\r?\n/);

  let inFence = false;
  let fenceMarker = '';
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = '';
      }
      offset += line.length + 1;
      continue;
    }

    if (!inFence) {
      const m = ATX.exec(line);
      if (m) {
        out.push({
          level: m[1].length,
          // 标题里的行内标记（**加粗**、`代码`）在大纲里只显示文字
          text: m[2].replace(/[*_`~]/g, '').trim(),
          line: i,
          offset,
        });
      }
    }

    offset += line.length + 1;
  }

  return out;
}

/** 大纲缩进：按层级递减，最多 3 档（再深就贴到右边了） */
export function headingIndent(level: number, baseLevel: number): number {
  return Math.min(Math.max(level - baseLevel, 0), 2) * 10;
}
