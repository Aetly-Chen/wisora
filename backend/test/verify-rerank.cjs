/**
 * 验证 rerank 能不能救回「纯向量失手」的查询。
 *
 * 背景：docs/ 语料上有个失败案例 —— 问「保存成两遍」，正确答案讲的是
 * 「超时但已写入」，两者一个词都不重合，纯向量把它排到第 22 名。
 * 这里测：先粗召回 50 条，再用 Qwen3-Reranker 精排，看目标块能不能进前 5。
 *
 * 用法：cd backend && node test/verify-rerank.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, '..', 'docs');
const RECALL = 50;
const TOP_N = 5;

const envFile = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (m) envFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
for (const [k, v] of Object.entries(envFile)) if (!process.env[k]) process.env[k] = v;

const ts = require(path.join(ROOT, 'node_modules', 'typescript'));
function loadTs(rel) {
  const js = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      experimentalDecorators: true,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, require);
  return mod.exports;
}

const { chunkNote, toEmbeddingText } = loadTs('src/rag/chunk.ts');
const { cosine } = loadTs('src/rag/vector.ts');
const { EmbeddingService } = loadTs('src/rag/embedding.service.ts');

const KEY = process.env.EMBEDDING_API_KEY;
const BASE = process.env.EMBEDDING_BASE_URL.replace(/\/+$/, '');
const RERANK_MODEL = 'Qwen/Qwen3-Reranker-0.6B';

const QUERIES = [
  { q: '网络慢的时候 AI 会不会把同一篇笔记保存成两遍', expect: '7.2 写工具的' },
  { q: 'AI 改笔记为什么不能绕开业务逻辑直接操作数据库', expect: '2.2 为什么工具内部走' },
  { q: '聊天页面上面的消息区域和下面的输入框没有对齐', expect: '8.8' },
  { q: '助手做多步骤任务时会不会中途断掉', expect: '7.1 `MAX_ITERATIONS' },
];

async function rerank(query, documents) {
  const r = await fetch(`${BASE}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_n: documents.length }),
  });
  const d = await r.json();
  if (d.code) throw new Error(`rerank 失败: ${JSON.stringify(d)}`);
  return d.results; // [{ index, relevance_score }]
}

(async () => {
  // 语料：docs/ 全部 md
  const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.md'));
  const corpus = [];
  for (const f of files) {
    for (const c of chunkNote(f.replace(/\.md$/, ''), fs.readFileSync(path.join(DOCS, f), 'utf8').slice(0, 200000))) {
      corpus.push({ ...c, file: f });
    }
  }
  console.log(`语料 ${files.length} 个文档 → ${corpus.length} 块\n`);

  const embedding = new EmbeddingService();
  const vectors = await embedding.embed(corpus.map(toEmbeddingText));
  const qVecs = await embedding.embed(QUERIES.map((x) => x.q));

  console.log(`粗召回 ${RECALL} 条 → rerank → 保留 ${TOP_N}\n`);
  console.log('查询'.padEnd(30), '目标块排名：纯向量 → rerank');
  console.log('─'.repeat(72));

  let fixed = 0;
  for (let i = 0; i < QUERIES.length; i++) {
    const { q, expect } = QUERIES[i];

    const scored = corpus
      .map((c, idx) => ({ c, idx, s: cosine(qVecs[i], vectors[idx]) }))
      .sort((a, b) => b.s - a.s);

    const beforeRank = scored.findIndex((x) => x.c.title.includes(expect)) + 1;

    // 粗召回
    const recalled = scored.slice(0, RECALL);
    const ranked = await rerank(q, recalled.map((x) => toEmbeddingText(x.c)));

    // rerank 结果按 relevance_score 降序，映射回原块
    const afterOrder = ranked
      .slice()
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .map((r) => recalled[r.index]);
    const afterRank = afterOrder.findIndex((x) => x.c.title.includes(expect)) + 1;

    const tag = afterRank > 0 && afterRank <= TOP_N ? '✅ 进前 5' : afterRank > 0 ? `⚠️ 第 ${afterRank}` : '❌ 仍在前 50 外';
    if (afterRank > 0 && afterRank <= TOP_N) fixed += 1;

    console.log(
      `${q.slice(0, 28).padEnd(30)} 第 ${String(beforeRank).padStart(3)} → ${String(afterRank).padStart(3)}  ${tag}`,
    );
    if (afterRank > 0 && afterRank <= TOP_N && beforeRank > TOP_N) {
      console.log(`   ↑ 救回来了：「${afterOrder[afterRank - 1].c.title.slice(0, 40)}」`);
    }
  }

  console.log(`\n合计：${fixed} / ${QUERIES.length} 个目标块进入前 ${TOP_N}`);
})();
