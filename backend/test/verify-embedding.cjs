/**
 * RAG 检索效果验证（离线，不依赖 Postgres / Redis）
 *
 * 目的：量化「语义检索」相对 notes.list() 里 `contains` 字面匹配的实际增益。
 * 语料用仓库 docs/ 下的中文技术文档（真实文本，非构造数据），
 * 切块 → 向量化 → 用「字面不匹配、语义相关」的问题检索，两种方式对比。
 *
 * 用法：cd backend && node test/verify-embedding.cjs
 */

const fs = require('fs');
const path = require('path');

/** 自己解析 .env —— 不用 node --env-file，因为项目 .env 里有几行 `\#` 开头的脏数据会解析失败 */
function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const API_KEY = process.env.EMBEDDING_API_KEY || env.EMBEDDING_API_KEY;
const BASE_URL = process.env.EMBEDDING_BASE_URL || env.EMBEDDING_BASE_URL;
const MODEL = process.env.EMBEDDING_MODEL || env.EMBEDDING_MODEL;
const DIMS = Number(process.env.EMBEDDING_DIMENSIONS || env.EMBEDDING_DIMENSIONS || 1024);

if (!API_KEY) {
  console.error('缺少 EMBEDDING_API_KEY');
  process.exit(1);
}

// ---------- 1. 读语料 ----------
const docsDir = path.join(__dirname, '..', '..', 'docs');
const files = fs.readdirSync(docsDir).filter((f) => f.endsWith('.md'));

// ---------- 2. 切块：先按 Markdown 二/三级标题，超长的再按字数切 ----------
const MAX_CHARS = 500;
const MIN_CHARS = 60;

function chunkMarkdown(text, file) {
  const chunks = [];
  let title = '(前言)';
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length >= MIN_CHARS) chunks.push({ file, title, text: body });
    buf = [];
  };

  for (const line of text.split(/\r?\n/)) {
    const m = /^(#{2,3})\s+(.*)$/.exec(line);
    if (m) {
      flush();
      title = m[2].trim();
      continue;
    }
    buf.push(line);
  }
  flush();

  const out = [];
  for (const c of chunks) {
    if (c.text.length <= MAX_CHARS) {
      out.push(c);
      continue;
    }
    for (let i = 0; i < c.text.length; i += MAX_CHARS) {
      out.push({ ...c, text: c.text.slice(i, i + MAX_CHARS) });
    }
  }
  return out;
}

const corpus = [];
for (const f of files) {
  corpus.push(...chunkMarkdown(fs.readFileSync(path.join(docsDir, f), 'utf8'), f));
}
console.log(`语料：${files.length} 个文档 → ${corpus.length} 个块\n`);

// ---------- 3. 向量化 ----------
const BATCH = 16;

async function embed(texts) {
  const r = await fetch(`${BASE_URL}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: texts, dimensions: DIMS }),
  });
  const d = await r.json();
  if (d.code) throw new Error(`HTTP ${r.status} ${JSON.stringify(d)}`);
  return d.data.map((x) => x.embedding);
}

async function embedAll(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    out.push(...(await embed(texts.slice(i, i + BATCH))));
    process.stdout.write(`\r向量化 ${Math.min(i + BATCH, texts.length)}/${texts.length}`);
  }
  process.stdout.write('\n');
  return out;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------- 4. 查询集：措辞刻意与文档用词不同 ----------
// expectTitle：该查询「正确答案」所在的小节号，用于诊断目标块的排名
const QUERIES = [
  {
    q: '聊天页面上面的消息区域和下面的输入框没有对齐，是哪里出的问题',
    keyword: '对齐',
    expectTitle: '8.8',
  },
  {
    q: '助手做多步骤任务时会不会中途断掉',
    keyword: '中断',
    expectTitle: '7.1 `MAX_ITERATIONS',
  },
  {
    q: '网络慢的时候 AI 会不会把同一篇笔记保存成两遍',
    keyword: '重复',
    expectTitle: '7.2 写工具的',
  },
  {
    q: 'AI 改笔记为什么不能绕开业务逻辑直接操作数据库',
    keyword: '数据库',
    expectTitle: '2.2 为什么工具内部走',
  },
];

(async () => {
  const t0 = Date.now();
  const vectors = await embedAll(corpus.map((c) => `${c.title}\n${c.text}`));
  console.log(`向量化完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，维度 ${vectors[0].length}\n`);

  const qVecs = await embed(QUERIES.map((x) => x.q));

  const scored = QUERIES.map((_, i) =>
    corpus
      .map((c, idx) => ({ c, s: cosine(qVecs[i], vectors[idx]) }))
      .sort((a, b) => b.s - a.s),
  );

  // ---------- 5. 混合检索：向量分 + 字符 bigram 关键词分 ----------
  // 中文没分词器，用 bigram 近似；权重是未调参的常见起点
  function bigrams(s) {
    const clean = s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
    const out = new Set();
    for (let i = 0; i < clean.length - 1; i++) out.add(clean.slice(i, i + 2));
    return out;
  }
  const corpusGrams = corpus.map((c) => bigrams(c.title + c.text));

  const VEC_W = 0.6;
  const KW_W = 0.4;

  const hybridScored = QUERIES.map((query, i) => {
    const qg = bigrams(query.q);
    return corpus
      .map((c, idx) => {
        let hit = 0;
        for (const g of qg) if (corpusGrams[idx].has(g)) hit++;
        const kw = qg.size ? hit / qg.size : 0;
        return { c, s: VEC_W * cosine(qVecs[i], vectors[idx]) + KW_W * kw };
      })
      .sort((a, b) => b.s - a.s);
  });

  for (let i = 0; i < QUERIES.length; i++) {
    const { q, keyword, expectTitle } = QUERIES[i];
    console.log('─'.repeat(78));
    console.log(`问：${q}`);

    const literal = corpus.filter((c) => c.text.includes(keyword));
    console.log(
      `\n  【现状·字面匹配】关键词「${keyword}」→ 命中 ${literal.length} 块` +
        (literal.length ? `（${literal.map((c) => c.title).slice(0, 2).join(' / ')}…）` : ' —— 一条都没搜到'),
    );

    console.log('\n  【纯向量】top-3：');
    for (const { c, s } of scored[i].slice(0, 3)) {
      console.log(`    ${s.toFixed(3)}  ${c.file} › ${c.title}`);
      console.log(`           ${c.text.replace(/\s+/g, ' ').slice(0, 74)}...`);
    }
    if (expectTitle) {
      const rank = scored[i].findIndex((x) => x.c.title.includes(expectTitle));
      console.log(
        rank === 0
          ? `\n  【诊断】目标块「${expectTitle}」→ 第 1 名 ✅`
          : rank < 0
            ? `\n  【诊断】目标块「${expectTitle}」未在语料中找到`
            : `\n  【诊断】目标块「${expectTitle}」→ 第 ${rank + 1} / ${corpus.length} 名（${scored[i][rank].s.toFixed(3)}）`,
      );
    }

    console.log('\n  【混合检索】top-3（向量 0.6 + bigram 0.4，未调参）：');
    for (const { c, s } of hybridScored[i].slice(0, 3)) {
      console.log(`    ${s.toFixed(3)}  ${c.file} › ${c.title}`);
      console.log(`           ${c.text.replace(/\s+/g, ' ').slice(0, 74)}...`);
    }
    if (expectTitle) {
      const rank = hybridScored[i].findIndex((x) => x.c.title.includes(expectTitle));
      console.log(
        rank === 0
          ? `\n  【诊断】目标块「${expectTitle}」→ 第 1 名 ✅（混合检索救回来了）`
          : rank < 0
            ? `\n  【诊断】目标块「${expectTitle}」未找到`
            : `\n  【诊断】目标块「${expectTitle}」→ 第 ${rank + 1} / ${corpus.length} 名（${hybridScored[i][rank].s.toFixed(3)}）`,
      );
    }
    console.log();
  }
})();
