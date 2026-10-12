/**
 * 端到端验证 search_my_notes。
 *
 * 自己签一个真实 JWT（用 .env 里的 JWT_ACCESS_SECRET，payload 与 auth.service 一致），
 * 走「换 ticket → 开 SSE 流」的真实链路问一个问题，然后检查：
 *   1. 模型有没有调用 search_my_notes（工具是否真的注册进了 bindTools）
 *   2. 工具返回了什么（说明索引能被检索到）
 *   3. 返回的 noteId 是否都属于这个用户（跨用户隔离）
 *
 * 用法：cd backend && node test/verify-search-e2e.cjs "你的问题"
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.E2E_BASE ?? 'http://localhost:3000';
const QUESTION = process.argv[2] ?? '我笔记里有没有讲过组合式函数相关的内容？';
const TIMEOUT_MS = 120_000;

/*
 * ⚠️ 先解析成对象、再灌进 process.env。
 * 边解析边赋值（`if (!process.env[k]) process.env[k] = v`）会让 .env 里
 * 重复出现的键只取到**第一个** —— 而本项目的 .env 里 JWT_ACCESS_SECRET
 * 恰好重复了两行、值还不同，于是签出来的 token 一律 401。
 * 对象赋值天然是「后者覆盖前者」，和 dotenv 的行为一致。
 */
const envFile = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
  if (m) envFile[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
for (const [k, v] of Object.entries(envFile)) {
  if (!process.env[k]) process.env[k] = v;
}

const pnpm = path.join(ROOT, 'node_modules', '.pnpm');
const findPkg = (re) => {
  const dir = fs.readdirSync(pnpm).find((d) => re.test(d));
  if (!dir) throw new Error(`找不到包：${re}`);
  return path.join(pnpm, dir, 'node_modules');
};
const { Client } = require(path.join(findPkg(/^pg@\d/), 'pg'));
const jwt = require(path.join(findPkg(/^jsonwebtoken@/), 'jsonwebtoken'));

const unwrap = (body) => (body && typeof body === 'object' && 'data' in body ? body.data : body);

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();

  const user = (
    await c.query(
      `select u.id, u.email,
              (select count(*)::int from "Note" n where n."userId" = u.id and n."deletedAt" is null) as notes
         from "User" u
        where exists (select 1 from "Note" n where n."userId" = u.id and n."deletedAt" is null)
        order by u."createdAt" asc limit 1`,
    )
  ).rows[0];
  if (!user) {
    console.error('❌ 没有找到有笔记的用户');
    process.exit(1);
  }
  console.log(`测试账号：${user.email}（${user.notes} 篇笔记）`);

  const own = new Set(
    (await c.query('select id from "Note" where "userId" = $1', [user.id])).rows.map((r) => r.id),
  );
  const chunks = (
    await c.query('select count(*)::int as n from "NoteChunk" where "userId" = $1', [user.id])
  ).rows[0].n;
  console.log(`该用户已索引 ${chunks} 块\n`);
  await c.end();

  const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: '15m',
  });

  // 1) 换 ticket
  const ticketRes = await fetch(`${BASE}/ai/chat/ticket`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ allowWrite: false }),
  });
  const rawTicket = await ticketRes.json().catch(() => null);
  console.log(`换票 HTTP ${ticketRes.status}：${JSON.stringify(rawTicket)?.slice(0, 300)}`);
  const ticketBody = unwrap(rawTicket);
  const ticket = ticketBody?.ticket ?? ticketBody?.ticketId;
  if (!ticket) {
    console.error('❌ 换票失败：', JSON.stringify(ticketBody));
    process.exit(1);
  }
  console.log(`✅ 换票成功 ticket=${String(ticket).slice(0, 12)}…`);
  console.log(`问：${QUESTION}\n`);

  // 2) SSE
  const url = `${BASE}/ai/chat/stream?q=${encodeURIComponent(QUESTION)}&ticket=${encodeURIComponent(ticket)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  const events = [];
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        try {
          events.push(JSON.parse(line.slice(5).trim()));
        } catch {
          /* 心跳等非 JSON 行忽略 */
        }
      }
      // 收到 done 就可以停了，不用等连接自然关闭
      if (events.some((e) => e.type === 'done' || e.type === 'error')) break;
    }
  } finally {
    clearTimeout(timer);
  }

  // 3) 汇总
  const toolCalls = events.filter((e) => e.type === 'tool_call');
  const toolResults = events.filter((e) => e.type === 'tool_result');
  const done = events.find((e) => e.type === 'done');
  const err = events.find((e) => e.type === 'error');

  console.log(`事件总数 ${events.length}，其中工具调用 ${toolCalls.length} 次`);
  for (const t of toolCalls) console.log(`  → 调用 ${t.name}  参数=${JSON.stringify(t.args)}`);

  const searchCall = toolCalls.find((t) => t.name === 'search_my_notes');
  if (!searchCall) {
    console.log('\n⚠️ 模型这次没有调用 search_my_notes');
    for (const r of toolResults) {
      console.log(`  ← ${r.name} 结果：${String(r.result).slice(0, 300)}`);
    }
  } else {
    const result = toolResults.find((r) => r.name === 'search_my_notes');
    console.log(`\n✅ 调用了 search_my_notes`);
    console.log(`   返回：${String(result?.result ?? '(无)').slice(0, 700)}`);

    // 4) 跨用户隔离校验
    try {
      const parsed = JSON.parse(result.result);
      const ids = (parsed.results ?? []).map((r) => r.noteId);
      const foreign = ids.filter((id) => !own.has(id));
      console.log(
        foreign.length === 0
          ? `   ✅ 隔离正常：返回的 ${ids.length} 条 noteId 全属于该用户`
          : `   ❌ 串号！有 ${foreign.length} 条不属于该用户：${foreign.join(', ')}`,
      );
    } catch {
      console.log('   （结果不是可解析的 JSON，跳过隔离校验）');
    }
  }

  if (done) console.log(`\n结束原因：${done.finishReason}`);
  if (err) console.log(`错误事件：${JSON.stringify(err)}`);
})();
