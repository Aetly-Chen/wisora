/**
 * 把笔记正文切成检索用的块。
 *
 * 策略：先按 Markdown 标题（`#` ~ `####`）切，超长的再按字数硬切。
 * 不按字数一刀切，是因为标题边界天然就是语义边界 —— 硬切出来的块
 * 常常从句子中间开始，检索质量明显更差。
 */

/**
 * 单块字数上限。取值是权衡的结果：
 * 切得太小会把一句完整的意思劈成两半；切得太大则一块里混着好几个主题，
 * 向量被平均掉，反而搜不准。
 */
const MAX_CHARS = 400;

/** 低于这个字数的块直接丢弃：多半是「# 标题」这种空壳，留着只稀释结果 */
const MIN_CHARS = 30;

/** 小节标题拼进待编码文本时的截断长度，避免超长标题挤掉正文的比重 */
const TITLE_LIMIT = 60;

export interface Chunk {
  /** 块在笔记内的序号 */
  seq: number;
  /** 所属小节标题（取自 Markdown 标题，没有则用笔记标题） */
  title: string;
  /** 块正文 */
  content: string;
}

/** 切块。正文过短时返回空数组 —— 调用方据此跳过这篇笔记 */
export function chunkNote(noteTitle: string, content: string): Chunk[] {
  const sections: { title: string; text: string }[] = [];
  let section = noteTitle.trim().slice(0, TITLE_LIMIT);
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length >= MIN_CHARS) sections.push({ title: section, text: body });
    buf = [];
  };

  for (const line of content.split(/\r?\n/)) {
    const heading = /^#{1,4}\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      section = heading[1].trim().slice(0, TITLE_LIMIT);
      continue;
    }
    buf.push(line);
  }
  flush();

  const out: Chunk[] = [];
  for (const s of sections) {
    if (s.text.length <= MAX_CHARS) {
      out.push({ seq: out.length, title: s.title, content: s.text });
      continue;
    }
    for (let i = 0; i < s.text.length; i += MAX_CHARS) {
      out.push({ seq: out.length, title: s.title, content: s.text.slice(i, i + MAX_CHARS) });
    }
  }
  return out;
}

/**
 * 送去编码的文本：正文前面带上小节标题。
 *
 * 一个 400 字的块脱离全文后，往往看不出在讲什么；标题是唯一能提供
 * 上下文的线索，一起编码能让它在向量空间里落到正确的位置。
 */
export function toEmbeddingText(chunk: Chunk): string {
  return chunk.title ? `${chunk.title}\n${chunk.content}` : chunk.content;
}
