/**
 * 探测运行中的服务是否挂载了 chat 命名空间的 Socket.IO 网关。
 *
 * 思路：不用 socket.io-client，用裸 ws 走 engine.io 的 websocket 直连，
 * 按协议手工发帧：
 *   收到 `0{...}`      → engine.io 握手成功（说明 IoAdapter 已挂上 HTTP 服务）
 *   发送 `40/chat,`    → 请求接入 chat 命名空间
 *   收到 `40/chat,{...}` → 命名空间存在（网关已注册）
 *
 * 不带令牌时服务端会在 handleConnection 里主动断开，这是预期行为 ——
 * 本脚本只关心「命名空间是否可达」。
 *
 * 跑法：cd backend && node test/probe-chat-ws.cjs
 */

const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const URL = process.env.CHAT_WS_URL ?? 'ws://127.0.0.1:3000/socket.io/?EIO=4&transport=websocket';

const { WebSocket } = require(
  require.resolve('ws', {
    paths: [path.dirname(require.resolve(path.join(ROOT, 'node_modules', 'socket.io')))],
  }),
);

const received = [];
const client = new WebSocket(URL);

const done = (code) => {
  try {
    client.close();
  } catch {
    /* ignore */
  }
  console.log(`  → 收到帧：${received.length ? received.map((f) => f.slice(0, 60)).join(' | ') : '(无)'}`);
  process.exit(code);
};

client.on('open', () => console.log('  已建立 WebSocket 连接'));

client.on('message', (data) => {
  const text = data.toString();
  received.push(text);

  // engine.io open 包
  if (text.startsWith('0')) {
    console.log('  ✓ engine.io 握手成功（HTTP 服务已挂载 Socket.IO）');
    client.send('40/chat,'); // 接入 chat 命名空间
    return;
  }

  // socket.io 命名空间 CONNECT 应答
  if (text.startsWith('40/chat,')) {
    console.log('  ✓ chat 命名空间存在（ChatGateway 已注册）');
    done(0);
    return;
  }

  // 服务端因未带令牌而断开（预期）
  if (text.startsWith('41/chat,') || text.startsWith('1')) {
    console.log('  ℹ 服务端主动断开（未带令牌，符合 handleConnection 的鉴权逻辑）');
    done(received.some((f) => f.startsWith('40/chat,')) ? 0 : 1);
  }
});

client.on('error', (err) => {
  console.log('  ✗ 连接失败:', err.message);
  done(1);
});

setTimeout(() => {
  const hasHandshake = received.some((f) => f.startsWith('0'));
  const hasNamespace = received.some((f) => f.startsWith('40/chat,'));
  console.log('  ✗ 3 秒内未完成握手');
  done(hasHandshake && hasNamespace ? 0 : 1);
}, 3000);
