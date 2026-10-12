/**
 * 全量重建笔记索引（一次性运维脚本）。
 *
 * 为什么要单独跑：NotesService 的钩子只在**保存笔记**时触发，覆盖不到存量数据。
 * 第一次上线、以及换 embedding 模型（维度变了）之后都要跑一次。
 *
 * 复用 src/rag 下真实的 chunk / vector / EmbeddingService（用项目自己的 typescript
 * 转译后加载，不是重写副本）。只有「读笔记 → 写块」这段编排是本脚本自己写的，
 * 因为 NoteIndexService 依赖 Nest 容器；这段属于数据搬运，不含业务规则。
 *
 * 用法：cd backend && node test/index-notes.cjs
 *      加 --user=<id> 只重建某个用户
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ONLY_USER = (process.argv.find((a) => a.startsWith('--user=')) ?? '').slice(7) || null;
const INSERT_BATCH = 200;

for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}

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
const { encodeVector } = loadTs('src/rag/vector.ts');
const { EmbeddingService } = loadTs('src/rag/embedding.service.ts');

const pnpm = path.join(ROOT, 'node_modules', '.pnpm');
const pgDir = fs.readdirSync(pnpm).find((d) => /^pg@\d/.test(d));
const { Client } = require(path.join(pnpm, pgDir, 'node_modules', 'pg'));

(async () => {
  const embedding = new EmbeddingService();
  if (!embedding.enabled) {
    console.error('❌ 未配置 EMBEDDING_API_KEY');
    process.exit(1);
  }

  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const notes = (
    await c.query(
      `select id, "userId", title, content from "Note"
        where "deletedAt" is null ${ONLY_USER ? 'and "userId" = $1' : ''}
        order by "createdAt" asc`,
      ONLY_USER ? [ONLY_USER] : [],
    )
  ).rows;

  // 1) 全部切块
  const pending = [];
  for (const n of notes) {
    for (const chunk of chunkNote(n.title, n.content)) {
      pending.push({ noteId: n.id, userId: n.userId, chunk });
    }
  }
  console.log(`笔记 ${notes.length} 篇 → 切出 ${pending.length} 块`);
  if (pending.length === 0) {
    console.log('没有可索引的内容');
    await c.end();
    return;
  }

  // 2) 先全部编码完再写库 —— 中途失败不至于把索引清成一半
  const t0 = Date.now();
  const vectors = await embedding.embed(pending.map((p) => toEmbeddingText(p.chunk)));
  console.log(`向量化完成：${((Date.now() - t0) / 1000).toFixed(1)}s，维度 ${vectors[0].length}`);

  // 3) 一个事务里替换：删旧 + 写新
  await c.query('begin');
  try {
    await c.query(
      ONLY_USER ? 'delete from "NoteChunk" where "userId" = $1' : 'delete from "NoteChunk"',
      ONLY_USER ? [ONLY_USER] : [],
    );

    for (let i = 0; i < pending.length; i += INSERT_BATCH) {
      const slice = pending.slice(i, i + INSERT_BATCH);
      const placeholders = slice
        .map((_, j) => {
          const k = j * 7;
          return `($${k + 1},$${k + 2},$${k + 3},$${k + 4},$${k + 5},$${k + 6},$${k + 7})`;
        })
        .join(',');
      // id 由图外的 randomUUID 提供：Prisma 的 @default(cuid()) 是客户端行为，
      // 直接走 SQL 就得自己生成
      const params = slice.flatMap((p, j) => [
        crypto.randomUUID(),
        p.noteId,
        p.userId,
        p.chunk.seq,
        p.chunk.title,
        p.chunk.content,
        Buffer.from(encodeVector(vectors[i + j])),
      ]);
      await c.query(
        `insert into "NoteChunk" (id, "noteId", "userId", seq, title, content, embedding)
         values ${placeholders}`,
        params,
      );
    }
    await c.query('commit');
  } catch (err) {
    await c.query('rollback');
    throw err;
  }

  const after = await c.query('select count(*)::int as n from "NoteChunk"');
  console.log(`✅ 索引完成，NoteChunk 共 ${after.rows[0].n} 条`);
  await c.end();
})();
