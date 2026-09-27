# Homo 短视频 · 伪代码实现详解

> **这份文档是什么**：不是项目源码，而是把简历里 Homo 那 7 条技术描述，逐条展开成
> **可落地的伪代码 + 逐段讲解**，目标是让你能讲清「我写的这句话具体怎么实现的」。
>
> **项目定位（重要）**：**App 端单端交付**。所有代码与取舍都围绕 App 端展开，
> 不涉及 H5 / 小程序的适配分支。
>
> **伪代码约定**：语法贴近 `Vue 3 组合式 API + TypeScript + UniApp + Pinia + uView Pro + UnoCSS`，
> 关键处给**真实工程参数**并注明「为什么是这个值」。
>
> **配套文档**：`wisora-代码逐文件详解.md`（真实代码逐文件注释）、
> `olct-伪代码实现详解.md`（另一个项目的伪代码详解）。

---

## 0. 项目与技术栈

| 项 | 内容 |
|---|---|
| 项目 | Homo 短视频 —— 类抖音的短视频应用（推荐流 / 互动 / 个人主页） |
| 时间 | 2025.05 – 2025.09 |
| 技术栈 | UniApp · Vue 3 · TypeScript · uView Pro · UnoCSS · Vite |
| 交付形态 | **App 端单端**（不做 H5 / 小程序 —— 下文所有取舍都基于这个前提） |

### 0.1 这份文档覆盖的 7 条

| # | 简历里的说法 | 章节 | 核心难点 |
|---|---|---|---|
| 1 | 竖向整屏切换 + 三屏窗口 | §1 | 渲染量与列表长度解耦 |
| 2 | 单实例复用替代原生播放器池 | §2 | ⭐ uni-app 的硬约束 |
| 3 | 快速连滑的落点保护 + 静默预下载 + 状态机 | §3 | 用时间换内存 |
| 4 | 手势与互动（双击点赞 / 长按倍速 / 乐观更新） | §4 | 手势判定与失败回滚 |
| 5 | 曝光与观看时长埋点 | §5 | 指标必须在客户端算准 |
| 6 | 分页、缓存与工程化 | §6 | 游标分页、LRU、按需引入 |
| 7 | App 端适配与稳定性 | §7 | 安全区域、音频焦点、热更新 |

### 0.2 先建立心智图

短视频应用看着简单，其实只有三个真正的技术问题：

```
① 视频播放器的生命周期管理   —— 什么时候创建、什么时候销毁
   （这是 §2 §3 的全部内容，也是 App 端最难的约束）

② 一屏一个内容的滑动容器     —— 怎么做到「整屏切换」而不失控
   （§1 的全部内容：控制「同时存在多少个可播放单元」）

③ 交互与数据的正确性         —— 点赞不能丢、时长要算准、分页不能重
   （§4 §5 §6 的内容）
```

**三者是互相制约的**：想让滑动更跟手就要多预载几个播放器（② 让步给 ①），
想让内存可控就要少建播放器（① 让步给 ②）。第 3 条第 2、3 项就是讲这个折中怎么做。

### 0.3 一句话说清「为什么这个项目 App 端难」

```
Web 原生的 <video>：想建几个就建几个，浏览器自己管内存和 GPU。
App 端的 video：   经过 uni-app 封装后落到原生播放器层，
                  同一时刻只有一个有效实例、且层级独立于 WebView。
```

**这条约束决定了这个项目所有播放器相关的设计。** 后面 §2 会详细展开。

---

## §1 竖向整屏切换 + 三屏窗口

### 简历原文

> 推荐流采用**竖向整屏切换 + 三屏窗口**：只保留「上一 / 当前 / 下一」三屏，切换后按新索引替换数据。
> 竖向容器是**声明式全量挂载**的，直接铺满信息流会让内存与首屏时间随分页线性增长；
> 手动开窗后，渲染量与列表长度**解耦**，长列表下帧率保持稳定。

### 1.1 这句话在说什么

**「声明式全量挂载」指什么**：UniApp 的 `<swiper>` 是声明式的 —— 你给它多少 `<swiper-item>`，它就全部创建出来。

```vue
<!-- ✗ 天真写法：列表有多少条就挂多少个 swiper-item -->
<swiper vertical :current="index" @change="onChange">
  <swiper-item v-for="item in items" :key="item.id">
    <VideoCard :item="item" />
  </swiper-item>
</swiper>
```

**为什么这是灾难**：

| 项 | 100 条数据时 |
|---|---|
| 组件实例数 | 100 个 `VideoCard`（每个内含封面图、播放器容器、按钮组） |
| 首屏时间 | 与条数**线性相关** —— 用户等的是「100 个组件建完」，而不是「第一条能播」 |
| 内存 | 100 个封面图 + 100 个播放器容器 |
| 滑动帧率 | 每次滑动都要在 100 个节点的结构里做布局计算 |

而且每翻一页（+20 条）就再加重一份 —— **这就是「随分页线性增长」的意思**。

**「手动开窗」指什么**：自己控制「当前渲染哪三条」。

### 1.2 伪代码

```vue
<!-- pages/recommend/index.vue -->
<template>
  <!--
    ★ vertical + 整屏高度：这是「整屏切换」的基础
      swiper 的默认行为就是「按容器尺寸翻页」，所以容器必须是整屏高
  -->
  <swiper
    class="h-screen-full"
    vertical
    :current="relativeIndex"
    :duration="200"
    @change="onSwiperChange"
    @animationfinish="onAnimationFinish"
  >
    <!--
      ★ 三屏窗口：只渲染 windowStart ~ windowStart+2
        无论上游有 20 条还是 2000 条，这里永远是 3 个
    -->
    <swiper-item v-for="(item, i) in windowItems" :key="item.id">
      <VideoSlide
        :item="item"
        :active="isActive(i)"
        @like="onLike(item, $event)"
        @watch-report="onWatchReport"
      />
    </swiper-item>
  </swiper>
</template>

<script setup lang="ts">
import { computed, ref, nextTick } from 'vue'
import { useFeedStore } from '@/stores/feed'

const feed = useFeedStore()

const WINDOW_SIZE = 3

/**
 * ★ 全局索引（数据数组里的位置）—— 这是「唯一真源」
 *   它每次变化都会带动窗口滑动
 */
const currentIndex = ref(0)

/**
 * ★ 窗口起点
 *   规则：尽量让当前项处在窗口中间
 *   - 索引 0 → 窗口 [0,1,2]
 *   - 索引 5 → 窗口 [4,5,6]
 *   - 末尾    → 窗口 [n-3, n-2, n-1]（不能越过数组尾部）
 */
const windowStart = computed(() =>
  Math.min(
    Math.max(0, currentIndex.value - 1),
    Math.max(0, feed.items.length - WINDOW_SIZE),
  ),
)

const windowItems = computed(() =>
  feed.items.slice(windowStart.value, windowStart.value + WINDOW_SIZE),
)

/**
 * ★ 关键映射：swiper 只认「窗口内索引」（0/1/2），业务只认「全局索引」
 *   这两个索引的转换是这套方案里最容易出错的地方
 */
const relativeIndex = computed(() => currentIndex.value - windowStart.value)

const isActive = (i: number) => windowStart.value + i === currentIndex.value

/**
 * ★ 用户滑动结束 → 先更新全局索引，再决定要不要「移动窗口」
 *
 * 为什么不在 change 里就移动窗口：
 *   change 事件在滑动过程中会持续触发，此时改 windowStart 会让
 *   swiper-item 的 key 发生变化 → 正在滑的那个元素被销毁重建 → 视觉上是「闪一下」
 *
 * 所以窗口移动放在 animationfinish（动画结束、画面已稳定）之后。
 */
function onSwiperChange(e: { detail: { current: number } }) {
  currentIndex.value = windowStart.value + e.detail.current
  feed.markSeen(currentIndex.value)          // 交给 store 处理曝光与预取
}

async function onAnimationFinish() {
  await nextTick()
  // 窗口移动后 swiper 的 current 需要重设回「窗口内索引」
  // 因为 windowStart 变了，原来的相对位置也变了
  const target = currentIndex.value - windowStart.value
  if (target !== relativeIndex.value) {
    // 强制校正（这一步不会产生视觉跳变，因为画面已经到了正确位置）
    relativeIndex.value = currentIndex.value - windowStart.value
  }
}
</script>
```

```ts
// stores/feed.ts —— 数据侧配合窗口
export const useFeedStore = defineStore('feed', () => {
  const items = ref<FeedItem[]>([])
  const cursor = ref<string | null>(null)        // 游标分页（见 §6）
  const loading = ref(false)

  /**
   * ★ 预取：窗口往右移动时，检查是否需要加载下一页
   *   注意这里用的是「全局索引距末尾的距离」，不是窗口位置
   */
  function markSeen(index: number) {
    // 距末尾还有 3 条时预取下一页（见 §6.2 的参数说明）
    if (items.value.length - index <= 3) void loadMore()
  }

  async function loadMore() {
    if (loading.value || !cursor.value) return
    loading.value = true
    try {
      const page = await fetchFeed({ cursor: cursor.value, size: 20 })
      // ★ 按 id 去重：游标分页在数据实时变化的场景下仍可能返回重复项
      const seen = new Set(items.value.map((x) => x.id))
      items.value.push(...page.items.filter((x) => !seen.has(x.id)))
      cursor.value = page.nextCursor
    } finally {
      loading.value = false
    }
  }

  return { items, cursor, loading, markSeen, loadMore }
})
```

### 1.3 逐段讲解

**① 「渲染量与列表长度解耦」是这条改动的核心价值**

| | 全量挂载 | 三屏窗口 |
|---|---|---|
| 组件实例数 | = 列表长度（100、200、500…） | **恒为 3** |
| 首屏代价 | 与长度线性相关 | 常数 |
| 翻页代价 | 每次翻页 +20 个组件 | 0（窗口只是换了内容） |
| 滑动帧率 | 随长度劣化 | 稳定 |

**对短视频应用来说这不是优化，是能不能跑起来的分界线** —— 因为推荐流是无限流，理论上可以滑到 1000 条。

**② 索引映射：这套方案唯一的复杂度来源**

```
数据数组：  [0] [1] [2] [3] [4] [5] [6] [7] [8] ...
                                ↑ 当前在第 5 条
窗口：              [4] [5] [6]      ← windowStart = 4
窗口内索引：         0   1   2       ← swiper 只知道这个

用户往上滑到第 4 条：
  全局索引 5 → 4
  windowStart: 4 → 3        （窗口左移，保持当前项居中）
  新窗口：[3] [4] [5]
  窗口内索引：0 → 1
```

**必须同时维护两个索引，且记住「全局索引才是业务真源」。** 如果拿 swiper 的 `current` 当业务索引，翻页后就会错位。

**③ 为什么窗口移动要放在 `animationfinish`**

滑动过程中改 `windowStart` 会让 `v-for` 的 key 集合变化 → Vue 会销毁/重建 `swiper-item` → 正在播放的视频被销毁重建。表现是「滑到一半画面闪一下、声音断一下」。

放在动画结束后改，画面已经稳定，重建的代价用户感知不到。

**④ 一个替代方案（值得知道）**

也可以不用 `<swiper>`，自己用 `scroll-view` + `scroll-snap` 或纯 `transform` 实现整屏切换。好处是索引映射简单（内容位置完全由我们控制），代价是要自己处理惯性滚动、边缘回弹、手势冲突（和 §4 的「上拉分页」会有冲突）。**用 `<swiper>` 是省事且稳妥的选择**，索引映射的成本是可接受的。

### 1.4 面试会追问什么

**Q：为什么不直接给 `swiper` 加 `:lazy-render`？**
A：`lazy-render` 是延迟渲染**首次出现**的 item，一旦渲染过就不再销毁 —— 滑到第 100 条时仍然是 100 个实例。它解决的是「首屏」，不解决「长期占用」。

**Q：三屏够吗，为什么不是五屏？**
A：App 端的硬约束是「同一时刻只有一个有效播放器」（§2），所以多渲染出来的屏幕**只挂封面图、不建播放器**。多两屏的收益仅仅是「滑动时封面图已在内存里」——而封面图本来就该走图片缓存。三屏是在「够用」与「组件实例数」之间的选择。

**Q：窗口移动时视频会重新加载吗？**
A：如果窗口移动导致当前播放的那一条被销毁重建，会。所以窗口规则是「当前项始终在窗口中间」—— 移动窗口时当前项的位置不变（在全局数组里的引用也不变），配合 `:key="item.id"`，Vue 不会销毁它。

---

## §2 单实例复用（替代原生播放器池）

### 简历原文

> 以**单实例复用**替代业界常见的原生播放器池：原生方案会维护播放器池（预加载前后各 2 条、
> 实例上限约为「预加载数 × 2 + 3」，并额外留出快速滑动的余量），但
> **uni-app 的 video 在 App 端是原生播放器层，同一时刻只能有一个有效实例、且层级独立于 WebView**，
> 照搬不可行。改为**「当前页单实例 + 邻页只挂封面图」**：切换时先提交上一页的暂停并销毁播放上下文、
> 再创建新实例，既避免「切走了还在响」，也避免首帧黑屏。

### 2.1 先讲清「原生播放器池」是什么

这是原生开发（Android/iOS/Flutter/React Native）里短视频应用的**标准做法**，参考业界实现（如 Flutter 生态的 `compose-reels`）的参数：

```kotlin
// 业界原生方案的伪代码（Kotlin / Flutter 风格，仅用于对比）
class PlayerPool(
    private val preloadCount: Int = 2,          // 前后各预载 2 条
    private val cache: MediaCache = LruMediaCache(maxBytes = 150 * 1024 * 1024),   // 150MB 磁盘缓存
) {
    // 池子大小 = 预载数 × 2 + 3
    //   = 2 × 2 + 3 = 7 个 ExoPlayer 实例
    //   「+3」是留给「快速滑动」的余量：用户飞速划过 5 条时，
    //   被划过的播放器不立即销毁，而是留在池里等着可能「滑回来」
    private val pool = ArrayDeque<ExoPlayer>(capacity = preloadCount * 2 + 3)

    fun onPageChanged(index: Int) {
        // 前 2 条 + 后 2 条进入预加载（prepare，但不 play）
        (index - preloadCount..index + preloadCount).forEach { i ->
            if (i == index) return@forEach
            acquireFromPool().apply { setMediaItem(videos[i]); prepare() }
        }
        // 当前条播放
        play(index)
        // 池子里多出来的实例回收（但保留最近用过的，供回滑复用）
        trimPool()
    }
}
```

**这套方案的好处**：「滑回来」时能瞬间继续播（播放器还在，缓冲还在）。

**代价**：7 个播放器实例同时持有解码器。原生平台可以承受（硬件解码器通常支持 8~16 个并发实例），但——

### 2.2 uni-app 的硬约束（这条决定了方案必须换）

```ts
/**
 * ★ uni-app 的 <video> 在 App 端不是「Web 的 video 元素」
 *
 * 它是这样工作的：
 *   编译期：<video> 标签被编译成一个占位容器（WebView 里的一个 div）
 *   运行期：原生层在这个 div 的「位置上」创建一个原生播放器视图，
 *          并把这个原生视图「叠」在 WebView 之上
 *
 * 由此产生三条硬约束：
 *
 * ① 层级独立（层级问题）
 *    原生播放器视图在 WebView 的上层，不受 z-index 控制。
 *    → 任何需要盖在视频上的东西（弹幕、礼物动画、字幕）都不能用普通的
 *      DOM 覆盖，必须用 subNVue 或者干脆做成原生组件。
 *    → 而且一个视频上只能叠一个原生层的元素，两层原生视图会互相遮挡。
 *
 * ② 同一时刻只有一个有效实例
 *    这是最致命的约束。多个 video 同时存在时：
 *      - 后来的会覆盖前一个的视图位置（都渲染到同一个原生层）
 *      - 表现：滑到第二个视频，第一个视频的画面还留在屏幕上没消失
 *      - 更糟的是音频：两个都在播 → 两个声音叠在一起
 *    → 播放器池「同时持有 7 个实例」的前提根本不成立。
 *
 * ③ 生命周期不完全跟随组件
 *    DOM 里的 <video> 标签被移除后，原生播放器不一定会立即销毁，
 *    需要显式调用 context 的销毁方法，否则会出现「看不到画面但还在播音频」。
 */
```

| | 原生方案 | uni-app App 端 |
|---|---|---|
| 并发播放器实例 | 7 个（池化） | **1 个**（必须） |
| 「滑回来」体验 | 瞬间继续（缓冲还在） | 重新起播（需要靠预下载缓解，见 §3） |
| 层级 | 可控（原生开发的图层） | **独立层，不受 z-index 控制** |
| 视频上叠元素 | 自由 | 需 subNVue 或原生组件 |

### 2.3 伪代码：单实例 + 邻页只挂封面图

```vue
<!-- components/feed/VideoSlide.vue -->
<template>
  <div class="slide">
    <!--
      ★ 邻页（非当前页）只渲染封面图 —— 不创建 video 组件
        这样「三屏窗口」里的 3 个 slide 里，只有 1 个真的有播放器
    -->
    <image
      v-if="!active"
      class="cover"
      :src="item.cover"
      mode="aspectFill"
      lazy-load
    />

    <!--
      ★ 当前页才渲染 video
        :key 用 item.id —— 保证同一条视频在窗口移动时不重建
    -->
    <video
      v-else
      :id="videoId"
      :key="item.id"
      class="player"
      :src="item.playUrl"
      :poster="item.cover"
      :controls="false"
      :show-center-play-btn="false"
      :show-fullscreen-btn="false"
      :show-play-btn="false"
      :enable-progress-gesture="false"
      :loop="true"
      :autoplay="false"
      object-fit="cover"
      @play="onPlay"
      @pause="onPause"
      @error="onError"
      @waiting="onWaiting"
      @timeupdate="onTimeUpdate"
      @loadedmetadata="onLoadedMetadata"
    />

    <!-- 信息和互动区（普通 DOM，可以正常叠在封面图上） -->
    <FeedOverlay :item="item" @like="$emit('like')" />
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps<{ item: FeedItem; active: boolean }>()
const emit = defineEmits<{
  (e: 'like'): void
  (e: 'play-state', s: PlayerState): void
}>()

const videoId = `video-${props.item.id}`

/**
 * ★ 播放器的唯一句柄
 */
let ctx: UniApp.VideoContext | null = null
let destroyed = false

/** 播放状态机（见 §3.3 —— 状态必须是显式的，否则会出现「无声」「重复播放」） */
type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error'
const state = ref<PlayerState>('idle')

/**
 * ★ 创建播放上下文
 *   只有当前页才创建 —— 这是「单实例」的落点
 */
function createContext() {
  if (ctx || destroyed) return
  ctx = uni.createVideoContext(videoId)
  state.value = 'idle'
}

/**
 * ★ 销毁播放上下文
 *   必须在切换前显式调用，否则会出现「切走了还在响」
 */
function destroyContext() {
  if (!ctx) return
  ctx.stop()
  ctx = null
  state.value = 'idle'
}

/**
 * ★ 核心：active 变化 = 用户切页了
 *   顺序非常重要：先销毁旧的，再创建新的
 *   （反过来会让两个播放器短暂同时存在 → 双音）
 */
watch(
  () => props.active,
  async (active) => {
    if (active) {
      await nextTick()          // 等 video 元素挂载完成（v-if 切换后 DOM 才存在）
      createContext()
      playSafely()
    } else {
      destroyContext()
    }
  },
)

/**
 * ★ 安全播放：处理「创建后立即 play 会失败」的窗口
 *   刚创建 ctx 时，video 可能还没 ready，直接 play 会静默失败。
 *   uni-app 的 video 组件在 App 端有两个事件可以判断就绪：
 *     - loadedmetadata / onReady
 *   所以用一个「待播」标记，等就绪事件到了再真正播。
 */
const pendingPlay = ref(false)

function playSafely() {
  if (!ctx) return
  pendingPlay.value = true
  try {
    ctx.play()
  } catch {
    /* 静默：就绪事件到了会再试 */
  }
}

function onLoadedMetadata() {
  if (pendingPlay.value) {
    ctx?.play()
    pendingPlay.value = false
  }
}

/**
 * ★ 首帧黑屏的处理
 *   video 有 :poster，所以加载期间显示封面图；
 *   但 poster 的消失时机是「首帧可渲染」，这一瞬间如果封面图已经移除，
 *   会露出黑底。所以：不要手动隐藏封面图，交给 poster 自己交接。
 *   （这也是为什么邻页用 image 当封面，当前页用 poster —— 两者的衔接是连续的）
 */
function onPlay() {
  state.value = 'playing'
  emit('play-state', state.value)
}

function onWaiting() {
  state.value = 'loading'
  emit('play-state', state.value)
}

onBeforeUnmount(() => {
  destroyed = true
  destroyContext()          // ★ 组件卸载时兜底销毁（否则「页面已退出但还在播」）
})
</script>
```

```ts
/**
 * ★ 全局播放器注册表：确保「同一时刻只有一个在播」
 *
 * 为什么需要它：
 *   active 的切换是响应式的，但事件是异步的 ——
 *   极端情况下（快速连续滑动）可能出现「新页已 play、旧页的 destroy 还没执行完」。
 *   用一个全局注册表做强约束，是最后一道保险。
 */
class PlaybackRegistry {
  private current: string | null = null

  /** 声明某条视频要开始播：会先把上一条停掉 */
  acquire(itemId: string) {
    if (this.current === itemId) return true
    if (this.current) {
      const prev = uni.createVideoContext(this.current)
      prev.stop()                       // ★ 先停旧的
    }
    this.current = itemId
    return true
  }

  release(itemId: string) {
    if (this.current === itemId) this.current = null
  }

  /** 应用切后台 / 离开推荐流时，强制停播 */
  stopAll() {
    if (this.current) uni.createVideoContext(this.current).stop()
    this.current = null
  }
}

export const playback = new PlaybackRegistry()

// 页面离开时调用（onHide 里，见 §7）
onHide(() => playback.stopAll())
```

### 2.4 逐段讲解

**① 为什么「先销毁旧的、再创建新的」这个顺序不能反**

```ts
// ✗ 反了：创建新的时旧的还在播 → 两个音频叠加
createContext()      // 新实例起来，开始出声
destroyContext()     // 旧的才停 —— 中间有几百毫秒的双音

// ✓ 正确顺序
destroyContext()     // 旧的立即停
createContext()
```

**双音**在短视频应用里非常刺耳（听到两个不同的背景音乐），而且很难排查 —— 因为它只在快速滑动时出现。

**② 邻页为什么「只挂封面图」而不是「挂静音的 video」**

有人会想：邻页挂个 `muted` 的 video 预热，滑过去不就能秒播了吗？

不行，原因有两个：

1. **uni-app 的单实例约束**：邻页建 video 会抢占原生层，当前页的画面可能被覆盖。
2. **层级独立**：邻页的原生播放器视图不知道自己的容器只有一屏高，可能覆盖到当前页上。

所以邻页只能用「静态封面图 + 配合预下载」（§3）来缓解起播延迟。

**③ 为什么 `:key="item.id"` 而不是 `:key="i"`**

窗口移动时，索引 `i` 的含义会变（第 0 个元素从 A 变成 B），用 `i` 做 key 会让 Vue 复用 DOM 节点但内容全变 —— 对于 `<video>` 来说这是灾难：它会认为「还是那个 video」，于是不重建原生播放器，只是换了 src。表现是「滑过去有声音但画面是上一条」。

用 `item.id` 做 key，Vue 就知道这是不同的元素，会正确销毁和重建。

**④ 视频上叠元素的限制（这条要知道，面试可能问）**

因为原生播放器层在 WebView 之上，普通 DOM 盖不住它。所以：

| 需要叠在视频上的东西 | 可行做法 |
|---|---|
| 点赞动画、字幕、礼物特效 | 用 `subNVue`（App 端专属的原生子窗体） |
| 简单的文案信息（作者名、描述） | 放在视频**下方**的独立区域，不叠在视频上 |
| 进度条 | 不用叠 —— 用 `timeupdate` 自己画在底部安全区外 |

Homo 的设计选择了「信息与互动区不叠在视频画面上」——**这是被约束逼出来的设计，但结果反而更清爽**（不会遮挡画面）。

### 2.5 面试会追问什么

**Q：单实例的话，快速滑动会不会出现「滑过去了还没加载出来」？**
A：会，这是这套方案的固有代价。缓解手段有三个：① **静默预下载**（§3）把文件先落到本地，用本地路径起播，省掉网络等待；② 先显示封面图（起播前用户看到的是图，不是黑屏）；③ **落点保护**（§3）等滑动稳定再创建播放器，避免为「划过的」那条白建一次。

**Q：为什么不用 `nvue` 页面？**
A：`nvue` 用原生渲染（weex），确实能解决层级问题，但它没有 DOM、CSS 支持有限（flex 子集），整套 UI 都要重写，而且 uView Pro 在 nvue 下不可用。对一个「以信息流为主」的应用来说性价比太低。

**Q：如果产品要求「视频上显示弹幕」怎么办？**
A：必须用 `subNVue` 做原生子窗体，或者把弹幕区域做成视频外的独立区域。纯 DOM 方案做不到 —— 这也是 §2.2 里那条「层级独立」约束的直接后果。

---

## §3 快速连滑的落点保护 + 静默预下载 + 播放状态机

### 简历原文

> **快速连滑做落点保护**：相邻页只预取封面图，**等落点稳定后再延迟约 150ms 创建播放器** ——
> 原生方案靠多备播放器槽位吸收快速滑动的抖动，单实例约束下走不通，改用「用时间换内存」；
> 同时借助 App 端文件系统对下一条做**静默预下载**，以本地路径起播省掉缓冲等待；
> 再把播放状态收敛为显式状态机（idle / loading / playing / paused / error），
> 杜绝状态互相覆盖导致的无声、重复播放等疑难问题。

### 3.1 这句话在说什么

**「快速连滑的问题」**：用户从第 1 条快速划到第 8 条（一秒钟划 7 次）：

```
朴素实现：每划一次就「销毁旧播放器 + 创建新播放器」
  → 1 秒内创建并销毁 7 次播放器
  → 每次创建都要初始化解码器、建立网络连接
  → 结果：① 这 7 次全都是白费的（用户已经到第 8 条了）
          ② 主线程被 7 次创建/销毁占满 → 滑动本身变得卡顿
          ③ 真正的第 8 条反而更慢才能播出来
```

**「用时间换内存」**的意思是：既然不能靠「多备几个播放器实例」来吸收滑动抖动（uni-app 不允许），那就**改用时间维度** —— 等用户停下来（落点稳定）再创建。代价是「停下来之后要等 150ms 才开始加载」，换来的是「不为划过的条目浪费任何资源」。

### 3.2 伪代码

#### ① 落点稳定检测

```ts
// composables/useSettleWatcher.ts

/**
 * ★ 落点保护：连续快速滑动时，只在「停下来」之后才通知真正的创建动作
 *
 * 参数为什么是 150ms：
 *   - 人快速连滑的间隔通常在 80~120ms（一次滑动的动画时长约 200ms，
 *     但用户会在动画未结束时就开始下一次滑动）
 *   - 150ms 略大于「连滑间隔」，所以中途不会误判为「已停下」
 *   - 又足够短，正常单次滑动停下后 150ms 内就会开始加载，用户感知不到延迟
 *   - 实测调参区间：100ms（连滑时仍会误触发）~ 250ms（单次滑动后明显迟滞）
 */
export function useSettleWatcher(settleMs = 150) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastIndex = -1

  /**
   * 每次索引变化都调用它。
   * 只有「索引稳定了 settleMs」之后，才会执行 onSettle
   */
  function onIndexChange(index: number, onSettle: (stableIndex: number) => void) {
    lastIndex = index
    if (timer) clearTimeout(timer)

    timer = setTimeout(() => {
      timer = null
      // ★ 闭包里的 index 可能已经过时，用 lastIndex 确保是最后一次
      onSettle(lastIndex)
    }, settleMs)
  }

  function cancel() {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return { onIndexChange, cancel }
}
```

```ts
// 使用：把「创建播放器」这个昂贵动作挂在 settle 之后
const settle = useSettleWatcher(150)

watch(currentIndex, (index) => {
  // ① 立即做便宜的事：更新封面图、更新互动区的数据（这些本来就是响应式的）
  preloadCover(index)

  // ② 昂贵的事（创建播放器）推迟到落点稳定后
  settle.onIndexChange(index, (stableIndex) => {
    playback.acquire(feed.items[stableIndex].id)   // 全局注册表保证单实例
  })
})
```

#### ② 静默预下载（App 端专属能力）

```ts
// core/media/prefetch.ts

/**
 * ★ 这是 App 端才有的优化，也是「单实例方案」的补偿手段
 *
 * 思路：
 *   既然不能预先创建播放器，那就预先下载「文件」。
 *   视频起播慢的两个原因是「网络等待」和「解码器初始化」，
 *   预下载能消掉第一个（通常是大头）。
 *   起播时用本地路径，不需要等网络 → 首帧显著提前。
 *
 * 关键参数：
 *   PREFETCH_AHEAD = 1   —— 只预取「下一条」
 *     为什么只预取 1 条：预取 2 条以上的收益很小（用户很少连滑后立刻看第三条），
 *     但流量和磁盘占用翻倍。在移动网络下流量是用户的真实成本。
 *
 *   PREFETCH_MIN_NETWORK = 'wifi'  —— 默认只在 WiFi 下预下载
 *     蜂窝网络下预取视频 = 直接消耗用户流量，可能被投诉。
 *     可以给用户一个「非 WiFi 下也预加载」的开关。
 */
const PREFETCH_AHEAD = 1

export async function prefetchNext(currentIndex: number, items: FeedItem[]) {
  const next = items[currentIndex + 1]
  if (!next) return

  // ① 网络类型判断
  const net = await uni.getNetworkType()
  if (net.networkType !== 'wifi' && !userAllowsCellularPrefetch()) return

  // ② 已经在缓存里就不重复下载
  if (await cache.has(next.id)) return

  // ③ 下载到本地临时目录（App 端用 downloadFile）
  const task = uni.downloadFile({
    url: next.playUrl,
    // ★ 不指定 filePath 时，uni 会放到临时目录，系统可能随时清理；
    //   我们希望它被 LRU 缓存管理，所以放到自己管理的目录
    filePath: cache.pathFor(next.id),
    success: (res) => {
      if (res.statusCode === 200) cache.register(next.id, res.tempFilePath, res.fileSize)
    },
    fail: () => { /* 预下载失败无所谓，真正播放时会重新下载 */ },
  })

  // ★ 用户滑走了就取消 —— 否则会白下载（而且可能同时有好几个下载任务在跑）
  downloadRegistry.set(next.id, task)
}

/** 索引变化时：取消不再需要的预下载，启动新的 */
export function syncPrefetch(index: number, items: FeedItem[]) {
  // 取消所有「不在预取窗口内」的下载
  const wanted = new Set(
    Array.from({ length: PREFETCH_AHEAD }, (_, i) => items[index + 1 + i]?.id).filter(Boolean),
  )
  downloadRegistry.cancelExcept(wanted)

  void prefetchNext(index, items)
}
```

```ts
// core/media/cache.ts —— 预下载的落点：LRU 缓存

/**
 * ★ 为什么必须有 LRU 上限
 *   App 端预下载的文件不会自动清理，滑 100 条就是 100 个视频文件（可能几百 MB）。
 *   用户会在设置里看到「应用占用 800MB」然后卸载。
 */
const MAX_CACHE_BYTES = 150 * 1024 * 1024      // 150MB：约 20~40 条短视频
const MAX_ITEMS = 60                            // 双阈值：也限制条数（防止全是小文件时条数过多）

class MediaCache {
  private entries = new Map<string, { path: string; size: number; lastUsed: number }>()

  async has(id: string): Promise<boolean> {
    if (!this.entries.has(id)) return false
    // 文件可能被系统清理掉了（App 端临时目录不保证持久）
    const exists = await fileExists(this.entries.get(id)!.path)
    if (!exists) { this.entries.delete(id); return false }
    return true
  }

  /** 取本地路径：命中就更新使用时间（LRU 的「最近使用」） */
  pathOf(id: string): string | null {
    const e = this.entries.get(id)
    if (!e) return null
    e.lastUsed = Date.now()
    return e.path
  }

  /** 注册一个新缓存文件，并触发淘汰 */
  register(id: string, path: string, size: number) {
    this.entries.set(id, { path, size, lastUsed: Date.now() })
    this.evict()
  }

  /**
   * ★ 淘汰策略：按「最久未使用」删，直到两个阈值都满足
   *
   * 为什么同时限体积和条数：
   *   - 只有体积上限：如果都是小文件（10 秒的短视频只 1MB），
   *     150MB 就是 150 个文件，目录里文件太多会影响文件系统性能
   *   - 只有条数上限：如果都是长视频（20MB），60 条就是 1.2GB
   */
  private evict() {
    const totalBytes = () => [...this.entries.values()].reduce((s, e) => s + e.size, 0)

    while (totalBytes() > MAX_CACHE_BYTES || this.entries.size > MAX_ITEMS) {
      // 找最久未使用的
      let oldestId: string | null = null
      let oldestTime = Infinity
      for (const [id, e] of this.entries) {
        if (e.lastUsed < oldestTime) { oldestTime = e.lastUsed; oldestId = id }
      }
      if (!oldestId) break

      const e = this.entries.get(oldestId)!
      void removeFile(e.path)              // 删磁盘文件
      this.entries.delete(oldestId)
    }
  }

  /** 用户清缓存入口 */
  async clear() {
    await Promise.all([...this.entries.values()].map((e) => removeFile(e.path)))
    this.entries.clear()
  }
}

export const cache = new MediaCache()
```

```ts
// 播放时优先用本地文件
function resolvePlayUrl(item: FeedItem): string {
  // ★ 命中缓存就用本地路径 —— 起播不需要网络，首帧快很多
  const local = cache.pathOf(item.id)
  return local ?? item.playUrl
}
```

#### ③ 播放状态机

```ts
/**
 * ★ 为什么必须是显式状态机
 *
 * 视频播放涉及的异步事件特别多，用零散的布尔量（isPlaying / isLoading / isPaused）
 * 会出现「同时为真」的非法组合，表现成这些疑难问题：
 *
 *   - 无声：video 在播（appearPlaying=true）但音频通道被上一次的 stop 关掉了
 *   - 重复播放：两个 play() 调用交错，第一个的 promise 还没 resolve 第二个又发了
 *   - 画面卡住：state 是 playing，但实际停在 waiting
 *
 * 显式状态机把这些组合排除掉 —— 同一时刻只能处在一种状态。
 */
type PlayerState =
  | 'idle'      // 刚创建，还没加载
  | 'loading'   // 在缓冲（waiting）
  | 'playing'   // 正常播放中
  | 'paused'    // 暂停（用户单击，或系统打断）
  | 'error'     // 加载/解码失败

/**
 * ★ 状态迁移表 —— 只有表里列出的迁移是合法的，非法迁移一律忽略（并 warn）
 *
 * 这张表是「杜绝状态互相覆盖」的落点：
 * 比如「error → playing」不该发生（出错了怎么会自动在播），
 * 出现了说明是迟到的旧事件，必须丢弃。
 */
const TRANSITIONS: Record<PlayerState, PlayerState[]> = {
  idle:    ['loading', 'playing', 'error'],
  loading: ['playing', 'paused', 'error'],
  playing: ['paused', 'loading', 'error'],
  paused:  ['playing', 'loading', 'idle', 'error'],
  error:   ['idle'],                       // 只能重置，不能直接变成 playing
}

class PlayerMachine {
  private state: PlayerState = 'idle'
  /** ★ 代次：用于丢弃「上一轮播放」的迟到事件 */
  private generation = 0

  get current() { return this.state }

  /**
   * 每次「切换到新的一集」时调用，代次 +1
   * 之后收到的事件如果带的是旧代次，直接丢弃
   */
  nextGeneration() {
    this.generation++
    this.state = 'idle'
    return this.generation
  }

  transition(to: PlayerState, gen: number, reason: string): boolean {
    if (gen !== this.generation) {
      // ★ 迟到的旧事件 —— 这正是「状态互相覆盖」的根源，必须丢弃
      console.debug(`[player] 丢弃过期事件 ${reason}（gen ${gen} != ${this.generation}）`)
      return false
    }
    if (!TRANSITIONS[this.state].includes(to)) {
      console.warn(`[player] 非法迁移 ${this.state} → ${to}（${reason}）`)
      return false
    }
    this.state = to
    return true
  }
}
```

```ts
/**
 * ★ 系统打断的处理（这是 App 端独有的，也是状态机最能体现价值的地方）
 *
 * uni-app 的 video 组件在 App 端被系统打断时会触发 @pause：
 *   - 来电 / 语音通话
 *   - 其他应用抢占音频焦点（比如用户打开了另一个音乐 App）
 *   - 闹钟
 *   - 系统弹窗（低电量提示等）
 *
 * 问题：这些事件的语义完全不同，但 video 组件都只给一个 @pause。
 * 如果不区分，就会出现「被电话打断后回到应用，视频永远停在暂停」——
 * 而用户根本没按过暂停。
 */
const gen = machine.nextGeneration()
const interrupted = ref(false)

function onSystemPause() {
  // 我们无法从 video 组件区分「用户暂停」和「系统打断」，
  // 所以用「是否有用户操作」来近似判断：
  if (!userPressedPause) {
    interrupted.value = true          // 标记为「被动暂停」
    machine.transition('paused', gen, 'system-interrupt')
  }
}

/**
 * 回到前台时恢复
 *   —— 注意只恢复「被动暂停」的，用户主动暂停的不动
 *      （否则用户暂停后切个 App 回来就自己播了，很烦）
 */
onShow(() => {
  if (interrupted.value && currentIsActive()) {
    interrupted.value = false
    playSafely()                       // 恢复播放
  }
})
```

### 3.3 逐段讲解

**① 「用时间换内存」到底换了什么**

| | 原生播放器池 | 落点保护 + 预下载 |
|---|---|---|
| 吸收滑动抖动的方式 | 空间：多备 7 个播放器实例 | **时间：等 150ms 确认停稳** |
| 快速连滑 7 次时 | 只创建新位置的播放器（旧的留在池里） | **一次都不创建**（7 次都被 150ms 窗口吸收） |
| 滑回来时的体验 | 秒续播（缓冲还在） | 需要重新加载（但有本地预下载可缓解） |
| 内存峰值 | 7 个解码器 | **1 个** |

关键差异在第三行：**代价从「内存」转移到了「回滑体验」。** 这个取舍是 uni-app 逼出来的，但结果对中低端机更友好 —— 中低端安卓机的并发解码器数量本来就少，7 个实例可能导致部分视频直接黑屏。

**② 预下载为什么只预取 1 条**

```
预取 1 条：流量 ×1，覆盖「滑到下一条」这个最高频场景  ← 收益/成本最优
预取 2 条：流量 ×2，多覆盖「连滑两条」——但这种情况用户往往还要继续滑
预取 3 条：用户可能已经滑走了，全部白下载
```

再叠加「只在 WiFi 下预取」这个默认策略，流量风险基本消除。

**③ 状态机的 `generation`（代次）字段是重点**

这是去掉「状态互相覆盖」的关键技巧，值得单独记住：

```ts
// 场景：用户从第 1 条快速滑到第 2 条
//   第 1 条的 video 触发的 waiting 事件，可能在第 2 条已经开始创建之后才到达
//   如果没有代次判断，这个迟到的 waiting 会把第 2 条的状态改成 loading
//   → 界面上显示「加载中」，但实际第 2 条已经在播了
```

这个手法在别处也通用：任何「异步回调可能对应已过期的上下文」的场景，都可以用一个递增的 generation 来丢弃过期回调（`wisora-web` 项目里叫 `cancelled` 标志或 `AbortSignal`，思路一样）。

**④ 为什么 `error` 状态不能自动重试到 `playing`**

播放失败的原因可能是「文件损坏」「编码不支持」「网络 404」。自动重试会陷入：

```
error → 自动重试 → 又 error → 又重试 → 无限循环（用户看到画面一直在闪）
```

正确做法：`error` 只允许重置回 `idle`，且**在 UI 上给出明确反馈**（「播放失败，点击重试」）。用户主动点了才重试。

### 3.4 面试会追问什么

**Q：150ms 这个值怎么定的？**
A：实测调的。连滑间隔通常 80~120ms，所以取 150ms 略大于它；同时 150ms 对于「单次滑动后开始加载」来说感知不到。区间是 100（会误触发）~250（迟滞明显）。**回答这类问题时要能说清「怎么得出的」，而不是只报数字。**

**Q：预下载的文件放在哪，会被系统清理吗？**
A：放在应用自己的缓存目录（不用 `uni.downloadFile` 的默认临时目录，那个会被系统随时清理）。自己管理目录 + 自己维护索引，配合 LRU 上限。

**Q：如果用户开了「非 WiFi 也预加载」，流量怎么控？**
A：① 预取数量仍是 1 条；② 给一个「仅本次」和「始终允许」的区分；③ 在设置页显示已用流量。**产品上一定要有这个开关** —— 偷偷消耗用户流量是会被投诉的。

**Q：为什么不做「起播前预解码」？**
A：uni-app 没有暴露预解码的接口。原生开发可以（`ExoPlayer.prepare()`），这也是原生播放器池方案的另一个优势 —— 但它同时要求多实例，与 §2 的约束冲突。

---

## §4 手势与互动

### 简历原文

> **手势与互动**：双击点赞（uni-app 无原生 doubletap，按两次点击的时间差判定）、
> 单击暂停 / 继续、长按 2 倍速播放，上拉分页与下拉刷新；
> 点赞与评论走**乐观更新 + 失败回滚**，弱网下界面不会卡在旧状态。

### 4.1 这句话在说什么

这一屏上有**四种手势共存**，而且它们互相冲突：

| 手势 | 用户意图 | 冲突点 |
|---|---|---|
| 单击 | 暂停 / 继续 | 与双击冲突（双击的前半就是单击） |
| 双击 | 点赞 | —— |
| 长按 | 2 倍速播放 | 与「按住不放等」的手势、与竖向滑动的起手冲突 |
| 上下滑 | 切上一条 / 下一条 | 长按后滑动应该无效（否则一边加速一边切页） |

**难点不在实现单个手势，而在「判定优先级」** —— 浏览器/原生不会自动帮你区分，必须自己设计时序。

### 4.2 伪代码

#### ① 单击与双击的时序（最关键的一段）

```ts
// composables/useTapGesture.ts

/**
 * ★ 核心问题：uni-app 没有原生 doubletap，必须自己判
 *
 * 难点在于「单击必须延迟执行」：
 *   用户点第一下时，你无法知道这是「单击」还是「双击的前半」，
 *   所以只能等一个窗口（DOUBLE_TAP_MS）再决定。
 *
 * 如果单击立即执行（不延迟）会怎样：
 *   用户双击 → 第一下触发「暂停」 → 第二下触发「点赞」
 *   → 结果：暂停了 + 点赞了（用户只想点赞）
 *
 * 参数：
 *   DOUBLE_TAP_MS = 280
 *     人类的双击间隔通常 120~250ms。取 280ms 覆盖绝大多数人，
 *     同时不至于让单击的延迟显得「迟钝」（300ms 是感知阈值附近）。
 *     这是 iOS / Android 系统级的取值区间，可直接沿用。
 */
const DOUBLE_TAP_MS = 280

export function useTapGesture(handlers: {
  onSingleTap: (e: TouchEvent) => void
  onDoubleTap: (e: TouchEvent) => void
  onLongPress: () => void
}) {
  let lastTapAt = 0
  let singleTapTimer: ReturnType<typeof setTimeout> | null = null
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let longPressed = false          // 本次触摸已经被判定为长按

  const LONG_PRESS_MS = 500        // 长按阈值（比 uni 默认的 350ms 长一点，避免误触）

  function onTouchStart(e: TouchEvent) {
    longPressed = false
    longPressTimer = setTimeout(() => {
      longPressed = true
      // ★ 长按触发时要取消「单击待执行」—— 否则松手后会同时触发单击暂停
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null }
      handlers.onLongPress()
    }, LONG_PRESS_MS)
  }

  function onTouchEnd(e: TouchEvent) {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }

    // ★ 长按期间松手：不触发单击/双击
    if (longPressed) return

    const now = Date.now()
    const gap = now - lastTapAt

    if (gap < DOUBLE_TAP_MS) {
      // ── 双击成立 ──
      // 取消掉「第一下」留下的单击定时器（这是双击不误触发单击的关键）
      if (singleTapTimer) { clearTimeout(singleTapTimer); singleTapTimer = null }
      lastTapAt = 0                       // 重置，避免三击被当成两次双击
      handlers.onDoubleTap(e)
    } else {
      // ── 可能是单击，但要等窗口过去才能确认 ──
      lastTapAt = now
      singleTapTimer = setTimeout(() => {
        singleTapTimer = null
        handlers.onSingleTap(e)
      }, DOUBLE_TAP_MS)
    }
  }

  return { onTouchStart, onTouchEnd }
}
```

```vue
<!-- components/feed/FeedOverlay.vue 的用法 -->
<script setup lang="ts">
const gesture = useTapGesture({
  onSingleTap: () => togglePlay(),
  onDoubleTap: (e) => {
    // ★ 双击点赞必须「只在点赞方向生效」，不能变成 toggle
    //   理由：用户双击是想点赞，不是想取消赞。
    //   如果做成 toggle，用户想取消赞时双击 → 取消了；
    //   但更多的情况是「以为没点上又双击一次」→ 反而取消了赞（体验极差）
    if (!item.liked) doLike(item)
    showHeartAnimation(e.touches[0].clientX, e.touches[0].clientY)
  },
  onLongPress: () => {
    // ★ 长按加速期间要锁住竖向滑动（否则会一边加速一边切页）
    feedLock.value = true
    setPlaybackRate(2)
  },
})
</script>
```

**补充：长按结束要恢复**

```ts
/**
 * 长按的「结束」不能用 @touchend 之外的事件。
 * 特别注意：手指划出元素范围后松手，touchend 可能不触发 →
 * 必须同时监听 touchcancel，否则 rate 会永远停在 2 倍速。
 */
function onTouchCancel() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null }
  if (longPressed) { restoreRate() }
  feedLock.value = false
}
```

#### ② 上拉分页与下拉刷新

```vue
<!--
  ★ 这里有一个容易踩的坑：竖向 swiper 本身就吃「上下滑动」手势，
    再套一层 scroll-view 做下拉刷新会打架。

  可行的做法：
    ① 「下滑刷新」不做成「下拉露出刷新按钮」，而是「滑到第一条再继续下滑时触发」
       —— 用 swiper 的 @change 拿不到「继续下滑」这个信息，需要额外监听 touchmove
    ② 更稳的：把「刷新」做成显式入口（顶部按钮 / 双击顶部状态栏区域），
       放弃下拉手势。短视频应用的刷新本来也不需要高频触发。
    ③ 「上拉分页」则不做成独立手势，而是「滑到接近末尾时自动加载」（预取，见 §6）
-->
```

```ts
/**
 * ★ 结论：「上拉分页」在短视频场景应该做成「自动预取」而不是「独立手势」
 *
 * 原因：
 *   1. 用户的意图是「继续看下一条」，加载下一页是这个动作的副产品，
 *      让用户「拉到顶再拉一下才加载」是多余的仪式；
 *   2. 竖向 swiper 已经是整屏切换，再加一层上拉手势会与它冲突；
 *   3. 预取能做到无感（滑到第 17 条时第 21~40 条已经在路上）。
 */
```

#### ③ 乐观点赞 + 失败回滚

```ts
// stores/interaction.ts
export const useInteractionStore = defineStore('interaction', () => {
  /**
   * ★ 乐观更新的完整形态：立即改 UI → 发请求 → 成功固化 / 失败回滚
   *
   * 三个必须处理的边界：
   *   ① 连点：用户疯狂双击 → 不能发 N 个请求（去重 + 节流）
   *   ② 逆操作：正在点赞中用户又取消了 → 最终状态必须正确
   *   ③ 失败回滚：网络失败要把 UI 改回去，并给用户提示
   */
  const pending = new Map<string, Promise<void>>()

  async function doLike(item: FeedItem) {
    // ① 连点去重：同一 item 有请求在飞时不重复发
    if (pending.has(item.id)) return

    const snapshot = { liked: item.liked, likeCount: item.likeCount }

    // ① 立即更新 UI（乐观）
    item.liked = true
    item.likeCount += 1

    const task = (async () => {
      try {
        // ② 用「目标状态」而不是「toggle」调接口 —— 幂等
        //    双击两次发两个 like=true 请求，结果仍然只赞一次，
        //    不会因为重试或重放变成「赞-取消-赞」
        const res = await api.like(item.id, true)
        item.likeCount = res.likeCount        // ③ 以服务端返回的数字为准（可能有别人也在赞）
      } catch (err) {
        // ④ 回滚到快照
        item.liked = snapshot.liked
        item.likeCount = snapshot.likeCount
        toast('点赞失败，请重试')
      } finally {
        pending.delete(item.id)
      }
    })()

    pending.set(item.id, task)
    await task
  }

  /** 取消赞：同样的结构 */
  async function undoLike(item: FeedItem) { /* 同上，目标状态传 false */ }

  return { doLike, undoLike }
})
```

```ts
/**
 * ★ 为什么「点赞数」要以服务端返回为准
 *
 * 本地 +1 只是为了让用户立刻看到反馈。真实数字可能因为你点赞的同时
 * 别人也在点赞而变化 —— 如果坚持用本地 +1，用户看到的是「永远少一点」。
 *
 * 但要避免「数字跳变」：
 *   乐观 +1 → 服务端返回 1234 → 本地从 (1229+1=1230) 跳到 1234
 *   处理方式：用动画平滑过渡（不是直接替换），或者只在差值较小时采信服务端。
 */
```

### 4.3 逐段讲解

**① 单击延迟 280ms 是「不可避免的代价」**

很多人会想「能不能不延迟」—— 答案是不能。因为**信息不足**：用户点第一下的时候，你无法知道会不会有第二下。

| 方案 | 缺点 |
|---|---|
| 单击立即执行 | 双击时第一下会误触发（暂停了 + 点赞了） |
| **单击延迟 280ms** | 单击暂停有 280ms 延迟 ← **可接受**（暂停不是高频操作） |
| 用「区域区分」 | 抖音的做法：双击点赞在画面中部，点击暂停需要点特定区域 —— 降低歧义但不消除 |

**工程上的缓解**：暂停的反馈不必等 280ms —— **可以立即显示暂停图标的动画**，只是实际暂停动作延后。用户感觉是「立刻响应」的。

**② 长按的 `touchcancel` 不能漏**

```ts
// ✗ 只监听 touchend
@touchend="onTouchEnd"

// ✓ 同时监听 touchcancel
@touchend="onTouchEnd" @touchcancel="onTouchCancel"
```

**漏掉的后果**：手指长按后滑出屏幕/划出元素 → `touchend` 不触发 → 倍速永远停在 2 倍。用户会觉得「这个 App 的倍速坏了」。

**③ 为什么「双击只点赞、不取消」**

这是产品上的重要决策（也是抖音的做法）：

```
如果双击 = toggle：
  用户双击想点赞 → 没看清有没有点上 → 又双击一次
  → 第二次双击把赞取消了
  → 用户看到「没点上」，再双击 → 又赞上了
  → 用户彻底困惑
```

**「双击 = 只赞不取消」**：连点多少次都只赞一次（配合幂等接口）。取消赞走另一个入口（长按点赞图标、或详情页）。

**④ 乐观更新的三条铁律**

| 铁律 | 原因 |
|---|---|
| 接口用「目标状态」而不是 toggle | 幂等。重试/重放不会翻转状态 |
| 本地立即改 + 快照回滚 | 弱网下有反馈，失败能恢复 |
| 同一 item 的请求要去重 | 连点不产生 N 个请求 |

**⑤ 弱网下「界面卡在旧状态」是怎么产生的**

```ts
// ✗ 反面写法：等请求回来才改 UI
async function onDoubleTap() {
  const res = await api.like(item.id, true)      // 弱网下这里要等 5 秒
  item.liked = true                              // 5 秒后 UI 才变
  item.likeCount = res.likeCount
}
```

用户双击后**看不到任何反馈**，会以为没点上 → 继续双击 → 攒了一堆请求 → 网络恢复后一起打出。

乐观更新把这个「等待窗口」变成了「瞬时反馈」。这也是简历里那句「弱网下界面不会卡在旧状态」的具体含义。

### 4.4 面试会追问什么

**Q：双击判定为什么不用 `@dblclick`？**
A：App 端的 `@dblclick` 依赖原生 WebView 的双击事件，在 uni-app 的 App 端不可靠（部分机型不触发、且与原生手势有冲突）。所以自己按时间差判。

**Q：280ms 的延迟会不会让用户觉得「点了没反应」？**
A：会有一点。所以有两个缓解：① 单击的**视觉反馈**立即给出（暂停图标动画），只是真正的暂停动作延后；② 如果这个区域的单击是高频操作（比如「下一集」按钮），就不做双击判定 —— 把双击区域限制在视频画面内。

**Q：连点点赞时的并发怎么处理？**
A：`pending` 表去重 —— 同一个 item 有请求在飞就直接 return。另外接口设计成幂等的「set like=true」，不依赖前一次的结果。

**Q：长按加速时用户滑动切页了怎么办？**
A：长按开始时就置 `feedLock = true` 锁住滑动容器（通过给 swiper 加 `:disable-touch` 或动态控制）。不加这个锁，用户长按后稍微移动手指就会触发切页，而 2 倍速还在生效 —— 下一条视频一上来就是加速状态。

---

## §5 曝光与观看时长埋点

### 简历原文

> **曝光与观看时长埋点**：以**可见比例**（阈值 75%）判定一次有效曝光，并记录播放起点，
> 在暂停、切换、离开页面时上报带**条目索引与毫秒数**的观看时长 ——
> 完播率与停留时长是推荐侧对齐的关键指标，必须在客户端算准。

### 5.1 这句话在说什么

推荐系统靠**用户行为**来调整内容。它需要的两个最重要的信号：

| 指标 | 含义 | 为什么重要 |
|---|---|---|
| **曝光** | 「用户看到了这条」 | 分母。没有曝光，完播率无从谈起 |
| **观看时长** | 「看了多久」 | 比「看完没」更细的偏好信号 |

**「必须在客户端算准」的意思是**：这两个指标完全依赖客户端的采集 —— 服务端看不到用户的眼睛。如果客户端上报错了，整个推荐模型就学偏了。

而且**「看了 3 秒就划走」和「看了 30 秒才划走」是完全不同的信号**（前者说明用户不感兴趣），差一个数量级的信息量。

### 5.2 伪代码

#### ① 曝光判定：可见比例阈值

```ts
// core/track/exposure.ts

/**
 * ★ 为什么用「可见比例 75%」而不是「渲染了就上报」
 *
 * 用「渲染了」会多报：用户快速滑过时，中间那几条还没来得及看清就过去了，
 *   但它们都渲染过 → 全部被算作「曝光」
 *   → 推荐系统以为「这些内容用户都看过但没停留」→ 学成「用户不喜欢这类」
 *   → 这是最坏的情况：把用户的兴趣样本污染了
 *
 * 用「可见比例」则要求这条内容真的在屏幕上占据了大部分面积：
 *   - 75% 的含义：一条视频至少 3/4 显示出来才算「看到了」
 *   - 为什么不是 100%：滑动过程中很难精确停在 100%，
 *     取 75% 能覆盖「基本铺满」的状态
 *   - 为什么不是 50%：那会让「滑到一半就滑走」也算曝光，
 *     与「用户真的看了」混淆
 */
const EXPOSURE_RATIO = 0.75

/**
 * ★ App 端怎么算「可见比例」
 *
 * H5 有 IntersectionObserver，但 App 端（非 H5 渲染）不能用。
 * 而我们的滑动容器是「整屏切换」，所以「可见比例」其实可以直接推导：
 *   - 滑动中：根据 swiper 的滑动进度推算可见比例
 *   - 静止时：当前页 = 1.0，其他页 = 0
 *
 * 这就是「整屏切换」带来的一个便利 —— 不需要真的测量可见面积。
 */
function computeVisibleRatio(currentIndex: number, slidingProgress: number, itemIndex: number): number {
  if (itemIndex === currentIndex) return 1 - slidingProgress
  if (itemIndex === currentIndex + 1) return slidingProgress      // 下一条滑入一半
  if (itemIndex === currentIndex - 1) return 0                    // 上一条滑出
  return 0
}
```

```ts
// core/track/session.ts

/**
 * ★ 一次「观看会话」的记录
 *
 * 关键设计：用「开始时刻 + 累计有效时长」而不是「开始 + 结束时间」
 *   因为视频可能被暂停（用户单击暂停），暂停期间不该算进观看时长。
 *   如果用「进入时间 - 离开时间」，用户暂停 5 分钟就会上报 5 分钟观看 —— 数据全废。
 */
interface ViewSession {
  itemId: string
  index: number            // ★ 简历里说的「条目索引」
  startedAt: number        // 第一次开始播放的时间戳
  /** 累计播放时长（只在 playing 状态下累加） */
  watchedMs: number
  /** 上一次进入 playing 的时刻（用于计算增量） */
  playingSince: number | null
  /** 曝光是否已上报（一次会话只报一次曝光） */
  exposed: boolean
  /** 视频总时长（用于算完播率） */
  durationMs: number | null
}

class ViewTracker {
  private session: ViewSession | null = null
  private queue: TrackEvent[] = []

  /**
   * ★ 曝光：达到 75% 可见比例且开始播放时，上报一次
   *   —— 注意「开始播放」也是条件之一：
   *      可见比例到了但因为还在加载没播出来，用户其实没看到内容
   */
  onVisibleRatioChange(item: FeedItem, index: number, ratio: number, playing: boolean) {
    if (!this.session || this.session.itemId !== item.id) {
      this.startSession(item, index)
    }
    if (!this.session!.exposed && ratio >= EXPOSURE_RATIO && playing) {
      this.session!.exposed = true
      this.enqueue({
        type: 'exposure',
        itemId: item.id,
        index,
        ratio,
        ts: Date.now(),
      })
    }
  }

  private startSession(item: FeedItem, index: number) {
    // ★ 开新会话前，先把上一条的时长结了（这是「不漏报」的关键）
    this.endSession('switch')
    this.session = {
      itemId: item.id,
      index,
      startedAt: Date.now(),
      watchedMs: 0,
      playingSince: null,
      exposed: false,
      durationMs: item.durationMs ?? null,
    }
  }

  /** 播放状态变化：维护「累计播放时长」 */
  onPlayStateChange(state: PlayerState) {
    const s = this.session
    if (!s) return

    if (state === 'playing') {
      if (s.playingSince === null) s.playingSince = performance.now()
    } else {
      // ★ 离开 playing 状态就把这一段的时长结算掉
      if (s.playingSince !== null) {
        s.watchedMs += performance.now() - s.playingSince
        s.playingSince = null
      }
    }
  }

  /**
   * ★ 上报观看时长 —— 三个触发时机（简历里写的「暂停、切换、离开页面」）
   */
  endSession(reason: 'pause' | 'switch' | 'leave' | 'flush') {
    const s = this.session
    if (!s) return

    // 结算最后一段（如果还在播）
    if (s.playingSince !== null) {
      s.watchedMs += performance.now() - s.playingSince
      s.playingSince = null
    }

    // ★ 太短的不报（< 500ms）：多半是「滑过去时闪了一下」，
    //   报上去会污染数据（表现为「大量 0.2 秒的观看」）
    if (s.watchedMs >= 500) {
      this.enqueue({
        type: 'view',
        itemId: s.itemId,
        index: s.index,                  // ★ 简历里的「条目索引」
        watchedMs: Math.round(s.watchedMs),   // ★ 简历里的「毫秒数」
        durationMs: s.durationMs,
        // 完播率相关：留给服务端 / 离线算，客户端只上报原始时长
        completed: s.durationMs ? s.watchedMs >= s.durationMs * 0.95 : null,
        reason,
        ts: Date.now(),
      })
    }

    this.session = null
  }
}
```

#### ② 上报队列：批量 + 可靠

```ts
// core/track/queue.ts

/**
 * ★ 埋点绝不能「产生一条就发一个请求」
 *   一次浏览会话会产生几十条埋点，逐条请求既浪费电也浪费流量，
 *   而且弱网下会积压一堆失败请求。
 *
 * 策略：
 *   ① 批量：满 10 条或每 5 秒 flush 一次（取先到者）
 *   ② 失败重试一次，仍失败就丢弃（埋点丢了不能影响主流程）
 *   ③ 页面隐藏 / 退出时强制 flush（这是唯一可能丢数据的时机，必须处理）
 */
const BATCH_SIZE = 10
const FLUSH_INTERVAL = 5_000

class TrackQueue {
  private buf: TrackEvent[] = []
  private timer: ReturnType<typeof setInterval> | null = null

  enqueue(e: TrackEvent) {
    this.buf.push(e)
    if (this.buf.length >= BATCH_SIZE) void this.flush()
    else if (!this.timer) this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL)
  }

  async flush() {
    if (!this.buf.length) return
    const batch = this.buf
    this.buf = []

    try {
      await api.reportEvents(batch)
    } catch {
      // ★ 只重试一次。埋点不值得为它做复杂的重试队列 ——
      //   一次失败可能意味着网络断了，重试也只是白费
      try { await api.reportEvents(batch) } catch { /* 丢弃 */ }
    } finally {
      if (!this.buf.length && this.timer) { clearInterval(this.timer); this.timer = null }
    }
  }

  /**
   * ★ 页面要隐藏/销毁时的「最后一报」
   *
   * 这里有个真实的矛盾：App 端进入后台后，异步请求可能被系统冻结，
   * 所以「最后一报」不能依赖普通的异步请求。
   *
   * 处理顺序：
   *   ① 先结算当前会话（把时长算出来）
   *   ② 立即 flush（不等定时器）
   *   ③ 如果 appHide 提供了剩余时间，用同步/低延迟的方式发出去
   */
  flushOnHide() {
    void this.flush()
  }
}
```

#### ③ 埋点字段清单

```ts
/**
 * ★ 一次观看上报包含的字段（这张表是「推荐侧能不能用」的关键）
 */
interface ViewEvent {
  type: 'view'
  itemId: string
  index: number            // 条目索引：让推荐侧知道「这条在第几位被看到」
  watchedMs: number        // 观看毫秒数：核心信号
  durationMs: number | null
  completed: boolean | null
  reason: 'pause' | 'switch' | 'leave' | 'flush'   // 为什么结束
  ts: number
}

/**
 * 为什么要有 index：
 *   同一个内容出现在第 3 位和第 30 位，用户的观看行为差异很大
 *   （前几条有天然的注意力优势）。带 index 才能让推荐侧做位置纠偏。
 *
 * 为什么要有 reason：
 *   - pause：用户主动暂停 —— 可能是想看细节（正反馈）
 *   - switch：滑走 —— 可能是无聊（负反馈）
 *   - leave：退出应用 —— 中性
 *   同一个时长、不同的 reason，语义完全不同。
 */
```

### 5.3 逐段讲解

**① 「累计播放时长」vs「页面停留时长」**

这是埋点里最容易搞错的地方：

```ts
// ✗ 停留时长：包含暂停、加载、切后台
const dwell = Date.now() - enteredAt

// ✓ 播放时长：只在 playing 状态累加
let watched = 0
onPlay  → playingSince = now
onPause → watched += now - playingSince; playingSince = null
```

**为什么这个区别是致命的**：用户看到喜欢的视频，暂停下来仔细看 → 停留时长 3 分钟，播放时长 30 秒。如果用停留时长，这条内容会被标记成「超高质量」；但它其实是「用户需要暂停才能看清」—— 两者的推荐含义完全不同。

**② `< 500ms` 不报的理由**

快速滑动时，中间的视频会短暂进入 playing 状态（起播后立刻被滑走）。这些 200ms 的记录如果上报，会形成大量「极短观看」样本，让推荐系统误以为「用户对这些内容都是扫一眼就走」。

**③ 循环播放（`loop: true`）带来的歧义**

短视频通常设 `loop`（播完自动重播）。于是：

```
用户看了 3 遍（每遍 15 秒）
  watchedMs = 45000
  durationMs = 15000
  如果按 watchedMs / durationMs 算，完播率 = 300%（超过 100%）
```

处理方式有两种，**必须和服务端约定清楚**：

| 方案 | 上报内容 | 服务端算法 |
|---|---|---|
| A：只报「单次最长连续播放」 | 15000 | 完播率 = watched / duration ≤ 100% |
| **B：报总时长 + 播放遍数**（推荐） | 45000 + loopCount=3 | 完播率按「是否 ≥ 1 遍」算；重复遍数单独作为「喜爱度」信号 |

**重复观看是强正反馈信号**，直接截断到 100% 会丢掉这个信息。

**④ 最后一个数据点的可靠性**

「离开页面」这条上报最容易丢 —— App 端切后台后请求可能被冻结。可用的手段：

- App 端 `onHide` 有短暂的执行窗口（通常够发一个请求）
- 更保险的是**本地先落盘**（`uni.setStorageSync`），下次启动时补报。

```ts
onHide(() => {
  tracker.endSession('leave')
  // ★ 兜底：把未发出的埋点先落盘，下次启动补报
  storage.set('PENDING_TRACKS', JSON.stringify(queue.pending()))
  queue.flushOnHide()
})

// App 启动时
onLaunch(() => {
  const pending = storage.get('PENDING_TRACKS')
  if (pending) { queue.enqueueAll(JSON.parse(pending)); storage.remove('PENDING_TRACKS') }
})
```

### 5.4 面试会追问什么

**Q：75% 这个阈值是怎么定的？**
A：它是「滑动过程中判定是否算看到」的分界。整屏切换的交互里，滑到一半时（50%）用户其实还没看清内容；滑到 75% 时基本铺满了，即使立刻滑走，用户也已经看到了主体内容。这个值可以调，重要的是**它必须是一个「按可见面积」而非「按渲染与否」的判据**。

**Q：如果用户点了暂停去倒水，回来继续看，怎么算？**
A：`watchedMs` 只累加 playing 状态，所以那段时间不计入。但 `reason: 'pause'` 会被记录下来 —— 服务端可以看到「这条内容有大量长时间暂停」，这是「内容需要细看」的信号。

**Q：埋点会不会影响性能？**
A：三条保障：① 客户端只做「记录 + 批量入队」，不做任何计算（完播率的判断也只在最后算一次布尔值）；② 每 5 秒或满 10 条才发一次请求；③ 播放状态变化时只更新时间戳（O(1)），不做 IO。

**Q：为什么不在服务端算观看时长？**
A：服务端只知道「什么时候发的播放请求」和「什么时候断的」，无法区分「用户暂停了」和「用户在观看」。要在服务端算准，就得把每一次 play/pause 都上报 —— 那比在客户端算好再上报更费流量。

---

## §6 分页、缓存与工程化

### 简历原文

> **分页、缓存与工程化**：游标分页 + **距末尾 3 条预取下一页**并对返回去重，
> 避免重复数据导致的 key 冲突；App 端媒体缓存设 **LRU 上限**（超出按最久未播放淘汰）
> 并定期清理孤儿文件，把磁盘占用压在可控范围；UnoCSS 原子化样式配 uView Pro 组件、
> **按需引入**控制包体，图片统一走 CDN 裁剪参数以降低流量与解码开销。

### 6.1 游标分页（为什么不用 offset）

```ts
/**
 * ★ 推荐流必须用「游标分页」而不是「offset 分页」
 *
 * offset 分页：GET /feed?page=2&size=20  → 服务端取第 21~40 条
 * 游标分页：  GET /feed?cursor=<lastId>&size=20 → 服务端取「这个 id 之后的 20 条」
 *
 * 为什么推荐流用 offset 会出问题：
 *   推荐流的内容是「每次请求都重新算」的（个性化排序）。
 *   t0  用户拉第一页 → 拿到 [A B C ... T]（20 条）
 *   t1  用户往下滑，同时有其他用户的行为变化 → 服务端的排序变了
 *   t2  用户拉第二页（offset=20）→ 服务端的第 21~40 条
 *       ← 但因为排序变了，原来的第 15 条可能现在排在第 22 位
 *   t3  用户看到第 15 条出现两次（重复）；也可能有些条目被跳过（漏掉）
 *
 * 游标分页把「位置」变成「锚点」：
 *   第二页请求带的是「我手上最后一条的 id + 一个用于稳定排序的种子」，
 *   服务端返回「严格排在这个锚点之后的 20 条」—— 天然不会重复。
 */
interface FeedPage {
  items: FeedItem[]
  nextCursor: string | null      // null 表示没有更多
}

async function fetchFeed(cursor: string | null, size = 20): Promise<FeedPage> {
  // ★ 首次请求不带游标；后续都带「最后一条的位置」
  return request.get('/feed/recommend', { params: { cursor, size } })
}
```

**去重仍然必要**（简历里提到的）：

```ts
/**
 * ★ 为什么「游标分页了还要去重」
 *
 * 游标分页解决了「同一个内容出现在两个不同页」的问题，
 * 但没解决「同一页内重复」以及「网络重试导致的重复」：
 *   ① 用户快速滑到底、预取请求失败后重试 → 可能拿到同一批数据两次
 *   ② 内容池小的时候，服务端可能在两页里推同一条（算法侧的去重窗口有限）
 *
 * 所以客户端这一层去重是「最后一道保险」，代价很低（一个 Set）。
 */
const seen = new Set(items.value.map((x) => x.id))
const fresh = page.items.filter((x) => !seen.has(x.id))
items.value.push(...fresh)

/**
 * ★ 为什么必须去重（除了观感）
 *   列表用 item.id 做 key（§2），如果有重复 id：
 *     - Vue 会警告 "Duplicate keys"
 *     - 更严重的是滑动容器的位置映射会错乱（第 5 条和第 25 条是同一个 id，
 *       窗口滑动时定位会出错，表现为「滑到某处卡住」）
 */
```

### 6.2 预取下一页

```ts
/**
 * ★ 距末尾 3 条时预取
 *
 * 为什么是 3：
 *   一次预取拉 20 条，网络耗时通常 300~800ms（移动网络更久）。
 *   用户在推荐流里的滑动节奏大约是「1~3 秒滑一条」，
 *   所以 3 条 ≈ 3~9 秒的缓冲，足够覆盖网络波动。
 *
 *   太早预取（比如剩 10 条）：用户可能根本滑不到那里，白拉一页数据；
 *   太晚（剩 1 条）：网络慢的时候用户会滑到底部看到空白。
 *
 * 注意：这个参数与「三屏窗口」（§1）配合 ——
 *   窗口是 3，所以「距末尾 3 条」实际上就是「窗口即将移出已加载范围」的时刻。
 */
const PREFETCH_THRESHOLD = 3

function markSeen(index: number) {
  if (!cursor.value) return                       // 没有更多了
  if (items.value.length - index <= PREFETCH_THRESHOLD) void loadMore()
}

/**
 * ★ 预取要防并发：用户快速滑动时 markSeen 会被连续调用多次
 *   不加锁会同时发 3~4 个 loadMore → 拉回重复数据（虽然有去重兜底，
 *   但流量白费，而且服务端的推荐计算成本很高）
 */
let loading = false
async function loadMore() {
  if (loading || !cursor.value) return            // ★ 锁
  loading = true
  try { /* ... */ } finally { loading = false }
}
```

### 6.3 缓存：三种资源三种策略

```ts
/**
 * ★ 短视频应用有三类完全不同的资源，缓存策略必须分开
 */
```

| 资源 | 大小 | 变化 | 策略 | 上限 |
|---|---|---|---|---|
| **视频文件** | 1~20MB | 内容不重复（看过就基本不看） | **LRU，按最久未播放淘汰** | 150MB / 60 条 |
| **封面图** | 50~200KB | 同上 | 交给图片框架的磁盘缓存 + CDN 参数 | 框架默认（通常 100MB） |
| **用户头像** | 2~20KB | 会变 | 内存 LRU + 短 TTL（1 小时） | 200 个 |

```ts
/**
 * ★ 「定期清理孤儿文件」是什么情况
 *
 * 会产生孤儿文件的三个场景：
 *   ① 预下载到一半被取消（用户滑走了）→ 留下一个不完整的文件
 *   ② LRU 淘汰时只删了索引、删文件失败（比如文件被占用）
 *   ③ 应用升级后缓存目录结构变了，老文件没人认领
 *
 * 清理时机：
 *   - App 启动后延迟 10 秒（不占用启动关键路径）
 *   - 每次 LRU 淘汰后顺手检查
 *   - 用户主动「清除缓存」时
 *
 * 判断孤儿的依据：目录里存在、但不在当前 LRU 索引里的文件。
 */
async function cleanupOrphans() {
  const indexed = new Set(cache.allPaths())
  const files = await listDir(CACHE_DIR)

  for (const f of files) {
    if (indexed.has(f.path)) continue
    // ★ 留一个宽限期：可能是正在下载的临时文件
    if (Date.now() - f.mtimeMs < 10 * 60_000) continue
    await removeFile(f.path)
  }
}
```

### 6.4 工程化：包体控制

```jsonc
// pages.json —— uni-app 的 easycom：按需引入 uView Pro
{
  // ★ easycom 让 uni-app 自动按需引入组件：
  //   模板里写 <u-button>，编译器自动 import 对应组件，没用到的不进包
  "easycom": {
    "autoscan": true,
    "custom": {
      "^u-(.*)": "uview-pro/components/u-$1/u-$1.vue"
    }
  }
}
```

```ts
// uno.config.ts —— UnoCSS 配置
import { defineConfig, presetUno, presetAttributify } from 'unocss'

export default defineConfig({
  presets: [
    presetUno(),
    presetAttributify(),          // 支持 <div flex items-center> 这种属性写法
  ],
  /**
   * ★ 关键：UnoCSS 是「按需生成」的 —— 它扫描源码里的类名，
   *   只生成用到的那部分 CSS。
   *   所以最终 CSS 体积 = 用到的原子类数量，而不是框架的全部规则。
   *
   *   对比：如果不用原子化 CSS 而用传统 UI 框架的全量样式，通常是 200~500KB。
   */
  safelist: [
    // ★ 动态拼接的类名要放 safelist，否则不会被生成
    //   （和 Tailwind 一样的问题：构建期扫源码文本，看不见模板拼接）
    'i-carbon-play-filled',
    'i-carbon-pause-filled',
  ],
})
```

```ts
// 图片走 CDN 裁剪参数
const coverUrl = (key: string, w: number, h: number) =>
  `${CDN}/${key}?x-oss-process=image/resize,w_${w},h_${h}/quality,q_75/format,webp`

/**
 * ★ App 端的一个额外考虑：webp 解码
 *   - Android 4.0+ / iOS 14+ 都支持 webp，可以放心用
 *   - 但 webp 解码比 jpg 略慢 —— 对封面图无感，对大图（详情页）可能感知到
 *   - 所以列表封面用 webp，详情页大图用 jpg（体积换解码速度）
 */
```

**包体控制的四项措施对照**：

| 措施 | 省下的体积 | 代价 |
|---|---|---|
| uView Pro 按需引入（easycom） | 几百 KB（取决于用了多少组件） | 无（配置一次） |
| UnoCSS 原子化 | 相比全量样式框架省 200KB+ | 类名较长（可读性问题） |
| 封面图 CDN 裁剪 + webp | 取决于图片，通常 40~60% | 无 |
| 不引入体积大的第三方库 | —— | 有的功能要自己实现 |

### 6.5 面试会追问什么

**Q：游标分页的「游标」具体是什么？**
A：通常是一个「能唯一定位当前位置」的字符串 —— 可以是最后一条的 id，也可以是「服务端生成的、编码了排序位置的 token」。**关键要求是：服务端能用它推出「从这个位置之后的内容」**。

**Q：视频 LRU 和浏览器/SDK 自带的缓存冲突吗？**
A：不冲突但要避免重复。我们自己管理预下载文件（因为要控制「预取哪一条」），而播放时优先用自己缓存的本地路径。SDK 层面的 HTTP 缓存对我们影响不大，因为播放器请求的是本地文件。

**Q：为什么缓存上限是 150MB？**
A：参考抖音/快手的默认值区间（通常 100~500MB）。150MB 在中低端机上不会触发系统的存储告警，同时够存 20~40 条短视频 —— 覆盖用户的「回头再看」需求。这个值应该做成用户可调的（抖音就允许选择「不缓存/小/中/大」）。

---

## §7 App 端适配与稳定性

### 简历原文

> **App 端适配与稳定性**：适配刘海屏与底部手势条（`safe-area-inset`）并处理沉浸式状态栏；
> 应对系统音频焦点被打断（来电、其他应用播放）与切后台场景 ——
> **自动暂停并记录播放位置，回到前台由状态机恢复**，避免后台偷跑流量与声音；
> 发布侧接入 **wgt 资源包热更新**，前端承接版本比对、下载进度与失败回退，小改动不必走整包发版。

### 7.1 安全区域与沉浸式状态栏

```css
/* ★ 全屏视频应用必须处理的三个区域 */
.slide {
  /* 整屏高度：不能用 100vh —— App 端的 100vh 不减去系统栏高度 */
  height: 100vh;
}

/* ① 顶部：状态栏区域（刘海、挖孔）—— 内容不能进去 */
.top-safe {
  padding-top: env(safe-area-inset-top, 0px);
}

/* ② 底部：手势条 / 虚拟导航栏 —— 交互元素不能进去 */
.bottom-safe {
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* ③ 横屏时的左右（部分机型有圆角遮挡） */
.landscape-safe {
  padding-left: env(safe-area-inset-left, 0px);
  padding-right: env(safe-area-inset-right, 0px);
}
```

```jsonc
// pages.json —— 沉浸式状态栏配置
{
  "pages": [
    {
      "path": "pages/recommend/index",
      "style": {
        // ★ 沉浸式：让视频内容延伸到状态栏下方（更沉浸），
        //   但交互元素要避开安全区
        "navigationStyle": "custom",
        "app-plus": {
          "titleNView": false,
          // 状态栏文字用浅色（因为视频通常是深色背景）
          "statusbar": { "style": "light" }
        }
      }
    }
  ]
}
```

```ts
/**
 * ★ 状态栏文字颜色应该「跟着内容变」
 *
 * 因为视频背景可能是亮的也可能是暗的 ——
 * 纯白背景上放白色状态栏文字 = 看不见。
 *
 * 做法：根据当前视频的平均亮度动态切换（可以在服务端预先算好每个视频的
 * 「建议状态栏颜色」，比客户端实时算便宜得多）。
 */
function syncStatusBarStyle(item: FeedItem) {
  const style = item.brightness === 'light' ? 'dark' : 'light'
  // #ifdef APP-PLUS
  plus.navigator.setStatusBarStyle(style)
  // #endif
}
```

### 7.2 音频焦点与切后台

```ts
/**
 * ★ App 端独有的三类打断，处理方式各不相同
 */
```

| 打断来源 | 事件表现 | 正确处理 |
|---|---|---|
| **来电 / 通话** | video 触发 `@pause` | 标记「被动暂停」→ 通话结束后恢复播放（但不自动播放，等用户回前台） |
| **其他 App 抢占音频焦点** | video 触发 `@pause` | 标记「被动暂停」→ 回前台时恢复 |
| **用户切后台** | 应用级 `onHide` | **暂停并记录位置**，同时停掉所有网络活动（不偷跑流量） |

```ts
// pages/recommend/index.vue
import { onHide, onShow } from '@dcloudio/uni-app'

let savedPositionMs = 0
let wasPlayingBeforeHide = false

onHide(() => {
  // ★ 记录播放位置：回到前台要从这里继续
  savedPositionMs = currentPosition.value
  wasPlayingBeforeHide = playerState.value === 'playing'

  /**
   * ★ 暂停的时机很重要：
   *   有些 Android 机型在后台仍然播放音频（尤其是 uni-app 的原生播放器层，
   *   它不完全跟随 WebView 的生命周期）—— 「视频看不到但声音还在响」
   *   所以不能只依赖「页面隐藏自动暂停」，必须显式停。
   */
  palette.stopAll()                  // §2.3 的全局播放器注册表
  playback.pause()                   // 显式暂停（保留上下文，便于回前台续播）

  /**
   * ★ 同时停掉后台的网络活动 —— 「避免后台偷跑流量」
   *   预下载任务是最大的流量来源，切后台必须取消
   */
  downloadRegistry.cancelAll()
  feed.pausePrefetch()

  // 埋点最后一报（§5）
  tracker.endSession('leave')
  trackQueue.flushOnHide()
})

onShow(() => {
  // ★ 只在「切走前是在播放」且「当前页仍是激活状态」时恢复
  //   否则会出现「用户暂停后切走，回来自己开始播了」
  if (wasPlayingBeforeHide && currentIsActive()) {
    playback.seekTo(savedPositionMs)     // 从记录的位置继续
    playback.play()
  }
  feed.resumePrefetch()
})
```

```ts
/**
 * ★ 还有一个容易被忽略的场景：锁屏 / 息屏
 *   它既不触发 onHide 也不触发音量变化，但屏幕关了。
 *   如果继续播放，就是纯粹的耗电 + 流量。
 *
 *   App 端可以通过监听屏幕状态（部分机型需要原生插件）。
 *   退一步的做法：配合「30 秒无操作自动暂停」的兜底策略。
 */
```

### 7.3 wgt 热更新

```ts
// core/update/hotUpdate.ts

/**
 * ★ wgt 是 uni-app 的资源包格式：只包含 JS / CSS / 模板 / 静态资源，
 *   不含原生部分。所以：
 *     - 改了业务逻辑、样式、页面 → 可以用 wgt 热更新（免发版）
 *     - 改了原生插件、manifest 权限、原生模块 → 必须整包发版
 *
 * 【流程】
 *   ① 启动时拿本地版本号，向服务端询问有无更新
 *   ② 有更新 → 下载 wgt（带进度）
 *   ③ 下载完成 → 校验（大小 + 可选 hash）
 *   ④ 安装 → 重启应用生效
 *
 * 【前端承接的职责】
 *   版本比对、进度与提示、失败回退 —— 全在前端。
 */
const UPDATE_CHECK_DELAY = 5_000     // 启动后延迟 5 秒检查，不占用启动关键路径

interface UpdateInfo {
  version: string
  wgtUrl: string
  size: number
  /** 强制更新（低于这个版本必须更新，用于修复严重问题） */
  force?: boolean
  /** 说明文案，展示给用户 */
  notes?: string
}

export function setupHotUpdate() {
  // #ifdef APP-PLUS
  setTimeout(() => void checkUpdate(), UPDATE_CHECK_DELAY)
  // #endif
}

async function checkUpdate() {
  // ★ 步骤 1：拿本地版本号
  //   plus.runtime.getProperty 拿到的 version 是 manifest 里的版本，
  //   而 wgt 更新后会变成一个带后缀的版本（如 1.2.0.20250901）
  plus.runtime.getProperty(plus.runtime.appid, (info) => {
    void doCheck(info.version)
  })
}

async function doCheck(localVersion: string) {
  let remote: UpdateInfo | null = null
  try {
    remote = await api.checkUpdate({ platform: 'app', version: localVersion })
  } catch {
    return                          // ★ 检查失败静默忽略 —— 更新不该影响用户使用
  }
  if (!remote || !needUpdate(localVersion, remote.version)) return

  // ★ 步骤 2：询问用户（非强制时）
  if (!remote.force) {
    const ok = await confirm({
      title: '发现新版本',
      content: remote.notes ?? `版本 ${remote.version}（${formatSize(remote.size)}）`,
      confirmText: '立即更新',
      cancelText: '稍后',
    })
    if (!ok) return
  }

  await downloadAndInstall(remote)
}

/**
 * ★ 步骤 3：下载 + 安装
 *
 * 这里有几个必须处理的失败场景：
 *   ① 下载中断（切后台、网络切换）→ 要能续传或重来，不能让用户卡在 50%
 *   ② 磁盘空间不足 → 提前检查
 *   ③ 安装失败（wgt 损坏）→ 保留旧版本，提示重新下载
 *   ④ 安装成功后必须重启才生效 → 要明确告知，且不能在用户看视频时强重启
 */
async function downloadAndInstall(info: UpdateInfo) {
  const toastInstance = showLoadingToast(`正在下载 0%`)

  const task = uni.downloadFile({
    url: info.wgtUrl,
    success: (res) => {
      if (res.statusCode !== 200) return onDownloadFailed('下载失败')
      install(res.tempFilePath)
    },
    fail: () => onDownloadFailed('网络异常'),
  })

  // ★ 进度反馈：wgt 通常几 MB，用户需要知道「还要多久」
  task.onProgressUpdate((p) => {
    toastInstance.update(`正在下载 ${p.progress}%`)
  })
}

function install(wgtPath: string) {
  plus.runtime.install(
    wgtPath,
    { force: false },                       // force: true 会覆盖相同版本，一般不用
    () => {
      // ★ 安装成功 → 提示用户重启（不强制立即重启，避免打断正在看的内容）
      showUpdateDoneDialog({
        onConfirm: () => plus.runtime.restart(),
      })
    },
    (err) => {
      // ★ 安装失败：wgt 可能损坏。删掉临时文件，提示重试
      console.error('[update] 安装失败', err)
      toast('更新包校验失败，请稍后重试')
      // 注意：此时用户的旧版本仍然可用（install 失败不会破坏现有资源）
    },
  )
}

/**
 * ★ 版本比对的实现细节
 *   uni-app wgt 更新后的版本号形如 "1.2.0.20250901"，
 *   直接字符串比较会出错（"1.10.0" < "1.9.0"），必须按段比数字。
 */
function needUpdate(local: string, remote: string): boolean {
  const parse = (v: string) => v.split('.').map((x) => parseInt(x, 10) || 0)
  const a = parse(local), b = parse(remote)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0
    if (y > x) return true
    if (y < x) return false
  }
  return false
}
```

### 7.4 逐段讲解

**① 为什么必须显式暂停，不能依赖「页面隐藏」**

这是 App 端和 Web 端最大的行为差异之一：

| | Web（H5） | App（uni-app 原生播放器） |
|---|---|---|
| 切后台 | 浏览器自动暂停媒体播放 | **不一定暂停**（原生层不完全跟随 WebView 生命周期） |
| 表现 | —— | 「看不到画面但声音还在响」/ 后台继续下载 |

所以 `onHide` 里的处理必须是「主动、显式」的：`stop()` / `pause()` / 取消下载。

**② 「记录播放位置」的必要性**

```ts
// 不记录位置：回前台从头开始播 → 用户看了一半的内容要重看
savedPositionMs = currentPosition.value
```

注意要**同时记录「切走前是不是在播放」**：

```ts
// ✗ 只记录位置
onShow(() => { playback.play() })      // 用户暂停后切走，回来自己播了

// ✓ 同时记录播放意图
if (wasPlayingBeforeHide) playback.play()
```

**③ 热更新的两条铁律**

| 铁律 | 原因 |
|---|---|
| **不阻塞启动** | 检查更新延迟 5 秒、失败静默 —— 更新是附加功能，不能让用户因为更新服务挂了而打不开应用 |
| **不做强制重启** | 安装成功后询问用户；用户正在看视频时强行重启是最差的体验 |

还有一条**必须知道的边界**：wgt **不能**更新原生部分。如果要加原生权限、换原生插件，必须整包发版。热更新只适合「业务逻辑与样式」的改动 —— 这个边界搞错会导致「更新推下去了但功能没生效」的诡异问题。

**④ 安全区域的两类元素**

```
安全区外（可以放）：视频画面本身、背景
安全区内（必须遵守）：所有交互元素 —— 点赞按钮、作者信息、底部导航、返回按钮
```

一个实际的判断方法：**任何需要手指点击的东西，都不能落在 `safe-area-inset` 覆盖的区域**（尤其底部手势条，系统会拦截从底部上滑的手势）。

### 7.5 面试会追问什么

**Q：`100vh` 在 App 端有什么问题？**
A：App 端的 `100vh` 通常等于屏幕物理高度（含状态栏），不减去系统栏。所以整屏视频容器需要配合安全区内边距，或者用 `uni.getSystemInfoSync()` 拿到可用高度后动态设置。这也是为什么不能照搬 Web 的写法。

**Q：wgt 热更新和 CodePush（React Native）是一回事吗？**
A：思路一样（下发 JS 资源包），但限制不同：uni-app 的 wgt 不能改原生部分；CodePush 也有类似的限制（不能改原生代码）。**关键共性**：热更新只解决「业务代码」，涉及原生的改动永远要走发版。

**Q：音频焦点被抢占时，你怎么知道是被抢占还是用户暂停？**
A：无法从 video 组件的事件直接区分。我们的近似做法是「是否有用户操作」—— 用 `userPressedPause` 标记用户是否主动点过暂停。这个近似方法有边界（用户点了暂停后又切走、被电话打断，会误判），但覆盖了绝大多数场景。

---

## §8 把上面都拼起来

```
┌─────────────────────── 用户看到的 ───────────────────────┐
│  推荐流（整屏竖向切换）· 互动层 · 个人主页 · 设置          │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  Pinia stores                                            │
│    feedStore         items / cursor / loadMore / 预取      │
│    interactionStore  点赞（乐观更新 + 幂等 + 去重）          │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  core/（业务逻辑）                                        │
│    media/  单实例播放注册表 · 状态机(gen) · 落点保护(150ms) │
│            预下载 · LRU 缓存(150MB/60条) · 孤儿清理          │
│    track/  曝光判定(75%) · 观看时长累计 · 批量上报队列       │
│    update/ wgt 热更新（版本比对 / 下载进度 / 失败回退）      │
└──────────────────────────┬───────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────┐
│  App 端平台能力                                           │
│    uni.video / downloadFile / 文件系统 / safe-area          │
│    onHide·onShow / plus.runtime（状态栏、热更新）           │
└──────────────────────────────────────────────────────────┘
```

**一次「用户双击点赞并继续下滑」的完整链路**：

```
① 双击（280ms 内两次点击）
      ↓
② useTapGesture 判定为双击、取消待执行的单击
      ↓
③ interactionStore.doLike：立即改 UI（心形动画 + 数字 +1）—— 乐观
      ↓
④ 幂等请求 api.like(id, true)（同一 item 有请求在飞则跳过）
      ↓ 成功
⑤ 用服务端返回的 likeCount 修正数字（可能别人也赞了）
      ↓
⑥ 用户继续下滑 → swiper @change → currentIndex 变化
      ↓
⑦ 落点保护：150ms 内不再变化才认为落定 → 创建新播放器
      ↓
⑧ 结算上一条的观看会话 → 上报（带 index + watchedMs + reason='switch'）
      ↓
⑨ 预取：距末尾 ≤3 条 → loadMore（带游标、去重、加锁）
      ↓
⑩ 预下载下一条（仅 WiFi）→ 落进 LRU 缓存
```

**注意整条链路上没有任何一步需要停下来等另一步** —— 播放器创建延后、埋点批量上报、预取异步进行，用户感知到的只有「立即出现的心形动画」。

---

## §9 面试追问清单

### 高频（这个项目最可能被问的）

1. **为什么不用播放器池？**（⭐ 最重要，必答）
   → uni-app 的 video 在 App 端落到原生播放器层，层级独立于 WebView、同一时刻只能有一个有效实例。播放器池「同时持有 7 个实例」的前提不成立，且会出现画面覆盖与双音。
2. **单实例方案下快速滑动怎么办？**
   → 落点保护（150ms）+ 预下载 + 封面图占位。代价从「内存」转移到「回滑体验」。
3. **三屏窗口为什么是 3？**
   → App 端同时只能有 1 个播放器，多出的屏幕只挂封面图。三屏保证当前项始终在中间（窗口移动时不销毁当前项）。
4. **索引映射怎么处理？**
   → 全局索引是业务真源，swiper 只认窗口内索引，两者显式转换；窗口移动放在 animationfinish（避免滑动中重建）。
5. **双击点赞为什么要延迟单击？**
   → 信息不足：第一下无法区分是单击还是双击的前半。单击必须等 280ms 窗口。缓解方式是「视觉反馈立即给，实际动作延后」。
6. **观看时长怎么算准？**（⭐）
   → 只累加 playing 状态的时长（不含暂停/加载/后台）；用 start + 累计增量而不是「进入-离开时间差」。
7. **曝光为什么用可见比例而不是渲染？**
   → 「渲染了」会把快速滑过的也计入，污染推荐样本。75% 是「铺满大部分屏幕」的判据。

### 中频

8. **为什么用游标分页？**
   → 推荐流每次请求重新排序，offset 会导致重复与漏项。游标是锚点，天然不会重复。
9. **为什么游标分页还要去重？**
   → 游标解决跨页重复，不解决重试重复与同页重复；且重复 id 会让列表 key 冲突、窗口定位错乱。
10. **播放状态为什么用状态机？**
    → 零散布尔量会出现非法组合（无声、重复播放）。显式状态机 + generation 丢弃过期事件。
11. **generation 是干什么的？**
    → 丢弃「上一轮播放」的迟到事件，防止旧事件覆盖新状态。和 AbortSignal 是同一类手法。
12. **音频被打断怎么区分？**
    → 无法直接区分，用「是否有用户操作」近似判断；只恢复「被动暂停」的。
13. **切后台要做哪些事？**
    → 显式暂停（不能依赖自动暂停）+ 记录位置 + 取消下载（不偷跑流量）+ 埋点落盘 + 最后一报。
14. **缓存上限怎么定的？**
    → 150MB / 60 条双阈值（体积防止大文件、条数防止文件过多）；参考同类产品的默认值区间。

### 能加分的

15. **wgt 热更新的边界是什么？**
    → 只能更新 JS/CSS/模板/静态资源，不能改原生部分。加了原生权限必须整包发版。
16. **为什么更新检查要延迟 5 秒？**
    → 不占用启动关键路径；更新服务挂了不能影响用户打开应用。
17. **100vh 在 App 端有什么坑？**
    → 不见得等于可用高度（含状态栏），要配合 safe-area 或动态计算。
18. **预下载为什么只预取 1 条？**
    → 覆盖最高频的「滑到下一条」场景；预取更多流量翻倍但收益递减；且默认只在 WiFi 下。
19. **图片为什么分 webp 和 jpg？**
    → 列表封面用 webp（省流量），详情大图用 jpg（解码更快）。webp 解码比 jpg 慢。
20. **为什么点赞接口要设计成幂等的 set 而不是 toggle？**（⭐）
    → 双击连点、网络重试都会重复发请求。toggle 语义下重放会翻转状态（赞→取消），set 语义下重复执行结果一致。

### 三条「不要吹」的红线

| ⚠️ | 说明 |
|---|---|
| **「我做过播放器池」** | 不要暗示做了原生播放器池 —— 本文档的整个 §2 就是在说这套方案在 uni-app 里不可行。承认这个约束并讲清替代方案，比假装做过更有说服力。 |
| **具体性能数字** | 内存省了多少 MB、帧率从多少到多少 —— 没真测过就别报。可以说「渲染量与列表长度解耦」这种结构性结论。 |
| **原生能力** | 弹幕、字幕、原生播放器优化这类超出一层框架能力的东西，说清「需要 subNVue 或原生插件」即可。 |

---

## 附：与 OLCT 文档的对照

两个项目都涉及 UniApp，但技术重心完全不同，面试时可以互相呼应：

| | OLCT（交易所） | Homo（短视频） |
|---|---|---|
| 核心矛盾 | **数据的实时性与正确性** | **媒体资源的生命周期** |
| 最难的点 | 订单簿的增量对齐 | 单实例播放器的约束 |
| 都用到的能力 | 多端适配、请求层、性能优化 | —— |
| 一个「用时间换空间」的取舍 | 合帧渲染（延迟渲染换 CPU） | 落点保护（延迟创建换内存） |
| 一个「必须显式」的状态管理 | 会话状态机（连接生命周期） | 播放状态机（播放生命周期） |

**两个项目都体现的同一套判断力**：**当框架/平台的约束让「标准做法」不可用时，不要硬套，而是找到「代价最小的替代方案」并说清代价是什么。** 这句话是这两个项目在面试里最值得传达的东西。
