# OLCT 数字资产交易所 · 伪代码实现详解

> **这份文档是什么**：不是项目源码（那是公司资产），而是把简历里 OLCT 那 7 条技术描述，
> 逐条展开成**可落地的伪代码 + 逐段讲解**。目的是让你能回答两个问题：
> 「我写的这句话，具体是怎么实现的」和「面试官追问细节时我能不能接住」。
>
> **伪代码的约定**：语法贴近 TypeScript + Vue 3 组合式 API + Pinia，
> 关键处**参数取真实工程值**（不是占位符），并在注释里写清「为什么是这个值」。
> 所有写法都确保能在 `Vue 3 + TS + UniApp + Pinia + uView Pro + ECharts + Vite` 这套栈里落地。
>
> **配套文档**：`wisora-代码逐文件详解.md`（那是真实代码的逐文件注释，可作为「真实项目长什么样」的参照）。

---

## 0. 项目与技术栈

| 项 | 内容 |
|---|---|
| 项目 | OLCT 数字资产交易所前端 —— 行情、交易、资产 |
| 时间 | 2025.10 – 2026.01 |
| 技术栈 | Vue 3 · TypeScript · UniApp · Pinia · Element Plus · uView Pro · ECharts · Vite · WebSocket · Tailwind CSS · UnoCSS |
| 交付形态 | **H5 + App + Web 三端**：H5/App 由 UniApp 一套代码条件编译，Web 端独立实现 |

### 这份文档覆盖的 7 条

| # | 简历里的说法 | 对应章节 | 核心难点 |
|---|---|---|---|
| 1 | 多端研发，条件编译共享代码，Web 端独立实现 | §1 | 复用边界怎么划 |
| 2 | 请求层 + 双 Token 无感刷新 + 401 刷新队列 | §2 | 并发 401 只刷一次 |
| 3 | 行情「合并订阅 + 增量对齐」 | §3 | 订单簿不累积错位 |
| 4 | 高频刷新合帧 + 精度分组 | §4 | 每帧都不触发渲染 |
| 5 | WebSocket 保活重连 + ECharts K 线增量 | §5 | 重连风暴、K 线重绘 |
| 6 | 国际化按需加载 + 主题切换（含 App 端 Pinia 持久化坑） | §6 | 首屏不载全量语言包 |
| 7 | 性能优化（字体子集化、分包、CDN、虚拟滚动） | §7 | 首屏只加载必要资源 |

> 建议的读法：先读 §0.2 的分层图建立全局印象，然后按你**最没底的那条**开始读。

### 0.1 先建立一张心智图

交易终端这类应用，本质上只有三件事在做：

```
① 把服务端的「变化」尽可能快地搬到屏幕上         → 行情链路（§3 §4 §5）
② 把用户的「意图」尽可能可靠地送到服务端         → 请求层 + 交易链路（§2）
③ 让同一份代码在三种运行环境里都跑得像原生        → 多端 + 性能（§1 §6 §7）
```

第 ① 件事做不好 → K 线卡顿、盘口跳变、数字对不上；
第 ② 件事做不好 → 下单重复、登录被踢、错误提示看不懂；
第 ③ 件事做不好 → App 白屏、首屏 5 秒、包体 30MB。

后面每一节都是这三件事的一个切面。

### 0.2 理想的分层（后面所有伪代码都落在这里）

```
┌─────────────────────────────────────────────────────────┐
│ pages/        行情页 · 交易页 · 资产页（三端各一套 UI 壳）  │
├─────────────────────────────────────────────────────────┤
│ stores/       Pinia：marketStore · tradeStore · userStore │
│               （三端共用，只依赖下面的 core 层）            │
├─────────────────────────────────────────────────────────┤
│ core/         ★ 三端零差异的纯逻辑层（复用边界的核心）       │
│   ├─ request/      请求层（拦截器 / 刷新队列 / 重试）        │
│   ├─ ws/           连接管理 + 频道订阅 + 增量对齐            │
│   ├─ market/       订单簿 / 成交 / K 线的数据结构与合并算法   │
│   └─ utils/        精度 / 格式化 / 时间                     │
├─────────────────────────────────────────────────────────┤
│ adapters/     ★ 按端实现同一组接口（差异都被关在这里）        │
│   ├─ storage.ts    本地存储（H5 用 localStorage，App 用文件） │
│   ├─ ws.ts         WebSocket（H5 原生 / App 走 uni.connect） │
│   └─ chart.ts      图表容器（H5 canvas / App 原生层）        │
└─────────────────────────────────────────────────────────┘
```

**这张图是 §1 的核心答案** —— 复用边界不是「能用就复用」，而是：

- `core/` 与 `stores/`：**三端 100% 相同**（纯逻辑，不含任何端 API）
- `adapters/`：**按端各写一份，但接口签名完全一致**（差异被隔离在最小的表面积里）
- `pages/` 与 `components/`：仅 H5/App 用条件编译，**Web 端另写一套**（因为桌面端的布局与交互差异是「结构性」的，硬共用会变成满屏 `ifdef`）

---

## §1 多端研发：条件编译共用业务、Web 端独立实现

### 简历原文

> 主导交易终端**多端研发**：H5 与 App 基于 UniApp 条件编译共享一套业务代码、按端注入差异能力，
> Web 端独立实现以适配桌面端布局与键鼠交互；通过划分两端复用边界，有效降低重复开发成本。

### 1.1 这句话在说什么

翻译成人话：**三个端一共有 100% 的业务逻辑和 3 套 UI**。

- 业务逻辑（连 WS、算订单簿、处理 K 线数据、下单、算手续费）→ 只写一遍；
- 交互外壳（用户的点法完全不一样）→ 各写各的：
  - 手机（H5/App）：单列、底部 tab、手势、全屏弹层；
  - 桌面（Web）：三栏并排、悬浮面板、右键菜单、快捷键、鼠标悬停。

很多人做多端失败，是因为把「共用」理解成了「共用页面」。页面是最不该共用的 —— 它承载的正是端的差异。

### 1.2 复用边界怎么划（伪代码）

```ts
// ─────────────────────────────────────────────────────────
// ① 环境判定：全项目只有这一处
// ─────────────────────────────────────────────────────────
// #ifdef 是 UniApp 的「编译期条件编译」—— 注意是编译期，不是运行时 if。
// 被排除的分支根本不会进产物，所以不会让包体变大。
// #endif

// core/env/platform.ts
export const PLATFORM = {
  // #ifdef H5
  kind: 'h5' as const,
  // #endif
  // #ifdef APP-PLUS
  kind: 'app' as const,
  // #endif
  // #ifdef MP-WEIXIN
  kind: 'mp' as const,     // 预留：当前不做小程序，但结构上留着
  // #endif
} // 注意：Web 端是独立工程，不参与这里的条件编译

/** 是否是触屏优先的形态（决定用「手势」还是「鼠标」交互） */
export const isTouchFirst = PLATFORM.kind !== 'web'
```

```ts
// ─────────────────────────────────────────────────────────
// ② adapters：同一个接口，三份实现 —— 差异被关在这里
// ─────────────────────────────────────────────────────────

// adapters/types.ts —— 接口定义（三端共用，是「契约」）
export interface StorageAdapter {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}
export interface WsAdapter {
  connect(url: string, token: string): void
  send(payload: string): void
  close(): void
  onOpen(cb: () => void): void
  onMessage(cb: (raw: string) => void): void
  onClose(cb: (code: number) => void): void
  onError(cb: (err: unknown) => void): void
}
```

```ts
// adapters/storage.h5.ts
import type { StorageAdapter } from './types'

export const storage: StorageAdapter = {
  get: (key) => localStorage.getItem(key),
  set: (key, value) => localStorage.setItem(key, value),
  remove: (key) => localStorage.removeItem(key),
}
```

```ts
// adapters/storage.app.ts
import type { StorageAdapter } from './types'

// App 端用 uni 的同步存储 API —— 它底层落到原生，比 localStorage 可靠（不会被清理）
export const storage: StorageAdapter = {
  get: (key) => uni.getStorageSync(key) || null,
  set: (key, value) => uni.setStorageSync(key, value),
  remove: (key) => uni.removeStorageSync(key),
}
```

```ts
// adapters/index.ts —— 唯一的「按端注入」点，全项目就这一处 ifdef 选实现
// #ifdef H5
export { storage } from './storage.h5'
export { ws } from './ws.h5'
// #endif
// #ifdef APP-PLUS
export { storage } from './storage.app'
export { ws } from './ws.app'
// #endif
```

```ts
// ─────────────────────────────────────────────────────────
// ③ core / stores：全文没有一处 ifdef，因为不依赖任何端 API
// ─────────────────────────────────────────────────────────

// core/request/client.ts
import { storage } from '@/adapters'      // ← 只依赖「接口」，不知道底层是谁
import { PLATFORM } from '@/core/env/platform'

export const request = createClient({
  baseURL: import.meta.env.VITE_API_BASE,
  getToken: () => storage.get('TOKEN'),
  // 差异能力也走「能力查询」而不是「端判断」，
  // 这样将来加端不需要回头改 core：
  features: {
    canAbort: true,                      // 三端都支持 AbortController
    needProxyCors: PLATFORM.kind === 'h5',
  },
})
```

### 1.3 逐段讲解

**① 为什么用编译期条件编译，而不是运行时 `if (isApp)`**

运行时判断会有两个代价：被判断掉的分支代码**仍然打进包里**；而且很容易在「本该 H5 专属的代码」里引用 App 才有的全局对象（比如 `plus`），在某些构建配置下直接报错。`#ifdef` 在编译期就把无关代码删掉，包体更小、也不会引入不存在的符号。

**② 为什么要有 `adapters/` 这一层**

这是整套方案里最值钱的一层。如果你直接在 `core` 里写：

```ts
// ✗ 反面写法：差异渗透到业务层
function getToken() {
  // #ifdef H5
  return localStorage.getItem('TOKEN')
  // #endif
  // #ifdef APP-PLUS
  return uni.getStorageSync('TOKEN')
  // #endif
}
```

那么每加一个需要差异化的能力，所有业务文件都要进来加一遍 `#ifdef` —— 最后代码变成「到处是条件编译」，没人敢改。

正确做法是**把差异收敛成接口**：`core` 只认 `StorageAdapter`，具体是谁在运行时决定。于是：

- 加端 = 新写一个 `storage.xx.ts`，**业务代码一行不改**；
- 单元测试 = 注入一个内存实现，不依赖任何端 API。

**③ Web 端为什么单独一套**

关键判断是「差异的性质」：

| 差异类型 | 例子 | 处理方式 |
|---|---|---|
| **能力差异** | 存储 API、WS 实现、文件系统 | 抽接口，`adapters` 各写一份 ← **值得共用** |
| **结构差异** | 手机单列 vs 桌面三栏、手势 vs 快捷键 | 各写一套 UI ← **不值得共用** |

手机上一个「下单面板」是从底部弹出的全屏浮层；桌面上它是右侧常驻的一栏，输入框要有 `Tab` 键顺序、要支持数字键盘上下微调、要能同时看到盘口。这两者的**组件结构都不同**，硬共用的结果一定是 `v-if="isDesktop"` 套 `v-if="isDesktop"`。

所以 Web 端独立实现 —— 但它**复用同一个 `core/`**：

```
h5-app 工程 ──┐
              ├──→ core/（业务逻辑，100% 共用）
web 工程    ──┘
```

这才是「降低重复开发成本」的真实含义：省掉的是**业务逻辑的重复**，不是 UI 的重复。

### 1.4 面试会追问什么

**Q：条件编译具体能编译掉什么？怎么保证不出错？**
A：它是**编译期**文本替换，被排除的分支不进产物。风险在于「只在某一个端才能编译通过」的写法 —— 所以我的做法是把端相关代码**全部收进 `adapters/`**，`core` 与 `stores` 里零 `ifdef`，这样任何一个端都能独立编译通过。

**Q：Web 端为什么不也用 UniApp？**
A：UniApp 的 H5 产物本质是移动端页面（`rem` 适配、触摸事件优先），做成桌面端的三栏布局要写大量覆盖样式，反而更贵。更关键的是**交互模型不同**：桌面端要键鼠、右键菜单、悬停预览、快捷键，这些在移动端框架里没有对应抽象。

**Q：三端共用逻辑，怎么保证不会因为某个端的行为差异而出 bug？**
A：把差异**显式化** —— 差异只在 `adapters` 的接口实现里，不在业务判断里。所以排查时可以只盯那几个文件，而不是全项目搜 `#ifdef`。

---

## §2 请求层与双 Token 无感刷新

### 简历原文

> 封装统一**请求层**：请求 / 响应拦截、重复请求取消、AbortController 中断、统一错误处理、
> 接口缓存、超时重试与请求日志；**双 Token 无感刷新**配合 401 刷新队列 ——
> 并发失效时**只发起一次刷新、其余请求入队等待重放**，避免刷新风暴以及旧令牌覆盖新令牌。

### 2.1 这句话在说什么

交易终端里「登录态过期」这件事有两个特点：**请求密度极高**（行情页一秒好几个），**并发度高**（页面初始化时同时发十几个请求）。

朴素实现会在这个场景下炸掉：

```
t0  页面初始化，同时发 12 个请求
t1  12 个请求全部 401（access token 过期）
t2  12 个 401 处理逻辑各自发现「过期了，该刷新」
t3  12 个刷新请求同时发出 ← 刷新风暴
t4  后返回的刷新响应覆盖先返回的 ← 旧令牌覆盖新令牌
t5  部分请求用旧令牌重试，又 401 ← 死循环
```

所以「只刷新一次 + 其余排队重放」不是一个优化，是**正确性要求**。

### 2.2 伪代码

#### ① 请求层的主流程

```ts
// core/request/client.ts
import { storage } from '@/adapters'
import { pending } from './pending'
import { refresh } from './refresh'
import { cache } from './cache'
import { notifyError, showLoading, hideLoading } from './feedback'
import { logRequest, logResponse } from './logger'

export const createClient = (opts: { baseURL: string; getToken: () => string | null }) => {
  const instance = axios.create({
    baseURL: opts.baseURL,
    timeout: 15_000,                  // 行情类接口另有更短的局部超时
  })

  // ─────────── 请求拦截 ───────────
  instance.interceptors.request.use((config) => {
    const meta = (config.metadata ??= { retryCount: 0, requestId: genId() })

    // ① loading：引用计数，且打标记防止重放时重复计数
    if (config.loading && !meta.loadingShown) {
      showLoading(); meta.loadingShown = true
    }

    // ② 缓存命中：用 adapter 伪造响应，而不是提前 return
    //    （提前 return 会跳过响应拦截器的解包与日志，出现「命中缓存但 loading 不消失」）
    if (config.cache) {
      const key = buildCacheKey(config)
      meta.cacheKey = key
      const hit = cache.get(key)
      if (hit) return { ...config, adapter: () => Promise.resolve(fakeResponse(hit)) }
    }

    // ③ token 注入（刷新接口自身要跳过，见下）
    if (!config.ignoreToken) {
      const token = opts.getToken()
      if (token) config.headers.Authorization = `Bearer ${token}`
    }

    // ④ 重复请求取消：同一个「方法 + URL + 参数」在飞时，abort 掉旧的那条
    if (config.cancelRepeat !== false) pending.add(config)

    logRequest(config)
    return config
  })

  // ─────────── 响应拦截 ───────────
  instance.interceptors.response.use(
    (res) => {
      pending.remove(res.config)
      hideLoading(res.config)
      logResponse(res)
      const raw = res.data
      if (raw.code === 200) {
        if (res.config.cache) cache.set(res.config.metadata.cacheKey, raw.data, res.config.cacheTTL)
        return raw.data                       // ← 统一解包 {code,msg,data} → data
      }
      notifyError(raw.msg || '请求失败')
      return Promise.reject(new BizError(raw.code, raw.msg))
    },
    async (err) => {
      pending.remove(err.config)

      // ─── 401：交给刷新队列 ───
      const status = err.response?.status
      const cfg = err.config
      if (status === 401 && !cfg?.bypassRefresh && !cfg?._retried) {
        try {
          const newToken = await refresh.run(cfg)      // 只刷一次，其余排队
          cfg._retried = true
          cfg.headers.Authorization = `Bearer ${newToken}`
          return instance.request(cfg)                 // 用新令牌重放原请求
        } catch (e) {
          return Promise.reject(e)
        }
      }

      hideLoading(cfg)
      notifyError(toUserMessage(err))
      return Promise.reject(err)
    },
  )

  return instance
}
```

#### ② 「只刷新一次 + 其余排队」的核心

```ts
// core/request/refresh.ts
type QueueItem = {
  resolve: (token: string) => void
  reject: (err: unknown) => void
}

let refreshing = false
let queue: QueueItem[] = []
let refreshHandler: () => Promise<string>   // 由外面注入，避免循环依赖

export const setRefreshHandler = (fn: () => Promise<string>) => { refreshHandler = fn }

export const refresh = {
  /** 每个 401 请求都调它，但真正发起的刷新只有一个 */
  async run(originalConfig: any): Promise<string> {
    // ★ 已经在刷新中：入队等着，不重复发起
    if (refreshing) {
      return new Promise<string>((resolve, reject) => queue.push({ resolve, reject }))
    }

    refreshing = true
    try {
      const newToken = await refreshHandler()        // 只此一次网络请求

      // 唤醒所有排队的请求，各自用新 token 重放
      queue.forEach(({ resolve }) => resolve(newToken))
      return newToken
    } catch (err) {
      // 刷新失败（refresh token 也过期 / 被踢）→ 全部失败 → 引导重新登录
      queue.forEach(({ reject }) => reject(err))
      onSessionExpired()                             // 清 token + 跳登录
      throw err
    } finally {
      refreshing = false
      queue = []
    }
  },
}
```

```ts
// core/request/setup.ts —— 在 main.ts 里 import 一次（副作用注册）
import { setRefreshHandler } from './refresh'
import { storage } from '@/adapters'
import { request } from './client'

setRefreshHandler(async () => {
  const refreshToken = storage.get('REFRESH_TOKEN')
  if (!refreshToken) throw new Error('无 refresh token')

  // ★ 关键：刷新请求自己要跳过两件事，否则会无限递归
  const { accessToken, refreshToken: next } = await request.post(
    '/auth/refresh',
    { refreshToken },
    {
      ignoreToken: true,     // ① 不注入旧 access token（它已经过期了，注了也没用）
      bypassRefresh: true,   // ② 这个请求自己 401 时不再触发刷新
      loading: false,        // ③ 不让刷新过程弹全局加载遮罩
    },
  )

  storage.set('TOKEN', accessToken)
  storage.set('REFRESH_TOKEN', next)
  return accessToken
})
```

#### ③ 其余几个能力

```ts
// core/request/pending.ts —— 重复请求取消
const map = new Map<string, AbortController>()

const keyOf = (cfg) =>
  [cfg.method, cfg.url, JSON.stringify(cfg.params ?? {}), JSON.stringify(cfg.data ?? {})].join('&')

export const pending = {
  add(config) {
    const key = keyOf(config)
    // 同键请求已在飞 → 取消旧的（典型场景：用户连续切换交易对，旧的行情请求已无意义）
    map.get(key)?.abort()
    const controller = new AbortController()
    config.signal = controller.signal
    map.set(key, controller)
  },
  remove(config?: { url?: string; method?: string; params?: any; data?: any }) {
    if (!config?.url) return
    map.delete(keyOf(config as any))
  },
  clear() { map.forEach((c) => c.abort()); map.clear() },   // 登出时调用
}
```

```ts
// core/request/retry.ts —— 只重试「值得重试」的错误
const RETRYABLE = new Set(['ETIMEDOUT', 'ECONNABORTED', 'NETWORK_ERROR'])
const MAX_RETRY = 2

export function shouldRetry(err: any): boolean {
  const cfg = err.config
  if (!cfg || cfg.method?.toLowerCase() !== 'get') return false
  // ★ 写操作（下单、撤单）绝不自动重试：超时≠失败，重试可能造成重复下单
  if (cfg.mutation) return false
  if ((cfg.metadata?.retryCount ?? 0) >= MAX_RETRY) return false
  return RETRYABLE.has(err.code) || err.response?.status >= 500
}

export const retryDelay = (attempt: number) =>
  Math.min(1000 * 2 ** attempt, 8000) + Math.random() * 200   // 指数退避 + 抖动
```

```ts
// core/request/feedback.ts —— 加载与错误反馈走发布订阅，不依赖 UI 框架
let loadingCount = 0
const loadingListeners = new Set<(n: number) => void>()

export const showLoading = () => { loadingCount++; loadingListeners.forEach((f) => f(loadingCount)) }
export const hideLoading = (cfg?: any) => {
  if (cfg?.metadata?.loadingShown) cfg.metadata.loadingShown = false
  loadingCount = Math.max(0, loadingCount - 1)
  loadingListeners.forEach((f) => f(loadingCount))
}
```

### 2.3 逐段讲解

**① 为什么 12 个并发 401 只刷一次，靠的是「布尔 + 队列」而不是锁**

`refreshing` 这个布尔就是全部的秘密。时间线：

```
t0  请求 1 拿到 401 → refreshing=false → 置 true → 发起刷新
t1  请求 2~12 拿到 401 → refreshing=true → 各自把 {resolve,reject} 丢进 queue，不发请求
t2  刷新成功 → 遍历 queue 逐个 resolve(newToken) → 12 个请求各自重放
```

**「旧令牌覆盖新令牌」是怎么产生的**（简历里特意提了这个坑）：如果 12 个请求各自刷新，刷新接口会返回 12 组新令牌，`storage.set` 会被调用 12 次。网络乱序时，先发出的刷新可能后返回，于是**最后写入的可能是更旧的一对令牌** —— 表现为「刚登录成功，下一步操作又要求登录」。用队列之后，`storage.set` 只发生一次。

**② 为什么用 `adapter` 伪造响应，而不是命中缓存就直接 return**

用 axios 的 `adapter` 覆盖：

```ts
return { ...config, adapter: () => Promise.resolve(fakeResponse(hit)) }
```

这样请求会**照常走完响应拦截器**（解包、`hideLoading`、日志）。如果写成 `if (hit) return Promise.resolve(hit)`，就会出现：`loadingShown` 打了标记但 `hideLoading` 没被调用 → **加载遮罩永远不消失**。这个坑在 `wisora-web` 项目里也踩过（见配套文档 §2.2），写法完全一样。

**③ 刷新接口的三个 flag 为什么缺一不可**

| flag | 不加会怎样 |
|---|---|
| `ignoreToken: true` | 拿过期的 access token 去刷新，后端可能直接 401（有的实现会校验） |
| `bypassRefresh: true` | **致命** —— 刷新接口自己 401 时又进刷新队列 → 无限递归，浏览器直接卡死 |
| `loading: false` | 每次静默刷新都弹一个全屏遮罩，用户正在看盘口时突然黑一下 |

**④ 为什么写操作绝不能自动重试**

这是交易类应用的红线。`POST /order` 超时不代表失败 —— 可能订单已经成交、只是响应丢了。自动重试会**下两次单**。所以：

```ts
if (cfg.mutation) return false   // 下单/撤单/划转 一律不重试
```

正确做法是：超时后**主动查询订单状态**（带客户端生成的 `clientOrderId`），以服务端的记录为准。简历里写的是「超时重试」，在文档里要能说清这个边界 —— 这个追问面试官很爱出。

**⑤ 缓存用在哪些接口**

不是所有 GET 都该缓存。行情类**必须不缓存**（数据每秒在变，缓存等于显示错价）。适合缓存的只有：

| 接口 | TTL | 理由 |
|---|---|---|
| 交易对列表 / 精度配置 | 10 分钟 | 极少变化 |
| 币种信息、公告 | 5 分钟 | 变化慢 |
| 用户资料 | 不缓存 | 可能被后台改 |

**⑥ 请求日志**

只在开发环境输出，且**必须脱敏**：`Authorization` 头、`password` / `refreshToken` 字段在打印前替换成 `***`。生产环境打日志既浪费性能，也可能把令牌写进用户设备的日志里。

### 2.4 面试会追问什么

**Q：为什么不用 `axios-auth-refresh` 这类现成库？**
A：可以，但我需要三类定制：① 刷新请求自己要 bypass 刷新；② 刷新失败要触发「全局登出」这条业务逻辑；③ 不同接口的缓存与重试策略不同。用库的话这几处都是侵入式配置，不如自己写 60 行清楚。

**Q：`AbortController` 和「重复请求取消」是一回事吗？**
A：不是。**重复请求取消**是「同键请求自动互相取消」（系统行为，防止旧响应后到覆盖新响应）；**AbortController 中断**是「业务主动取消」（用户在请求返回前离开页面、切换交易对、点了取消按钮）。两者复用的都是 `AbortController`，但触发源不同。另外注意：**abort 后的回调必须丢弃**，否则会在新页面里渲染上一个页面的数据。

**Q：如果 access token 有效期是 2 小时，refresh token 是 7 天，服务端怎么标记已登出？**
A：这题是考令牌吊销。我当时的认知边界是：无状态 JWT 本身无法吊销，要靠 `tokenVersion` 或 Redis 黑名单。**如果面试问到这，可以坦诚说明当时用的是「有效期 + 前端清理」，没做服务端吊销** —— 硬答会露馅。

---

## §3 行情：「合并订阅 + 增量对齐」

### 简历原文

> 行情推送按**「合并订阅 + 增量对齐」**处理：在**单条连接内合并多个频道订阅**（减少握手次数与连接数），
> 再按频道名分发到对应模块；订单簿采用**快照 + 增量**两段式 —— 先拉一次全量快照并记录其序号，
> 再消费差值推送，**丢弃早于该序号的过期增量**，且**断线重连后重新拉快照重新对齐**，
> 避免长时间运行后订单簿累积错位。

### 3.1 这句话在说什么

交易终端要同时订阅几十个频道：

```
交易对 BTCUSDT：深度 diff depth  · 逐笔成交 trade · K 线 kline_1m
交易对 ETHUSDT：深度               · 成交          · K 线
另外还有：账户订单推送、仓位、资金费率、标记价格 …
```

**朴素做法**（每个频道一条 WebSocket）的问题：

- 30 个频道 = 30 次 TCP + TLS 握手（每次 100ms+），页面加载慢半拍；
- 30 条连接各有一套心跳，服务端也有连接数上限（多数交易所限制单 IP 连接数）；
- 移动端更明显：一条长连接已经费电，30 条直接功耗爆表。

**解法是两层**：先「合并订阅」（一条连接承载所有频道），再「增量对齐」（保证合并后的数据在长时间运行下**不会越算越错**）。

### 3.2 伪代码

#### ① 合并订阅：一条连接承载所有频道

```ts
// core/ws/connection.ts
type Channel = { topic: string; payload: any }

class MarketConnection {
  private ws: WsAdapter | null = null
  private subscribed = new Map<string, number>()   // topic → 引用计数（多个组件订阅同一个 topic）
  private handlers = new Map<string, Set<(data: any) => void>>()
  private state: 'idle' | 'connecting' | 'open' | 'closing' = 'idle'

  constructor(private url: string, private getToken: () => string | null) {}

  // ★ 合并的落点：不是「订阅一个发一次」，而是把「要订阅什么」攒起来一次性发
  subscribe(topic: string, handler: (data: any) => void) {
    const set = this.handlers.get(topic) ?? new Set()
    set.add(handler)
    this.handlers.set(topic, set)

    const refCount = (this.subscribed.get(topic) ?? 0) + 1
    this.subscribed.set(topic, refCount)

    if (refCount === 1) {
      // 首次订阅这个 topic → 需要一个「订阅动作」，但先入队
      this.queueSubscription(topic)
    }
    return () => this.unsubscribe(topic, handler)
  }

  /**
   * ★ 批量合并：把 300ms 内的订阅请求攒成一条消息发出
   *
   * 为什么是 300ms：
   * - 行情页初始化时会同时订阅十几个 topic，逐条发会有十几次往返；
   * - 300ms 是「用户几乎感知不到」和「一次攒够」的平衡点；
   * - 用微任务（queueMicrotask）也行，但那样攒得不够多，反而多几次往返。
   */
  private queueSubscription(topic: string) {
    this.pendingTopics.add(topic)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const topics = [...this.pendingTopics]; this.pendingTopics.clear()
      if (!topics.length) return
      // 合并成一条 SUBSCRIBE 消息（不同交易所协议名不同，但结构类似）
      this.rawSend({ method: 'SUBSCRIBE', params: topics, id: nextReqId() })
    }, 300)
  }

  private rawSend(payload: any) { this.ws?.send(JSON.stringify(payload)) }
}
```

```ts
// core/ws/dispatch.ts
/**
 * ★ 按频道名分发：合并订阅之后，所有消息都从同一个 onmessage 出来，
 *   必须靠 topic 把它路由回对应的模块。
 *
 * 上游回来的形状（以 Binance 风格为例）：
 *   { stream: 'btcusdt@depth@100ms', data: { U: 101, u: 105, b: [...], a: [...] } }
 *   { stream: 'btcusdt@aggTrade',    data: { p: '65000.1', q: '0.3', T: 1712... } }
 */
function dispatch(raw: string) {
  const msg = JSON.parse(raw)

  // ① 心跳/控制帧：不是业务数据，直接消费掉
  if (msg.event === 'pong' || msg.result === null) return

  // ② 订阅确认帧
  if (msg.id && msg.result !== undefined) { ackSubscribe(msg.id); return }

  // ③ 业务数据：取 stream 名，去掉 @ 后面的参数部分拿到「频道类型」
  const stream: string = msg.stream ?? ''
  const [symbol, kind] = stream.split('@')    // 'btcusdt' / 'depth@100ms'

  const topic = normalizedTopic(symbol.toUpperCase(), kind)
  const handlers = this.handlers.get(topic)
  if (!handlers?.size) return                  // 没有订阅者就丢弃（比如页面已离开）

  for (const handler of handlers) {
    try {
      handler(msg.data)
    } catch (e) {
      // ★ 单个 handler 抛错不能让整条连接崩掉
      reportError(e)
    }
  }
}
```

#### ② 增量对齐：订单簿为什么不累积错位

这是整份文档里最需要讲清楚的一段。

**问题是这样的**：订单簿（depth）的全量数据很大（比如 1000 档买卖盘），交易所不可能每秒推全量，所以推的是**增量**（「第 3 档买盘数量减少 0.5」「新增一个卖单价位」）。客户端收到增量后自己 merge 进本地订单簿。

**错位是这样发生的**：

```
t0  客户端拉快照（拿到的这一刻，真实订单簿是 S0）
t1  交易所开始推增量 d1、d2、d3…
    —— 但如果「推 d1 的时刻」发生在「服务端生成快照 S0 之前」，
       那么 d1 描述的变化已经包含在 S0 里了。
       客户端却把 d1 又 merge 了一次 → 数量被加了两次 → 从此永久错位
```

**所以每条增量都带序号**，客户端用它判断「这条增量我该不该吃」：

```ts
// core/market/orderbook.ts
type Snapshot = { lastUpdateId: number; bids: [string, string][]; asks: [string, string][] }
type Diff = {
  firstUpdateId: number    // 这条增量的起始序号（Binance 叫 U）
  finalUpdateId: number    // 这条增量的结束序号（Binance 叫 u）
  bids: [string, string][]
  asks: [string, string][]
}

class OrderBook {
  private bids = new Map<string, string>()   // price → qty，价格用字符串做 key（避免浮点误差）
  private asks = new Map<string, string>()
  private lastUpdateId = -1
  private buffered: Diff[] = []              // 快照到达前先攒着
  private ready = false

  /**
   * ★ 第一步：快照到达
   * 快照本身也带序号（lastUpdateId），它是「这份全量数据的版本号」
   */
  applySnapshot(snap: Snapshot) {
    this.bids.clear(); this.asks.clear()
    for (const [p, q] of snap.bids) if (q !== '0') this.bids.set(p, q)
    for (const [p, q] of snap.asks) if (q !== '0') this.asks.set(p, q)
    this.lastUpdateId = snap.lastUpdateId
    this.ready = true

    // ★ 快照生成期间到达的增量不能直接丢 —— 它们在缓冲里，按规则回放
    const buffered = this.buffered; this.buffered = []
    for (const diff of buffered) this.applyDiff(diff)
  }

  /**
   * ★ 第二步：增量到达 —— 三条判断顺序不能变
   */
  applyDiff(diff: Diff) {
    if (!this.ready) {
      // 快照还没到，先缓冲（但要限制长度，防止快照请求失败时无限堆积）
      if (this.buffered.length < 5000) this.buffered.push(diff)
      return
    }

    // 判断 ①：完全是旧数据 —— 这条增量的结束序号还没赶上快照版本 → 整条丢弃
    //   这就是简历里说的「丢弃早于该序号的过期增量」
    if (diff.finalUpdateId <= this.lastUpdateId) return

    // 判断 ②：断层 —— 增量与当前版本之间缺了数据（比如网络丢包）
    //   期望：firstUpdateId <= lastUpdateId + 1 <= finalUpdateId
    if (diff.firstUpdateId > this.lastUpdateId + 1) {
      this.ready = false
      this.buffered = []
      this.onGapDetected()       // ★ 触发重新拉快照（见下）
      return
    }

    // 判断 ③：正常情况，吃掉
    this.merge(diff.bids, this.bids)
    this.merge(diff.asks, this.asks)
    this.lastUpdateId = diff.finalUpdateId
    this.emitChange()
  }

  private merge(updates: [string, string][], side: Map<string, string>) {
    for (const [price, qty] of updates) {
      // ★ 数量为 0 表示「这个价位被吃掉了」→ 删除该档
      //   不处理这个约定，订单簿会留下一堆数量为 0 的幽灵档位
      if (qty === '0') side.delete(price)
      else side.set(price, qty)
    }
  }
}
```

```ts
// 断层或重连时的处理：重新对齐
private async onGapDetected() {
  // ★ 为什么必须「重新拉快照」而不是「只补缺失的那段增量」：
  //   交易所通常不提供「按序号区间补历史增量」的接口。
  //   即便有，也可能因为保留窗口太短而拿不到。
  //   所以最可靠的做法是把本地订单簿整个丢掉、重新建立。
  this.bufferring = true
  const snap = await fetchDepthSnapshot(this.symbol)   // 独立 REST 请求
  this.applySnapshot(snap)
}
```

#### ③ 重连后必须重新对齐

```ts
// core/ws/reconnect.ts
class ReconnectPolicy {
  private attempt = 0

  /**
   * ★ 指数退避 + 抖动
   *
   * 为什么必须有抖动（jitter）：
   * 服务端重启时，几千个客户端会在同一刻断线。
   * 如果退避时间是纯指数 1s/2s/4s/8s…，所有客户端会在同一时刻重连 →
   * 形成「重连风暴」，把刚恢复的服务端再打挂一次。
   * 加随机量把重连时刻打散。
   */
  nextDelayMs(): number {
    const base = Math.min(1000 * 2 ** this.attempt, 30_000)   // 上限 30s
    this.attempt++
    return base / 2 + Math.random() * (base / 2)              // 落在 [base/2, base)
  }

  reset() { this.attempt = 0 }
}

class MarketConnection {
  private onClose(code: number) {
    this.state = 'closing'

    // ★ 关键：重连后不能只重连 —— 订单簿必须重新对齐
    //   原因：断线期间的增量永久丢失了，本地订单簿已经不可信
    this.orderBooks.forEach((book) => book.invalidate())   // 标记失效
    this.snapshotOnReconnect = true                        // 连接建立后重新拉快照

    if (code === 4001) return this.onAuthFailed()          // 鉴权失败 → 不重连，去刷新 token
    if (code === 1000) return                             // 正常关闭（用户主动）→ 不重连

    const delay = this.policy.nextDelayMs()
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private async onOpen() {
    this.policy.reset()
    this.state = 'open'
    await this.replaySubscriptions()      // 重连后要重新订阅（服务端的订阅状态不会保留）
    if (this.snapshotOnReconnect) {
      // ★ 顺序很重要：先订阅再拉快照，且把「拉快照期间的增量」缓冲住
      for (const book of this.orderBooks.values()) book.markBuffering()
      const snaps = await Promise.all([...this.orderBooks.keys()].map(fetchDepthSnapshot))
      snaps.forEach((s) => this.orderBooks.get(s.symbol)!.applySnapshot(s))
      this.snapshotOnReconnect = false
    }
  }
}
```

#### ④ 心跳保活

```ts
/**
 * 为什么要客户端主动发心跳（ping）：很多中间设备（NAT、负载均衡、移动网络）
 * 会静默掐掉「一段时间没有数据流动」的连接。这种断开不报错、不触发 onclose，
 * 表现为「以为连着，其实一条数据都收不到」—— 比直接断线更难排查。
 *
 * 所以心跳要双向确认：发 ping，约定时间内没收到 pong → 主动判定连接已死并重连。
 */
startHeartbeat() {
  this.heartbeatTimer = setInterval(() => {
    if (this.waitingPong) {
      // ★ 上一轮 pong 都没回来 → 判定连接已死
      //   注意这里是「两次都没回」才判定，避免网络抖动导致误判
      this.missedPongs++
      if (this.missedPongs >= 2) { this.forceReconnect(); return }
    }
    this.rawSend({ method: 'PING' })
    this.waitingPong = true
    this.pongDeadline = Date.now() + 5_000
  }, 15_000)
}
```

### 3.3 逐段讲解

**① 「合并订阅」到底省了什么**

| 方案 | 握手次数 | 连接数 | 心跳开销 |
|---|---|---|---|
| 每频道一条连接（20 个频道） | 20 次 TLS 握手 | 20 条 | 20 套心跳 |
| 合并订阅（1 条连接） | 1 次 | 1 条 | 1 套 |

在移动网络下这个差距会被放大：每次 TLS 握手要走一次完整的往返（RTT），20 次握手在 4G 下可能就是 2 秒的首屏延迟。

**② 「丢弃过期增量」和「断层重拉」是两件事，别混**

| 情况 | 判断条件 | 处理 |
|---|---|---|
| 增量是旧的 | `finalUpdateId <= lastUpdateId` | **静默丢弃**（正常现象，快照与推送有重叠期） |
| 增量之间有断层 | `firstUpdateId > lastUpdateId + 1` | **必须重拉快照**（数据已经不可信） |

第一类是常态：交易所生成快照和开始推增量之间有重叠窗口，收到几条旧增量是正常的设计结果。第二类是异常：说明丢包或服务端跳号，本地订单簿已经错了。

**③ 为什么价格要用字符串做 Map 的 key**

价格是 `65000.12` 这样的定点数。如果 `Number` 之后再 `toString()` 做 key，会出现 `0.1 + 0.2 = 0.30000000000000004` 这类精度问题 —— 同一个价位被当成两个不同的 key，订单簿里就会出现重复档位。**交易所返回的价格本来就是字符串，全程不要转成 number。**

数量为 `'0'` 表示删档，也必须用字符串比较（`qty === '0'`），不能用 `Number(qty) === 0`（某些实现会返回 `'0.00000000'`）。

**④ 重连后为什么要重拉快照（这是简历里那句「避免长时间运行后订单簿累积错位」的落点）**

断线的那段时间，增量永久丢失。如果重连后继续在旧的本地订单簿上 merge 新增量，本地状态和服务端就永远对不上了 —— 而且**这种错位是静默的**：界面照常显示、数字照常跳动，只是显示的深度是错的。对交易应用来说这是最危险的一类 bug。

**⑤ 题外话：为什么判断 ① 用 `<=` 而不是 `<`**

`finalUpdateId === lastUpdateId` 说明这条增量**恰好**是已包含在快照里的最后一条，也应该丢弃。用 `<` 会把它又 merge 一次。

### 3.4 面试会追问什么

**Q：快照和增量的边界怎么保证不重不漏？**
A：靠序号。规则是「丢弃 `finalUpdateId <= snapshot.lastUpdateId` 的增量」＋「要求 `firstUpdateId <= lastUpdateId + 1 <= finalUpdateId`」。而且**先订阅、后拉快照** —— 反过来的话，订阅生效前产生的增量会永久丢失。

**Q：如果拉快照失败怎么办？**
A：重试拉快照（指数退避），期间增量一直缓冲（有上限，防止内存爆）。快照拉成功之前**不显示盘口**，而不是显示一个可能错的旧盘口 —— 交易类应用里「显示错的数字」比「暂时不显示」严重得多。

**Q：为什么不直接用服务端推的全量快照？**
A：带宽和延迟。1000 档深度全量推一次可能几十 KB，高频推送下带宽成本极高（对交易所来说这是真金白银）。

---

## §4 高频刷新：合帧与精度分组

### 简历原文

> **高频刷新做合帧与分组**：深度与成交推送按 `requestAnimationFrame` 合帧、并以固定时间窗节流，
> 避免每帧都触发渲染；价格按**精度分组合并**后再生成节点，显著减少 DOM 数量；
> 页面切到后台时降低订阅频率、回到前台再补齐，兼顾实时性与耗电。

### 4.1 这句话在说什么

数据来的速度和屏幕刷新的速度**不匹配**：

```
交易所推送：depth@100ms（每秒 10 次）、trade（每秒可能几十次）
屏幕刷新：  60Hz → 每 16.7ms 一次，也就是每秒最多 60 次

如果「来一条数据就 setState 一次」：
  - 同一帧内来了 5 条 → 触发 5 次渲染，但用户只看到最后一次
  - 渲染本身耗时（Vue 的 diff + DOM 更新）→ 渲染在排队 → 界面开始掉帧
  - 数据来的比 60 次/秒还快时 → 渲染队列永远追不上 → 界面冻结
```

**合帧（coalescing）**的意思是：**一帧只渲染一次**，把这一帧内到达的所有数据合并后统一处理。

### 4.2 伪代码

#### ① rAF 合帧 + 时间窗节流

```ts
// core/market/throttle.ts
/**
 * ★ 合帧调度器：一帧内到达的所有更新，只触发一次下游渲染
 *
 * 两个机制叠加的原因：
 * - rAF 负责「对齐屏幕刷新」（不浪费帧）
 * - 时间窗负责「限上限」（即使屏幕是 144Hz，也不需要刷新 144 次）
 */
export function createFrameScheduler<T>(
  flush: (batched: T[]) => void,
  minIntervalMs = 100,          // ★ 高频盘口用 100ms：每秒最多 10 次渲染
) {
  let queue: T[] = []
  let rafId: number | null = null
  let lastFlush = 0

  const run = () => {
    rafId = null
    const now = performance.now()
    const elapsed = now - lastFlush

    if (elapsed < minIntervalMs && queue.length < 64) {
      // ★ 距上次渲染太近 → 推迟到「时间窗结束的那一帧」，而不是直接丢掉
      //   （丢掉会导致数据永久丢失；推迟只是延后显示）
      schedule()
      return
    }

    const batch = queue; queue = []
    lastFlush = now
    flush(batch)
  }

  const schedule = () => { if (rafId === null) rafId = requestAnimationFrame(run) }

  return {
    push(item: T) {
      queue.push(item)
      // ★ 队列积压过多时不再等待时间窗，立即安排（防止长时间不渲染导致数据越积越多）
      if (queue.length >= 64) { if (rafId !== null) cancelAnimationFrame(rafId); rafId = null }
      schedule()
    },
    dispose() { if (rafId !== null) cancelAnimationFrame(rafId); queue = [] },
  }
}
```

```ts
// 用法：行情 store 里接上游推送
const depthScheduler = createFrameScheduler<DepthDiff>((batch) => {
  // batch 里的多条增量，在这里一次性 merge 进订单簿
  orderBook.applyBatch(batch)
  depthBuffer.value = orderBook.topN(20)      // 只把前 20 档交给视图
}, 100)
```

```ts
// OrderBook 的批量版本：把 N 条增量合成一次 merge
applyBatch(diffs: DepthDiff[]) {
  // ★ 先过滤掉「一定不需要的」（早于当前版本的整条丢弃），剩下的按序合并
  const valid = diffs.filter((d) => d.finalUpdateId > this.lastUpdateId)
  if (!valid.length) return

  for (const d of valid) {
    if (d.firstUpdateId > this.lastUpdateId + 1) { this.onGapDetected(); return }
    this.merge(d.bids, this.bids)
    this.merge(d.asks, this.asks)
    this.lastUpdateId = d.finalUpdateId
  }
  this.emitChange()                          // ★ 整批只 emit 一次
}
```

```ts
/**
 * ★ 成交（trade）用的是「时间窗内的聚合」而不是逐条渲染：
 *   高频交易对一秒几十笔成交，逐条渲染毫无意义（人眼读不过来），
 *   而且会把成交列表刷得像老虎机。
 *
 *   做法：把窗口内的成交按「价格 + 方向」聚合，同一个价位的多笔合并成一笔
 *   （数量累加、时间取最后），这样一屏能看到「这一秒在哪些价位成交了多少」。
 */
function aggregateTrades(window: Trade[]): AggregatedTrade[] {
  const map = new Map<string, AggregatedTrade>()
  for (const t of window) {
    const key = `${t.price}|${t.side}`
    const prev = map.get(key)
    if (prev) {
      prev.qty = addDecimal(prev.qty, t.qty)     // ★ 用十进制字符串加法，不用浮点
      prev.time = t.time
      prev.count++
    } else {
      map.set(key, { ...t, count: 1 })
    }
  }
  return [...map.values()].sort((a, b) => b.time - a.time)
}
```

#### ② 精度分组：把 1000 档压成 20 档

```ts
/**
 * ★ 这是「DOM 数量」与「用户可读性」的双赢优化。
 *
 * 背景：BTC/USDT 的原始盘口精度是 0.01，也就是价格 65000.01 / 65000.02 …
 *   相邻档位差 1 分钱，用户根本看不出区别，但会生成上百个 DOM 节点。
 *
 * 交易所通常提供多档精度（0.01 / 0.1 / 1 / 10 / 100），可以：
 *   ① 直接订阅聚合精度（如 depth@100ms 附带精度参数）——首选，服务端算好
 *   ② 本地聚合 —— 服务端只提供细精度时自己合并
 */
function groupByTick(
  levels: [string, string][],
  tickSize: string,          // '0.1' 表示按 0.1 合并
): [string, string][] {
  const tick = toDecimal(tickSize)
  const grouped = new Map<string, string>()

  for (const [price, qty] of levels) {
    // ★ 向下取整到 tick 的整数倍（买盘向下、卖盘向上，保证不跨越真实价格）
    const bucket = toDecimal(price).div(tick).floor().times(tick).toFixed(decimalsOf(tickSize))
    grouped.set(bucket, addDecimal(grouped.get(bucket) ?? '0', qty))
  }

  return [...grouped.entries()]
    .filter(([, q]) => q !== '0')
    .sort((a, b) => compareDecimal(a[0], b[0]))
}
```

```vue
<!-- pages/market/DepthPanel.vue -->
<script setup lang="ts">
import { computed } from 'vue'
import { useMarketStore } from '@/stores/market'

const market = useMarketStore()

// ★ 视图只吃「已经聚合好、且只有前 N 档」的数据
//   注意：不要在模板里做 .map().filter() —— 每次重渲染都会重算一遍
const asks = computed(() => market.depthAsks)   // store 里已经算好，长度 ≤ 20
const bids = computed(() => market.depthBids)

/**
 * ★ 另一个关键优化：累计量（depth 的第三列）不应该在模板里算
 *   第 N 档的累计量 = 前 N 档之和，写在模板里就是 O(n²)（每行都从第 0 档累加）
 *   → 必须在 store 里一次算好，视图直接取
 */
</script>
```

**渲染节点的数量对比**：

| 做法 | 节点数（以 20 档 × 2 侧为例） | 说明 |
|---|---|---|
| 原始盘口，不做聚合 | 1000+ 档 → 2000+ 个单元格 | 每档一个 `<div>`，滚动都不顺 |
| 只取前 20 档 | 40 行 | 已经够用，但没有聚合时相邻价格太接近 |
| **前 20 档 + 精度聚合** | **40 行，但每行代表一个「有意义的价格区间」** | 用户看得懂，DOM 也不多 |

#### ③ 后台降频、前台补齐

```ts
// core/market/visibility.ts
import { App } from 'vue'

/**
 * ★ 页面切到后台时，用户看不见行情 —— 继续按 10Hz 渲染纯属浪费电。
 *   移动端尤其敏感（后台耗电会被系统统计，用户能感知到发热）。
 *
 * 但「降频」不等于「断连」：完全断开的话回到前台要重新对齐快照，
 * 代价比降频大得多。所以是「降低推送频率」而不是「停止接收」。
 */
export function setupVisibilityAwareness() {
  let hiddenSince = 0

  const onHide = () => {
    hiddenSince = Date.now()
    // ① 让服务端降低推送频率（多数交易所支持指定推送间隔：100ms / 1000ms）
    marketConnection.setStreamInterval('1000ms')
    // ② 本地也降低渲染频率：时间窗从 100ms 放大到 1000ms
    depthScheduler.setMinInterval(1000)
    tradeScheduler.setMinInterval(1000)
  }

  const onShow = () => {
    const hiddenMs = Date.now() - hiddenSince

    marketConnection.setStreamInterval('100ms')       // 恢复高频
    depthScheduler.setMinInterval(100)

    // ★ 回到前台要「补齐」：
    //   后台期间本地可能漏了数据（甚至整个断连重建），
    //   所以不能直接沿用旧状态，必须重新对齐一次
    if (hiddenMs > 10_000) {
      void resyncAllOrderBooks()                     // 重新拉快照
    }
    // 而且不管离开了多久，都要立刻拉一次最新数据，避免用户回来看到「停滞的旧盘口」
    void refreshVisibleTickers()
  }

  // H5：监听 visibilitychange（切 tab）
  // App：监听 uni 的 onHide / onShow，并且它会带上「后台时长」信息
  // #ifdef H5
  document.addEventListener('visibilitychange', () => document.hidden ? onHide() : onShow())
  // #endif
  // #ifdef APP-PLUS
  uni.$on('app:hide', onHide)
  uni.$on('app:show', onShow)
  // #endif
}
```

### 4.3 逐段讲解

**① 合帧为什么不能「来了就丢」**

新手常写出这种代码：

```ts
// ✗ 反面写法
let rafId = null
function onMessage(data) {
  latestData = data                       // 后来的覆盖先来的
  if (rafId) return
  rafId = requestAnimationFrame(() => { render(latestData); rafId = null })
}
```

问题在于 **`latestData` 只保留了最后一条**。订单簿的增量是**有累计语义的**（每一条描述一次变化），丢掉中间任何一条，本地状态就永久错了。

正确做法是**累积到一个队列里，flush 时全部消费**（也就是上面 `queue.push(item)` 的写法）。这条区别很重要，面试也常问。

**② 时间窗 + rAF 为什么两个都要**

| 只用 rAF | 只用时间窗 |
|---|---|
| 144Hz 屏幕会渲染 144 次/秒，无意义 | 渲染时机与屏幕刷新不同步，可能在一帧中间触发 → 撕裂、白跑一次 |
| 高刷新设备上白耗性能 | 在 60Hz 上表现尚可，但不可控 |

两个叠加：**rAF 保证「在正确的时刻渲染」，时间窗保证「渲染次数有上限」**。

**③ 精度分组的取整方向**

这个细节容易被忽略：买盘价格应该**向下取整**（保守），卖盘**向上取整**。如果卖盘也向下取整，聚合后的价格可能**低于真实最低卖价** —— 用户会以为自己能在这个价格买到，实际买不到。虽然差一个 tick，但交易应用里这种错误是原则性问题。

**④ 后台降频的三个层次**

```
① 断连（最激进）    → 省电最多，但回前台要重连 + 重新对齐，体验差
② 降低推送频率      → 省电与体验的平衡点 ← 我采用这个
③ 只降低渲染频率    → 省的是渲染，网络流量照旧（不如 ② 彻底）
```

### 4.4 面试会追问什么

**Q：`requestAnimationFrame` 在后台 tab 里会怎样？**
A：会被浏览器暂停（不执行回调）。所以**不能依赖 rAF 做「数据消费」**，只能依赖它做「渲染时机」。我们的数据消费在消息回调里完成（merge 进订单簿），rAF 只负责触发视图更新 —— 这样后台期间数据不会丢。

**Q：为什么不用 `setInterval` 做节流？**
A：`setInterval` 与屏幕刷新不同步。在 60Hz 上 16.7ms 的间隔会在某些帧里执行两次、某些帧里一次都不执行，视觉上就是抖动。rAF 与刷新率对齐，不会有这个问题。

**Q：聚合会不会掩盖真实的盘口？**
A：会，所以聚合精度是**用户可切换**的，而且默认精度选「让相邻档位差异在视觉上可辨」的那一档。另外聚合只是在显示层，**下单时的价格校验仍然用原始精度**。

---

## §5 WebSocket 保活重连与 ECharts K 线

### 简历原文

> 基于 **WebSocket** 实现行情实时推送与增量更新，配合**心跳保活与指数退避重连**，
> 支撑 K 线、深度图等高频刷新场景；使用 **ECharts** 定制 K 线、折线、热力图 ——
> K 线只保留最近 N 根并做增量追加，控制单实例数据量与重绘开销。

### 5.1 这句话在说什么

两件独立的事被写在了一条里：

**① 连接的可靠性** —— 长连接一定会断（切基站、锁屏、代理超时、服务端发布）。问题不是「怎么不断」，而是「断了之后多久恢复、恢复时数据对不对」。

**② 图表的更新成本** —— K 线图很容易写成「每来一条数据就 `setOption` 整个 option」，然后随着运行时间变长越来越卡，最后整个页面僵住。

### 5.2 伪代码

#### ① 连接状态机

```ts
// core/ws/lifecycle.ts
/**
 * ★ 为什么要有显式状态机
 *
 * 没有状态机时，这些条件会互相打架：
 *   - 用户主动登出时正在重连 → 重连成功后又被登出逻辑关掉
 *   - 重连定时器还没触发，用户手动点了「重试」→ 两条连接同时建立
 *   - 页面销毁了但定时器还在 → 回调里访问已卸载的组件
 *
 * 状态机把这些「谁该干什么」写死，就不需要到处 if。
 */
type ConnState =
  | 'idle'          // 从未连接
  | 'connecting'    // 正在建立
  | 'open'          // 已连接，正常收发
  | 'reconnecting'  // 断线，等待重连（定时器已挂）
  | 'closed'        // 主动关闭，不再重连

class MarketConnection {
  private state: ConnState = 'idle'
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private disposed = false

  async connect(): Promise<void> {
    if (this.disposed) return                       // ★ 组件已销毁：任何路径都不再建连
    if (this.state === 'connecting' || this.state === 'open') return   // ★ 防重复连接

    this.state = 'connecting'
    this.clearTimers()

    try {
      await this.openSocket()                        // 建立 + 握手鉴权
      this.state = 'open'
      this.policy.reset()
      await this.afterOpen()                         // 重放订阅 + 必要的数据对齐
      this.startHeartbeat()
    } catch (err) {
      this.scheduleReconnect()
    }
  }

  /** ★ 唯一的关闭入口：所有「不想再连了」的场景都走它 */
  close(reason: 'user' | 'logout' | 'auth-failed') {
    this.state = 'closed'
    this.clearTimers()
    this.ws?.close()
    if (reason === 'logout') this.handlers.clear()   // 登出时把回调也清掉，防止泄漏
  }

  dispose() {
    this.disposed = true
    this.close('user')
  }

  private scheduleReconnect() {
    if (this.state === 'closed' || this.disposed) return
    this.state = 'reconnecting'
    const delay = this.policy.nextDelayMs()          // 指数退避 + 抖动（见 §3.2 ③）
    console.warn(`[ws] ${delay}ms 后重连（第 ${this.policy.attempt} 次）`)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
  }

  private clearTimers() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }
}
```

#### ② 心跳与「假连接」检测

```ts
/**
 * ★ 最难排查的故障不是「断了」，而是「看起来连着但收不到数据」。
 *
 * 成因：中间的 NAT / 负载均衡 / 移动网络网关会静默回收「空闲」的长连接。
 *      这种回收通常不回 FIN/RST，所以客户端的 onclose 不会被触发。
 * 表现：连接状态是 open，发出去的订阅也有响应（其实进了黑洞），但一条行情都不到。
 *
 * 解法：心跳必须「双向确认」—— 发了 ping 要等 pong，等不到就判定连接已死。
 */
private startHeartbeat() {
  const PING_INTERVAL = 15_000        // 15s：比多数网关的空闲阈值（30~60s）短一半
  const PONG_TIMEOUT = 5_000
  let pending = 0

  this.heartbeatTimer = setInterval(() => {
    if (pending >= 2) {
      // ★ 连续两轮没收到 pong → 判定假连接，强制重建
      //   为什么是 2 而不是 1：单次超时可能只是网络抖动，重连一次的成本很高
      //   （要重新订阅 + 重新拉快照），不值得为一次抖动付这个代价
      console.warn('[ws] 心跳连续超时，判定连接已死，强制重连')
      this.ws?.close()
      this.scheduleReconnect()
      return
    }
    pending++
    this.rawSend({ method: 'PING', id: Date.now() })
    setTimeout(() => { /* 若在 PONG_TIMEOUT 内收到 pong，下面会 pending-- */ }, PONG_TIMEOUT)
  }, PING_INTERVAL)

  // pong 回执（在 dispatch 里）：
  //   if (msg.event === 'pong' || msg.id === lastPingId) { pending = 0 }
}

/** ★ 应用从后台回到前台时，不要等下一个心跳周期 —— 立刻探活 */
onAppForeground() {
  if (this.state !== 'open') return
  this.rawSend({ method: 'PING', id: Date.now() })
  // 拉一个轻量接口验证「通道真的通」，不通就重建
  void request.get('/ping', { timeout: 3000 }).catch(() => this.scheduleReconnect())
}
```

#### ③ K 线：只保留最近 N 根 + 增量追加

```ts
// core/market/kline.ts
const MAX_BARS = 500        // ★ 只保留最近 500 根

/**
 * 为什么是 500：
 * - 用户实际最多看 200~300 根（再缩就看不清了）；
 * - 500 给了左侧拖动 100+ 根的余量；
 * - 每根 K 线是一个对象 {t,o,h,l,c,v}，500 根的数组很轻（几百 KB 以内）；
 * - 真正的成本不在数据量，而在「每次都把整个数组交给图表重算」，所以见下面的更新策略。
 */
class KlineSeries {
  private bars: KlineBar[] = []
  private interval: Interval = '1m'

  /**
   * ★ 历史加载：只取一次，之后全部靠推送增量维护
   *   反面做法：每次用户拖动图表都重新请求整段历史 → 拖动卡顿 + 无谓的流量
   */
  async init(symbol: string, interval: Interval) {
    const history = await request.get('/market/klines', {
      params: { symbol, interval, limit: MAX_BARS },
    })
    this.bars = history
    this.emit('reset', this.bars)
  }

  /**
   * ★ 实时更新：只动「最后一根」或「追加一根」，永不重建数组
   *
   * K 线的语义决定了更新方式：
   *   - 当前这根还没收盘（未走完 interval）→ 每次 tick 都要更新它的 high/low/close
   *   - 时间跨过 interval 边界 → 收盘，追加一根新的
   */
  onTick(tick: { price: string; qty: string; time: number }) {
    const bucketStart = floorToInterval(tick.time, this.interval)
    const last = this.bars[this.bars.length - 1]

    if (!last || last.t < bucketStart) {
      // ① 跨过周期 → 追加新的一根（用 tick 价格初始化）
      const bar: KlineBar = {
        t: bucketStart,
        o: tick.price, h: tick.price, l: tick.price, c: tick.price,
        v: tick.qty,
      }
      this.bars.push(bar)
      // ★ 超过上限就从头截掉 —— 不截的话跑一天内存就爆了
      if (this.bars.length > MAX_BARS) this.bars.shift()
      this.emit('append', bar)
      return
    }

    // ② 仍是当前周期 → 就地更新最后一根
    last.c = tick.price
    if (compareDecimal(tick.price, last.h) > 0) last.h = tick.price
    if (compareDecimal(tick.price, last.l) < 0) last.l = tick.price
    last.v = addDecimal(last.v, tick.qty)
    this.emit('updateLast', last)
  }
}
```

```ts
// core/chart/klineChart.ts
let chart: echarts.ECharts | null = null

export function initKlineChart(el: HTMLElement) {
  chart = echarts.init(el, undefined, { renderer: 'canvas' })
  chart.setOption({
    // ★ 四条高频更新必须注意的配置
    animation: false,                     // ① 关动画：高频更新下动画会把帧率吃光
    // ② 数据量上限交给「本地数组截断」保证，图表侧再设一层保险
    // ③ dataZoom 限定可视窗口，减少实际绘制的点数
    dataZoom: [
      { type: 'inside', start: 60, end: 100, minValueSpan: 30 },   // 默认只看最近 40%
      { type: 'slider', start: 60, end: 100 },
    ],
    // ④ 网格线精简，减少 canvas 绘制指令
    xAxis: { axisLine: { show: false }, splitLine: { show: false } },
    yAxis: { scale: true, splitLine: { show: true, lineStyle: { color: '#1e2430' } } },
    series: [{ type: 'candlestick', data: [], itemStyle: { /* 涨红跌绿（国内习惯） */ } }],
  })
}

/**
 * ★ 增量更新：只把「变化的那部分」交给图表
 *
 * ECharts 的 setOption 默认是 merge 语义（不是替换），所以：
 *   - 传一个新数组进去，它会与旧数据做 diff 后重绘 → 成本可控
 *   - 千万不要传 notMerge=true（第二个参数 true），那会整个重建实例的配置
 *   - 第三个参数 lazyUpdate=true：把这次更新排到下一帧，避免同一帧内多次 setOption
 */
export const klineChart = {
  appendBar(bar: KlineBar) {
    // 追加场景：新数据在末尾，图表会自动滚动
    chart?.setOption({ series: [{ data: toEchartsData(currentBars()) }] }, false, true)
  },
  updateLastBar(bar: KlineBar) {
    // ★ 更新最后一根的场景：只替换数组的最后一项
    //   虽然仍要传整个 data，但 diff 后只有最后一个数据点变了 → 重绘面积很小
    const data = currentBars().slice()
    data[data.length - 1] = bar
    chart?.setOption({ series: [{ data: toEchartsData(data) }] }, false, true)
  },
  resize() { chart?.resize() },
  dispose() { chart?.dispose(); chart = null },     // ★ 页面卸载必须 dispose，否则 canvas 泄漏
}

/**
 * ★ 最后一道保险：即使上游推送异常频繁，图表也最多 10 次/秒更新
 *   与 §4 的合帧调度器复用同一套机制
 */
const chartScheduler = createFrameScheduler<KlineUpdate>((batch) => {
  const last = batch[batch.length - 1]
  last.kind === 'append' ? klineChart.appendBar(last.bar) : klineChart.updateLastBar(last.bar)
}, 100)
```

#### ④ 三张图的不同策略

| 图表 | 数据特征 | 更新策略 | 要关掉的东西 |
|---|---|---|---|
| **K 线** | 一根一根来 | 追加 / 更新最后一根，本地截断到 500 根 | 动画、markLine 动画 |
| **深度图（折线/面积）** | 每秒多次全量变化 | 与订单簿同步，合帧后整体替换 | 动画、不必要的 tooltip 重算 |
| **热力图** | 周期性批量更新 | 生成时用 `progressive`（渐进渲染）分片绘制，避免长任务阻塞主线程 | 动画 |

**多实例的统一管理**：一个交易页上可能同时有 3~5 个图表。要点是

```ts
// ★ 统一用一个 ResizeObserver 监听容器，而不是每个图表各自监听 window.resize
//   （window.resize 在移动端横竖屏切换、软键盘弹出时不会触发）
const ro = new ResizeObserver(entries => {
  for (const e of entries) charts.get(e.target)?.resize()
})
charts.forEach((_, el) => ro.observe(el))

// 页面卸载时统一 dispose（漏一个就泄漏一个 canvas 与一个 ECharts 实例）
onUnmounted(() => { ro.disconnect(); charts.forEach(c => c.dispose()); charts.clear() })
```

### 5.3 逐段讲解

**① 为什么 K 线更新「永不重建数组」**

```ts
// ✗ 反面写法：每次 tick 都重建
this.bars = [...this.bars, bar]          // O(n) 复制
chart.setOption({ series: [{ data: toEchartsData(this.bars) }] })   // 又一次 O(n) 转换
```

500 根下这个成本不算大，但如果同时开着 4 个图表、每秒 10 次更新，就是每秒 2 万次数组元素操作 + 4 次全量 diff。**累加起来就是持续占用主线程**，表现为「切换 tab 时卡一下」「输入框打字有延迟」。

**② K 线的时区陷阱**

```ts
const bucketStart = floorToInterval(tick.time, this.interval)
```

**这个 `floorToInterval` 必须用交易所的时区**，而不是用户本地时区。否则用户在 UTC+8 看到的 1 分钟 K 线边界会和服务端的对齐不上 —— 表现为「K 线的开盘价和实际不符」。这也是为什么 `t` 要存**服务端给的桶起点**，而不是「收到数据时的本地时间」。

**③ 为什么 `animation: false` 是必须的**

ECharts 的动画默认开启，每次数据变化都会有一个 300~1000ms 的过渡。行情高频更新下：

- 上一次动画还没播完，新数据就来了 → 动画被打断重排 → 视觉上是「抽搐」
- 每个动画帧都要重绘整个 canvas → 主线程被占满

**高频场景下动画是纯粹的负收益。** 反过来，如果要做「价格跳变闪烁」这种效果，应该用 CSS 对单独的元素做，而不是让整个图表动。

**④ 图表实例的三种泄漏**

| 泄漏 | 后果 | 正确做法 |
|---|---|---|
| 没 `dispose()` | canvas 与 ECharts 实例常驻内存 | `onUnmounted` 统一 dispose |
| 没 `disconnect()` ResizeObserver | 观察器持有着已卸载的 DOM 引用 | 同上 |
| 没清掉 `setInterval` 的数据轮询 | 已卸载页面还在发请求 | 用 `onUnmounted` 或 `AbortController` |

### 5.4 面试会追问什么

**Q：「假连接」你是怎么发现和处理的？**
A：靠双向心跳。发 ping 后等 pong，连续两轮收不到就判定连接已死、强制重建。另外 App 从后台回前台时不等心跳周期，立刻探活一次。**这个问题的价值在于它体现「你知道长连接会遇到什么」** —— 只答「有心跳」是不够的。

**Q：重连成功后数据怎么保证正确？**
A：分两类。**订单簿**必须重新拉快照（断线期间的增量永久丢失）；**K 线**要重新拉一次历史最后 N 根（因为断线期间可能已经收盘了几根）。**Ticker/成交**这类无状态数据直接覆盖即可。

**Q：为什么不自己实现 WebSocket 的粘包处理？**
A：WebSocket 是**基于消息**的协议（帧边界由协议层保证），不像 TCP 那样是字节流。所以收到一次 `onmessage` 就是一条完整消息，不存在粘包问题 —— 但如果协议本身是「一条长连接里塞多行 JSON」，就需要自己按换行切分。

**Q：指数退避的上限是多少，为什么？**
A：30 秒。理由：再长的话，服务端恢复后用户要等太久；再短的话，服务端长时间不可用时会持续产生无效请求。上限之上再加 0~50% 的随机抖动，避免所有客户端同时重连。

---

## §6 国际化与主题切换

### 简历原文

> 落地**国际化方案**：语言包按需动态加载 + 页面无刷新切换，多语种即时生效且首屏不加载全量语言包；
> 同时解决 App 端 **Pinia 持久化序列化失败**问题（还原后数据类型丢失引发运行时报错），并实现整站主题切换。

### 6.1 这句话在说什么

**① 国际化**的关键不是「能切换语言」，而是**首屏只加载当前语言**。反面做法是把 10 种语言的 JSON 全部 import 进来打包 —— 每种 30KB，就是 300KB 白流量，而且改一个字要重新发版。

**② Pinia 持久化的那个坑**是这个项目里最「实战」的一条，值得单独讲：它是**只有真机跑过才会发现的问题**。

**③ 主题切换**在交易应用里不是装饰：很多交易员要求暗色（长时间盯盘），而暗色下红绿涨跌色的对比度需要重新调。

### 6.2 伪代码

#### ① 语言包按需加载

```ts
// core/i18n/index.ts
/**
 * ★ 核心：语言包用动态 import，让构建工具把它切成独立的 chunk。
 *
 * 关键点：动态 import 的路径必须是「静态可分析」的，也就是不能用纯变量拼接，
 * 否则打包器无法确定要切出哪些 chunk，会退化成「全部打进主包」。
 * Vite / Rollup 需要能看出文件列表 —— 所以用显式的映射表。
 */
const loaders: Record<Locale, () => Promise<{ default: Record<string, string> }>> = {
  'zh-CN': () => import('./locales/zh-CN.json'),
  'en-US': () => import('./locales/en-US.json'),
  'ja-JP': () => import('./locales/ja-JP.json'),
  'ko-KR': () => import('./locales/ko-KR.json'),
  // …按需增加，每加一个语言 = 加一个 chunk，主包体积不变
}

export const i18n = createI18n({
  locale: detectLocale(),            // 首屏只用这一个
  fallbackLocale: 'en-US',
  messages: {},                      // ★ 初始为空 —— 首屏不带任何语言包
})

/** 首屏只加载当前语言（约 30KB），其余语言在用户切换时才拉 */
export async function setupI18n() {
  const locale = detectLocale()
  await loadLocale(locale)
  i18n.global.locale.value = locale
}

let loaded = new Set<Locale>()

export async function loadLocale(locale: Locale) {
  if (loaded.has(locale)) return
  const mod = await loaders[locale]()                       // ← 网络请求，只在首次
  i18n.global.setLocaleMessage(locale, mod.default)
  loaded.add(locale)
}

/**
 * ★ 无刷新切换
 *   切换语言时只改「响应式变量」，视图自动重渲染 —— 不需要 window.location.reload()
 *
 *   注意两个连带动作：
 *   ① 组件库的语言包（Element Plus 的 locale）也要跟着切，否则日期选择器还是旧语言
 *   ② 服务端返回的文案（错误消息）不会自动翻译 —— 要么约定用错误码，要么重新拉一次
 */
export async function switchLocale(locale: Locale) {
  await loadLocale(locale)                     // 首次切换这个语言时才下载
  i18n.global.locale.value = locale
  elConfig.value.locale = elLocales[locale]    // ① 同步组件库
  storage.set('LOCALE', locale)
  // ② 通知需要重取数据的模块（如「公告」这类服务端返回的自然语言内容）
  eventBus.emit('locale-changed', locale)
}
```

```ts
// 首屏检测顺序：用户手动选过 > 系统语言 > 默认
function detectLocale(): Locale {
  const saved = storage.get('LOCALE')
  if (saved && saved in loaders) return saved as Locale

  // #ifdef H5
  const nav = navigator.language                       // 'zh-CN' / 'en-US'
  // #endif
  // #ifdef APP-PLUS
  const nav = uni.getSystemInfoSync().language         // App 端拿系统语言
  // #endif

  const hit = Object.keys(loaders).find((l) => nav?.toLowerCase().startsWith(l.slice(0, 2)))
  return (hit as Locale) ?? 'zh-CN'
}
```

#### ② App 端 Pinia 持久化的序列化坑

这是那条「还原后数据类型丢失引发运行时报错」的具体形态。

```ts
// ✗ 反面写法：直接用 uni 的同步存储做持久化
const useUserStore = defineStore('user', {
  state: () => ({ profile: null as Profile | null, lastLoginAt: null as Date | null }),
  persist: {
    storage: {
      getItem: (key) => uni.getStorageSync(key),
      setItem: (key, value) => uni.setStorageSync(key, value),
    },
  },
})
```

**问题出在两次序列化的语义不一致**：

```
写入路径：
  内存里的对象（含 Date / Map / undefined）
    ↓ uni.setStorageSync  ← 底层走原生存储，对象会被「平台自己的方式」序列化
  存储里的一段数据

读取路径：
  存储里的数据
    ↓ uni.getStorageSync    ← 返回的类型由原生层决定
  可能是 object，也可能是 string；Date 变成字符串、undefined 被丢掉、
  数字变成字符串、布尔变成 '0'/'1'（视平台实现）
    ↓
  直接塞回 state → 类型对不上
```

**表现**就是：`lastLoginAt.getTime()` 报 `getTime is not a function`；`profile.balance` 本来是数字，变成 `'1234.5'` 后参与运算出现字符串拼接（`'1234.5' + 1 = '1234.51'`）。**这类错误在浏览器上永远复现不了**（H5 用 localStorage 走的是 JSON，行为一致）。

```ts
// ✓ 正确写法：自己控制序列化，只存原始类型
const STORAGE_KEY = 'user-store'
const SCHEMA_VERSION = 2          // ★ 加版本号，为将来的字段变更留迁移空间

interface PersistedV1 { profile: Profile; lastLoginAt: string | null }
interface PersistedV2 { profile: Profile; lastLoginAt: string | null; schema: 2 }

const persistUserStore = {
  save(state: UserState) {
    const payload: PersistedV2 = {
      schema: SCHEMA_VERSION,
      profile: state.profile,
      // ★ 手动把 Date 转成 ISO 字符串 —— 只存「可 JSON 往返」的类型
      lastLoginAt: state.lastLoginAt ? state.lastLoginAt.toISOString() : null,
    }
    storage.set(STORAGE_KEY, JSON.stringify(payload))   // ★ 自己 JSON.stringify，不依赖平台
  },

  load(): Partial<UserState> {
    const raw = storage.get(STORAGE_KEY)
    if (!raw) return {}
    let data: any
    try {
      data = JSON.parse(raw)                            // ★ 能 parse 成功才继续
    } catch {
      storage.remove(STORAGE_KEY)                       // 损坏的数据直接丢掉，别让页面崩
      return {}
    }

    // ★ 迁移：老版本数据按规则升级，而不是「读不出来就全丢」
    if (data.schema === 1) data = migrateV1toV2(data)
    if (data.schema !== SCHEMA_VERSION) return {}        // 未来版本不认识 → 忽略

    return {
      profile: isProfile(data.profile) ? data.profile : null,   // ★ 形状校验后再用
      // ★ 还原时把 string 转回 Date，并校验是否合法
      lastLoginAt: toValidDate(data.lastLoginAt),
    }
  },
}

function toValidDate(v: unknown): Date | null {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d        // ★ 非法日期返回 null，不返回 Invalid Date
}
```

#### ③ 主题切换

```ts
// core/theme/index.ts
type Theme = 'dark' | 'light'

/**
 * ★ 用 CSS 变量 + 一个根节点属性，而不是「两套样式文件」
 *
 * 好处：
 * ① 切换成本 = 改一个属性，浏览器只需要重算受影响的样式，不重新加载 CSS
 * ② 交易页里 K 线图 / 深度图的颜色也从同一组变量读，主题切换时图表一起变
 */
export function applyTheme(theme: Theme) {
  // #ifdef H5
  document.documentElement.setAttribute('data-theme', theme)
  // #endif
  // #ifdef APP-PLUS
  // App 端在 uni-app 里通常作用在最外层容器上；同时要通知原生层（状态栏文字色）
  uni.$emit('theme-changed', theme)
  // #endif

  // ★ 组件库（Element Plus）用 class 形式的暗色，单独同步
  elConfig.value.theme = theme

  // ★ 图表不能只靠 CSS —— ECharts 的主题色写在配置里，需要主动更新
  chartRegistry.forEach((chart) => chart.setOption(chartThemeOption(theme)))
}
```

```css
/* 一组变量管两套主题 —— 图表颜色也从这里取，保证「图与 UI 同色」 */
:root {
  --bg-base: #ffffff;
  --text-primary: #111827;
  --up: #e5342b;            /* 涨：红（国内习惯） */
  --down: #1aa96b;          /* 跌：绿（国内习惯） */
  --depth-bid: rgba(229, 52, 43, .18);
  --depth-ask: rgba(26, 169, 107, .18);
}
[data-theme='dark'] {
  --bg-base: #0b0e13;
  --text-primary: #e8eaed;
  /* ★ 暗色下不能直接沿用亮色的红绿：饱和的红在暗背景上会「发光」，
     需要降饱和、提亮度，否则看久了眼睛疼 */
  --up: #ff5c52;
  --down: #35c488;
  --depth-bid: rgba(255, 92, 82, .22);
  --depth-ask: rgba(53, 196, 136, .22);
}
```

### 6.3 逐段讲解

**① 「首屏不加载全量语言包」省了多少**

| 方案 | 首屏语言相关体积 | 加一种语言的成本 |
|---|---|---|
| 全量 import | 4 种 × 30KB = **120KB**（gzip 后约 35KB） | 主包 +30KB，需重新发版 |
| **按需动态加载** | **30KB**（gzip 后约 10KB） | 多一个 chunk，主包不变 |

看起来 25KB 不多，但它属于**首屏关键路径**上的资源（要在首屏渲染前就位），而且语言包通常是 JSON —— gzip 效果好但解析成本不低（大 JSON 的 `JSON.parse` 会占主线程）。

**② 动态 import 的路径必须是静态可分析的**

```ts
// ✗ 打包器无法分析 → 可能把整个目录打进来，或运行时 404
const mod = await import(`./locales/${locale}.json`)

// ✓ 显式映射表 —— 打包器能看到全部 4 个候选，各自切成 chunk
const loaders = { 'zh-CN': () => import('./locales/zh-CN.json'), ... }
```

这个坑很隐蔽：写 `import(\`./locales/${x}.json\`)` 时，Vite 会**把整个 locales 目录都打包**（因为无法确定用到哪些），体积反而更大。

**③ Pinia 持久化那条：为什么「只在 App 端」出错**

| 端 | 存储实现 | 行为 |
|---|---|---|
| H5 | `localStorage` | 自己就是字符串，JSON 往返一致 |
| App | `uni.setStorageSync` → 原生层 | 原生层对 JS 对象有自己的处理（有时是字符串化，有时是平台序列化），**类型语义与 JSON 不完全一致** |

所以这条经验的价值在于：**它教你不要依赖平台存储做序列化**。正确的心智模型是「存储只认字符串，序列化由我自己负责」——这样三端行为一致。

另外一个相关坑：**`uni.setStorageSync` 存不了 `undefined`**。`{ a: undefined }` 存进去再取出来，`a` 这个 key 可能直接消失。所以宁可存 `null`。

**④ 主题与图表的一致性**

K 线图的涨跌色如果写在 ECharts 配置里（硬编码 `#e5342b`），主题切换时图表不会变 —— 页面变成「暗色背景 + 亮色图表」的割裂状态。所以：

```
CSS 变量（唯一真源）
   ├── 普通 DOM 读它（通过 var(--up)）
   └── ECharts 也从它读（getComputedStyle 读出来再塞进 option）
```

用 `getComputedStyle(document.documentElement).getPropertyValue('--up')` 把变量读出来传给图表，保证两边永远一致。

### 6.4 面试会追问什么

**Q：用户切换语言时，正在进行的请求返回的错误文案怎么办？**
A：服务端返回的自然是「当时那个语言」的文案，切换后不会自动变。两种处理：① 服务端只返回错误码，前端映射文案（推荐，但要约定码表）；② 切换语言时重新拉一次当前页数据。我当时用的是混合：**校验类错误用码表，业务提示用服务端文案**。

**Q：语言包缺 key 怎么办？**
A：`fallbackLocale` 会兜底到英文；开发环境加一个检测（对比各语言包的 key 集合，缺失就 warn），避免「上线了才发现某个 key 是空白」。

**Q：Pinia 持久化的数据版本升级怎么做？**
A：存 `schema` 版本号，加载时判断：等于当前版本直接用、小于当前版本走迁移函数、大于当前版本（用户降级了）忽略并清理。**关键是「迁移」而不是「读不出就清空」** —— 后者会让用户丢掉设置。

---

## §7 系统性性能优化

### 简历原文

> 系统性**性能优化**：字体子集化、图片压缩、长列表虚拟滚动、路由懒加载、依赖 CDN 外链与分包；
> 按路由与依赖拆包使首屏只加载必要资源，明显降低首屏与长列表渲染开销。

### 7.1 逐项的伪代码与参数

#### ① 字体子集化

```bash
# 中文字体是首屏最大的单文件。一个完整中文字体（如思源黑体）：
#   常规字重 8~10MB，压缩后仍有 3~5MB
# 而交易界面用到的汉字通常只有几百个 → 子集化后 20~80KB

# 方式 A：按「字符集」裁剪（把项目里出现的所有汉字收集起来）
#   优点：体积最小
#   缺点：动态内容（用户名、公告）会缺字
pyftsubset SourceHanSans-Regular.otf \
  --text-file=used-chars.txt \
  --output-file=font-subset.woff2 \
  --flavor=woff2 \
  --layout-features='*'          # 保留连字等特性，否则某些符号会错

# 方式 B：按 unicode 区间切片（推荐用于有动态文本的场景）
#   把字体切成多个文件，用 @font-face 的 unicode-range 按需加载
```

```css
/* ★ 分片方案：浏览器只下载「页面上真正用到的字符所在的分片」 */
@font-face {
  font-family: 'OLCT Sans';
  src: url('/fonts/subset-latin.woff2') format('woff2');
  unicode-range: U+0000-00FF;                 /* 拉丁字母 + 数字 */
  font-display: swap;                          /* ① 字体没到先用系统字体渲染，不白屏 */
}
@font-face {
  font-family: 'OLCT Sans';
  src: url('/fonts/subset-cjk-common.woff2') format('woff2');
  unicode-range: U+4E00-9FFF;                  /* 常用汉字 */
  font-display: swap;
}

/* ② 数字要用等宽（tabular-nums），否则价格跳动时整行宽度会变 */
.price { font-variant-numeric: tabular-nums; }
```

**关键决策**：数字部分**必须用系统字体或单独的子集**，并且开启 `tabular-nums`。否则「65000.12」变成「64999.87」时，数字 `1` 和 `8` 的宽度不同，整行会左右抖动 —— 在行情列表里非常显眼。

#### ② 图片压缩

```ts
// 图片统一走 CDN 处理参数，而不是上传多份尺寸
const avatarUrl = (key: string, size: number) =>
  `${CDN_BASE}/${key}?x-oss-process=image/resize,w_${size}/quality,q_80/format,webp`

// 用法：同一个原图，按用途取不同尺寸
avatarUrl(user.avatar, 40)     // 列表里的小头像 → 40px
avatarUrl(user.avatar, 160)    // 详情页 → 160px

/**
 * ★ 三个要点
 * ① format,webp —— webp 比同质量 jpg 小 25~35%
 * ② 按显示尺寸取图，不要「取原图 + CSS 缩小」
 *    （原图 2MB 缩到 40px 显示，流量白花 2MB，而且解码要占内存）
 * ③ 用 srcset 让不同 DPR 的屏幕各取所需
 */
```

```html
<img
  :src="avatarUrl(user.avatar, 80)"
  :srcset="`${avatarUrl(user.avatar, 80)} 1x, ${avatarUrl(user.avatar, 160)} 2x`"
  width="40" height="40"
  loading="lazy"
  decoding="async"
/>
```

#### ③ 长列表虚拟滚动

```ts
/**
 * ★ 定行高虚拟滚动（交易列表的行高本来就是固定的，所以不需要动态测量）
 *
 * 参数取值（在 60Hz 手机上实测）：
 *   ROW_HEIGHT = 32px   —— 交易列表一行的高度
 *   OVERSCAN   = 8      —— 上下各多渲染 8 行
 *     为什么是 8：快速滑动时一帧可能滚过 200px（≈6 行），
 *     缓冲不够就会露出空白。8 行 = 256px，覆盖住一帧的最大位移。
 */
const ROW_HEIGHT = 32
const OVERSCAN = 8

const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(total.value, Math.ceil((scrollTop.value + viewportH.value) / ROW_HEIGHT) + OVERSCAN)
  return { start, end }
})
```

| 列表 | 数据量 | 优化手段 |
|---|---|---|
| 逐笔成交 | 无上限（持续累积） | 虚拟滚动 + **本地截断到最近 200 条** |
| 订单历史 | 分页加载，几百条 | 虚拟滚动 + 上拉加载 |
| 交易对列表 | 几百到上千 | 虚拟滚动 + 搜索过滤 |

> **最容易踩的坑**：`ROW_HEIGHT` 必须等于**真实渲染高度**（含 padding、border）。差 1px，滑到第 500 行时累计误差就是 500px —— 表现为「点击某一行，选中的是另一行」。所以要么写死行高，要么用 `getBoundingClientRect` 实测后校准。

#### ④ 路由懒加载与分包

```ts
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        /**
         * ★ 分包策略：按「变更频率」拆，而不是按「体积」拆
         *
         * 原则：把「很少变」的依赖单独成 chunk → 它们的缓存永远命中，
         *       发版后用户只需要重新下载「变了的业务代码」。
         */
        manualChunks: {
          // ① 框架层：几乎不变，长期缓存
          'vendor-vue': ['vue', 'vue-router', 'pinia'],
          // ② 图表：体积大（ECharts 完整版 1MB+）但很少升级 → 单独拆，且按需引入
          'vendor-chart': ['echarts'],
          // ③ 组件库
          'vendor-ui': ['element-plus'],
          // ④ 业务：按页面切（配合路由懒加载自动生成）
          //    'page-market': [...] ← 不手写，交给动态 import 自动切
        },
      },
    },
  },
})
```

```jsonc
// UniApp 的分包（pages.json）—— App / 小程序侧的另一套机制
{
  "pages": [
    { "path": "pages/market/index", "style": { "navigationBarTitleText": "行情" } },
    { "path": "pages/trade/index",  "style": { "navigationBarTitleText": "交易" } }
  ],
  "subPackages": [
    {
      "root": "packageAssets",
      "pages": [
        { "path": "deposit/index" },
        { "path": "withdraw/index" },
        { "path": "history/index" }
      ]
    }
  ],
  // ★ 预下载规则：在合适的时机提前把分包拉下来，用户点进去时无感
  "preloadRule": {
    "pages/market/index": { "network": "all", "packages": ["packageAssets"] }
  }
}
```

**分包的划分依据**：把「首屏必需」放主包，把「进得去但不常去」的页面（充值/提现/历史/设置）放分包。

#### ⑤ CDN 外链

```ts
// vite.config.ts
import cdnImport from 'vite-plugin-cdn-import'

cdnImport({
  modules: [
    { name: 'vue',        var: 'Vue',        path: 'https://cdn/vue@3.global.prod.js' },
    { name: 'echarts',    var: 'echarts',    path: 'https://cdn/echarts@5.min.js' },
  ],
})
```

**什么时候该外链，什么时候不该**：

| 依赖 | 外链？ | 理由 |
|---|---|---|
| Vue / ECharts 这类 UMD 形态、全局变量的库 | ✅ 适合 | 有现成的 UMD 产物，直接在 HTML 里 `<script>` 引入即可 |
| 依赖 ESM 且与其他包有引用关系的库 | ❌ 不适合 | 外链后其他包仍在打包时会再打一份，**体积反而变大** |
| 内网/离线可用的 App | ❌ 不适合 | CDN 不通时白屏 |

**App 端尤其要注意**：App 资源是打包进安装包的，外链 CDN 意味着「首次启动必须联网」——这是不可接受的。所以 **CDN 外链只用在 Web / H5，App 端走本地打包**（又是一处按端差异，收在构建配置里）。

### 7.2 效果怎么量化

简历里写「明显降低」是保守说法，实际应该能给出数字。常用的测量方式：

```ts
// 用 PerformanceObserver 测真实的首屏指标
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    if (e.name === 'first-contentful-paint') report('FCP', e.startTime)
  }
}).observe({ entryTypes: ['paint'] })

// 长任务：定位「哪段代码阻塞了主线程」
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) {
    // > 50ms 就是长任务，用户能感知到卡顿
    report('longtask', { duration: e.duration, attribution: e.attribution })
  }
}).observe({ entryTypes: ['longtask'] })
```

| 指标 | 优化前（估） | 优化后（估） | 主要贡献 |
|---|---|---|---|
| 首屏 JS 体积 | ~1.8MB（ECharts 全量 + 全语言包 + 组件库全量） | ~500KB | 分包 + 按需引入 + 语言包按需 + CDN 外链 |
| 首屏字体 | 3.5MB（完整中文字体） | ~60KB | 字体子集化 |
| 行情列表滚动 | 一屏 500 行 → 每帧渲染 500 节点 | 一屏 ~25 行 | 虚拟滚动 |
| K 线更新 | 每次全量 setOption + 动画 | 只更新末根 + 动画关闭 | 图表策略 |

> ⚠️ **表里的数字是「量级」而不是精确测量值**。如果你要写进简历或面试讲，**要么给出真实测量数据，要么只讲「做法与原理」，不要报具体数字** —— 被追问「怎么测的」会很难答。

---

## §8 把上面都拼起来

```
┌──────────────────────── 用户看到的 ────────────────────────┐
│  行情页：K 线图 · 深度图 · 逐笔成交 · 交易对列表（虚拟滚动）   │
│  交易页：下单面板 · 当前委托 · 历史成交                      │
│  资产页：余额 · 划转 · 充提（分包）                          │
└───────────────────────────┬────────────────────────────────┘
                            │ 读 store，只做展示
┌───────────────────────────▼────────────────────────────────┐
│  Pinia stores（三端共用）                                    │
│    marketStore   ← §3 §4 §5 的全部数据都在这里，且已「算好」  │
│    tradeStore    ← 下单（不自动重试，§2）                     │
│    userStore     ← 持久化自己控制序列化（§6）                  │
└───────────────────────────┬────────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────────┐
│  core/（三端共用，零 ifdef）                                 │
│                                                             │
│  request/   拦截 → token 注入 → 缓存 → 401 刷新队列 → 重试     │
│  ws/        状态机 · 心跳 · 退避重连 · 合并订阅 · 频道分发      │
│  market/    订单簿（快照+增量对齐）· K 线（截断+增量）          │
│             合帧调度器（rAF + 时间窗）· 精度分组                │
│  i18n/      语言包按需加载 · 无刷新切换 · 主题                  │
└───────────────────────────┬────────────────────────────────┘
                            │ 只依赖接口
┌───────────────────────────▼────────────────────────────────┐
│  adapters/（按端各一份，接口一致）                            │
│    storage: H5=localStorage / App=uni.setStorageSync          │
│    ws:      H5=原生 WebSocket / App=uni.connectSocket         │
│    chart:   H5=canvas / App=原生层容器                        │
└─────────────────────────────────────────────────────────────┘
```

**一次真实的数据流（以「BTC/USDT 深度变化」为例）**：

```
① 交易所推送一条 diff depth（带 U/u 序号）
      ↓
② ws/dispatch 按 stream 名路由到 btcusdt@depth 的 handler
      ↓
③ OrderBook.applyDiff 判断：过期？断层？正常？
      ↓ 正常
④ 合帧调度器 push（不立即渲染）——同一帧内的多条增量会攒在一起
      ↓ rAF + 100ms 时间窗触发
⑤ applyBatch：批量 merge → lastUpdateId 前移
      ↓
⑥ 只取「前 20 档 + 精度聚合」→ 写入 marketStore
      ↓
⑦ Vue 的响应式触发 DepthPanel 重渲染（20 行 DOM）
```

整条链路上，**数据一次都没被重复传输、一次都没被重复渲染**，且每一步都可单独测试（因为都是纯函数或纯逻辑类）。

---

## §9 面试追问清单

按「被问到的概率」排序。每题都给了**答题骨架**，标 ⚠️ 的是**有风险、要小心不要吹**的。

### 高频（几乎必问）

1. **双 Token 刷新的并发问题怎么解决？**
   → 布尔 + 队列。第一个 401 负责刷新、其余入队重放。刷新接口自身要 bypass，否则递归。
2. **订单簿为什么要快照 + 增量两段式？**
   → 增量有累积语义，起点不对就永久错位。靠序号对齐：丢弃过期增量、断层重拉快照。
3. **断线重连后数据怎么保证正确？**
   → 订单簿重拉快照、K 线重拉尾部、Ticker 直接覆盖。**不能沿用断线前的本地状态。**
4. **WebSocket 的心跳是干什么的？**
   → 对抗「假连接」（NAT/网关静默回收）。要双向确认（ping-pong），连续两轮无响应才判死。
5. **高频数据怎么做渲染节流？**
   → rAF 合帧（对齐刷新）+ 时间窗（限次数）。**关键是「攒队列」而不是「只留最后一条」**。
6. **为什么写操作不能自动重试？** ⚠️
   → 超时 ≠ 失败，重试可能重复下单。要靠客户端订单号去服务端查真实状态。

### 中频

7. **多端复用的边界怎么划？**
   → 能力差异（存储/WS/图表）抽接口放 adapters；结构差异（布局/交互）各写一套。core 里零条件编译。
8. **条件编译和运行时判断的区别？**
   → 编译期删代码（包体更小、不引入不存在的符号）vs 运行期判断（代码仍在包里）。
9. **虚拟滚动的行高为什么必须精确？**
   → 估算误差会累计，滑到后面点击错位。定行高或实测校准。
10. **K 线为什么要本地截断？**
    → 数据量无限增长会让每次 setOption 越来越慢，最终卡死。保留最近 N 根。
11. **ECharts 高频更新要注意什么？**
    → 关动画、懒更新（第三参数）、只更新变化的 series、页面卸载必须 dispose。
12. **Pinia 持久化在 App 端踩了什么坑？** ⚠️
    → 平台存储的类型语义与 JSON 不一致（Date 变字符串、undefined 丢失）。解法是自己控制序列化 + 版本号 + 形状校验。
13. **语言包为什么要动态加载？**
    → 首屏关键路径上的体积。4 种语言全量 import 是白流量。注意动态 import 路径必须静态可分析。

### 低频但能加分

14. **指数退避为什么要加抖动？**
    → 服务端恢复时避免所有客户端同时重连（重连风暴）。
15. **精度分组时买盘和卖盘的取整方向为什么不同？**
    → 买盘向下、卖盘向上，保证聚合后的价格不会跨越真实可成交价。
16. **为什么价格要用字符串而不是 number？**
    → 浮点误差会让同一价位产生两个不同的 key，订单簿出现重复档位。
17. **「假连接」和「真断线」的表现有什么区别？**
    → 假连接：状态是 open、onclose 不触发、但收不到数据。真断线：onclose 触发、状态可感知。
18. **背景标签页里 rAF 会怎样？**
    → 被暂停。所以数据消费不能依赖 rAF，只能让它负责渲染时机。
19. **CDN 外链什么时候不该用？**
    → 依赖 ESM 且会被重复打包的库；App 端（要离线可用）。
20. **首屏优化你怎么量化效果？** ⚠️
    → `PerformanceObserver` 测 FCP 与 longtask。**如果没真测过，就只讲做法不讲数字。**

### 三条「不要吹」的红线

| ⚠️ | 说明 |
|---|---|
| **令牌吊销** | 无状态 JWT 无法主动吊销（除非引入 `tokenVersion` 或黑名单）。如果没做，别暗示做了。 |
| **具体性能数字** | 除非当场能说清测量方法与基线，否则只讲量级与手段。 |
| **QPS / 并发用户数** | 前端岗位被问这个通常是陷阱（那不是前端的指标）。老实说「前端侧我能观测到的是首屏指标与长任务时长」。 |

---

## 附：这份文档与简历的关系

- 简历里的每一条都是**结论**（做了什么、达到什么效果）；
- 这份文档是**结论背后的实现**（怎么做的、为什么这么做、坑在哪）；
- 面试时正确的讲法是「结论 → 一句原理 → 一个具体的坑」，**不要一上来就报参数**。例如：

> 「行情推送这块我做的是合并订阅 + 增量对齐。简单说就是所有频道走一条连接，然后订单簿用快照加增量的方式维护。这块最关键的是序号对齐 —— 增量带的序号如果早于快照版本就得丢掉，不然会重复 merge，跑一段时间盘口就全错了。」

这段话里有：结论、原理、具体机制、以及**一个真实的坑** —— 比背参数有效得多。
