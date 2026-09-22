/**
 * WebSocket 依赖冒烟测试。
 *
 * 为什么需要它：`pnpm install` 成功只说明包进了 node_modules，
 * 不代表运行时的 require 链能解析 —— pnpm 的严格布局下，
 * 少一个传递依赖要等到 Nest 启动网关时才炸。
 *
 * 这里做三件事：
 *   1. 三个新包能否 require（含它们的传递依赖）
 *   2. 真起一个 socket.io 服务端
 *   3. 用裸 ws 客户端完成 engine.io 握手，拿到 open 包
 *
 * 第 3 步刻意不用 socket.io-client（没装）：engine.io 允许
 * transport=websocket 直连，用 ws 就能验证整条协议栈是活的。
 *
 * 跑法：cd backend && node test/smoke-ws.cjs
 */

const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const nm = (p) => path.join(ROOT, 'node_modules', p);

let failed = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failed += 1;
}

console.log('=== A. 三个新包能否 require ===');

let Server;
try {
  ({ Server } = require(nm('socket.io')));
  check('socket.io 可加载', typeof Server === 'function');
} catch (err) {
  check('socket.io 可加载', false, err.message);
}

try {
  const websockets = require(nm('@nestjs/websockets'));
  check(
    '@nestjs/websockets 可加载',
    typeof websockets.WebSocketGateway === 'function' &&
      typeof websockets.SubscribeMessage === 'function',
  );
} catch (err) {
  check('@nestjs/websockets 可加载', false, err.message);
}

try {
  const platformSocketIO = require(nm('@nestjs/platform-socket.io'));
  check(
    '@nestjs/platform-socket.io 可加载（含 IoAdapter）',
    typeof platformSocketIO.IoAdapter === 'function',
  );
} catch (err) {
  check('@nestjs/platform-socket.io 可加载', false, err.message);
}

console.log('\n=== B. 版本是否与项目既有 Nest 对齐 ===');
for (const p of ['@nestjs/common', '@nestjs/core', '@nestjs/websockets', '@nestjs/platform-socket.io']) {
  try {
    const v = require(path.join(nm(p), 'package.json')).version;
    check(`${p} = ${v}`, true);
  } catch (err) {
    check(`${p} 版本读取失败`, false, err.message);
  }
}
try {
  const v = require(path.join(nm('socket.io'), 'package.json')).version;
  check(`socket.io = ${v}`, true);
} catch (err) {
  check('socket.io 版本读取失败', false, err.message);
}

console.log('\n=== C. 起真实服务端 + 裸 ws 握手 ===');

(async () => {
  const server = http.createServer();
  let io;
  try {
    io = new Server(server, {
      // 只留 websocket，裸 ws 客户端才能直接握手（默认是 polling 优先）
      transports: ['websocket'],
    });
    check('new socket.io Server 构造成功', true);
  } catch (err) {
    check('new socket.io Server 构造成功', false, err.message);
    process.exit(1);
  }

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  check('HTTP server 已监听', Number.isInteger(port), `port=${port}`);

  // ws 是 engine.io 的传递依赖，不在顶层，按 socket.io 的真实位置解析
  let WebSocket;
  try {
    const wsPath = require.resolve('ws', {
      paths: [path.dirname(require.resolve(nm('socket.io')))],
    });
    WebSocket = require(wsPath);
    check('ws 可从 socket.io 的依赖树解析', typeof WebSocket === 'function');
  } catch (err) {
    check('ws 可解析', false, err.message);
    server.close();
    process.exit(1);
  }

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: '10s 超时未收到 open 包' }), 10000);
    let client;
    try {
      client = new WebSocket(
        `ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`,
      );
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
      return;
    }
    client.on('message', (data) => {
      const text = data.toString();
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      // engine.io open 包形如 0{"sid":"...","upgrades":[],...}
      resolve({ ok: text.startsWith('0'), reason: text.slice(0, 90) });
    });
    client.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: err.message });
    });
  });

  check('engine.io 握手拿到 open 包', result.ok, result.reason);

  io.close();
  server.close();

  console.log(
    `\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（WebSocket 依赖栈）`,
  );
  process.exit(failed === 0 ? 0 : 1);
})();
