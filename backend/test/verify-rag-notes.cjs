/**
 * 用数据库里的真实笔记验证 RAG 检索效果（向量放内存，不落库）
 *
 * 为什么不落库：本机 PostgreSQL 18 未安装 pgvector —— pg_available_extensions
 * 里只有 pg_trgm，没有 vector。所以这一轮只验证「检索质量」，验证存储方案留到后面。
 *
 * 用法：cd backend && node test/verify-rag-notes.cjs
 */

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const p = path.join(__dirname, '..', '.env');
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const API_KEY = env.EMBEDDING_API_KEY;
const BASE_URL = env.EMBEDDING_BASE_URL;
const MODEL = env.EMBEDDING_MODEL;
const DIMS = Number(env.EMBEDDING_DIMENSIONS || 1024);

let Client;
try {
  ({ Client } = require('pg'));
} catch {
  const base = path.join(__dirname, '..', 'node_modules', '.pnpm');
  const dir = fs.readdirSync(base).find((d) => /^pg@\d/.test(d));
  ({ Client } = require(path.join(base, dir, 'node_modules', 'pg')));
}

/** 手机号 / 邮箱打码 —— 笔记里混着个人简历 */
const mask = (s) =>
  s
    .replace(/1[3-9]\d{9}/g, '1**********')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '***@***');

const MAX_CHARS = 400;
const MIN_CHARS = 30;

function chunkNote(note) {
  const chunks = [];
  let title = note.title.slice(0, 40);
  let buf = [];

  const flush = () => {
    const body = buf.join('\n').trim();
    if (body.length >= MIN_CHARS) chunks.push({ ...note, section: title, text: body });
    buf = [];
  };

  for (const line of note.content.split(/\r?\n/)) {
    const m = /^(#{1,4})\s+(.*)$/.exec(line);
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

/** 标题里含这些词的笔记直接排除（用 EXCLUDE=揭泽磊 试「长文档污染」的影响） */
const EXCLUDE = (process.env.EXCLUDE || '').split(',').map((s) => s.trim()).filter(Boolean);

const QUERIES = [
  { q: '为什么改了一个地方，好几个组件都跟着更新', keyword: '响应式' },
  { q: '好几段逻辑混在一起时变量名容易撞车', keyword: '冲突' },
  { q: '怎么约束一个类必须提供某个方法', keyword: 'implements' },
  { q: '有没有关于导入优化的记录', keyword: '导入' },
];

(async () => {
  const c = new Client({ connectionString: env.DATABASE_URL });
  await c.connect();

  const rows = (
    await c.query(
      'select id, "userId", title, content from "Note" where "deletedAt" is null order by length(content) desc',
    )
  ).rows.filter((r) => !EXCLUDE.some((e) => r.title.includes(e)));
  await c.end();

  // 去重：同名同内容的笔记（父子页面各存一份）只保留一篇
  const seen = new Set();
  const deduped = rows.filter((r) => {
    const k = r.content.trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (deduped.length !== rows.length) {
    console.log(`去重：${rows.length} → ${deduped.length} 篇（有 ${rows.length - deduped.length} 篇内容完全重复）\n`);
  }

  const corpus = deduped.flatMap((n) => chunkNote(n));
  console.log(`真实笔记 ${deduped.length} 篇 → 切出 ${corpus.length} 个块`);
  console.log(`（其中正文 ${deduped.reduce((s, r) => s + r.content.length, 0)} 字）\n`);

  const dropped = deduped.filter((r) => r.content.trim().length < MIN_CHARS);
  if (dropped.length) {
    console.log(`⚠️ 因过短被丢弃的笔记：${dropped.map((r) => `「${r.title}」${r.content.length}字`).join('、')}\n`);
  }

  const vectors = await embed(corpus.map((x) => `${x.section}\n${x.text}`));
  const qVecs = await embed(QUERIES.map((x) => x.q));

  for (let i = 0; i < QUERIES.length; i++) {
    const { q, keyword } = QUERIES[i];
    console.log('─'.repeat(78));
    console.log(`问：${q}`);

    const literal = corpus.filter((x) => x.text.includes(keyword));
    console.log(`\n  【现状·字面匹配】关键词「${keyword}」→ 命中 ${literal.length} 块`);

    const top = corpus
      .map((x, idx) => ({ x, s: cosine(qVecs[i], vectors[idx]) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 3);

    console.log('\n  【语义检索】top-3：');
    for (const { x, s } of top) {
      console.log(`    ${s.toFixed(3)}  「${x.title}」${x.section !== x.title ? ' › ' + x.section : ''}`);
      console.log(`           ${mask(x.text.replace(/\s+/g, ' ')).slice(0, 70)}...`);
    }
    console.log();
  }
})();
