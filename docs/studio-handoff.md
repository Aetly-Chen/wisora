# 新工作台（studio）交接说明

> 给「补逻辑」用的地图。**这里只描述 UI 现状与缺口**，不含业务实现。
> 代码位置：`frontend/src/pages/studio/`

---

## 1. 它是什么

`/` 现在指向这个页面。四栏：活动栏 44 · 左栏 268 · 中栏自适应 · 右栏 Agent 384 · 状态栏 26。

**当前状态：纯 UI 骨架。** 数据全部是常量，交互只有本地 `useState`。

```
pages/studio/
├── index.tsx                 页面 + 三张列表 + 四种视图 + 活动栏 + 状态栏
└── components/
    ├── KnowledgeTree.tsx     SVG 极坐标知识树（悬停预览 / 点击展开）
    └── StarSea.tsx           空库的 canvas 星海动画
```

---

## 2. 要补的数据（4 处）

全部在 `index.tsx` 顶部，搜索 `MOCK_` 就能定位。每处都写了 `TODO`。

| 常量 | 换成什么 | 建议字段 |
|---|---|---|
| `MOCK_NOTES`（第 31 行） | 笔记树 | `{ id, title, parentId, updatedAt }`，映射成 `TreeNode` |
| `MOCK_FILES`（第 47 行） | 文件列表 | `{ id, name, size, kind }`，`kind` 决定图标（text / image / file） |
| `MOCK_THREADS`（第 57 行） | AI 会话列表 | `{ id, title, at }` |
| `MOCK_DOC`（第 65 行） | 当前笔记正文 | `{ title, meta, body }`，`body` 里 `**xx**` 目前渲染成高亮 |

另外一处不是数据而是状态：

```ts
const isEmpty = false;   // 第 136 行，TODO：换成 notes.length === 0
```

> `KnowledgeTree` 只依赖本地 `TreeNode` 类型（`{ id, title, parentId, updatedAt }`），
> 不与任何后端 DTO 绑定 —— 你想怎么映射都行。

---

## 3. 要补的交互（4 处）

| 位置 | 现状 | 缺什么 |
|---|---|---|
| 左栏 `文件/对话/笔记` 列表项 | 只有 hover 样式 | 点击 → 取数据 / 打开内容 |
| 知识树节点 | 展开/收起、点叶子调 `onOpen` | `onOpen` 里只改了本地视图，没取正文 |
| 右栏 Agent | 静态两条消息 | 发送、流式接收、上下文注入 |
| **移动端抽屉** | 点列表项后抽屉不关 | 选中后 `setDrawer(null)`（窄屏） |

移动端相关：`isNarrow` / `drawer` 两个状态就是全部移动端逻辑，`drawer` 取 `'left' | 'right' | null`。

---

## 4. 样式令牌

颜色写死在 `index.tsx` 的 `COLORS` 常量里（没走 Tailwind 主题），改一处全站生效：

| 键 | 值 | 用途 |
|---|---|---|
| `bg` | `#fbfcfe` | 页面底 |
| `panel` | `#ffffff` | 中栏 / 右栏卡片 |
| `panel2` | `#f5f8fb` | 左栏 / 活动栏 / 状态栏 |
| `ink` | `#1a1f26` | 主文字 |
| `ink2` | `#4a5462` | 次级文字 |
| `ink3` | `#8892a0` | 弱文字 / 图标 |
| `line` | `#e7ecf2` | 分区线 |
| `line2` | `#f0f4f8` | 更淡的分隔线 |
| `accent` | `#3d6ea8` | 强调（选中条、树高亮、chip） |
| `accentSoft` | `#e9f1fb` | 强调底 |

⚠️ 这几个值**只在这个文件里**，没有进 `index.css`。
`KnowledgeTree` / `StarSea` 里的颜色是独立写死的（`#8b96a4`、`#3d6ea8`、`#9aa6b6`），改主题时要一起改。

---

## 5. 分栏（VS Code 式）

两条分隔线、左侧可收起，全部是 UI 行为，**不涉及业务逻辑**，你补数据时不用管它。

| 行为 | 细节 |
|---|---|
| 拖动左/右分隔线 | 4px 热区，实时跟手；`↔` 光标 |
| 上下限 | 左 200–480、右 320–620；**动态收紧**保证中栏 ≥ 360 |
| 双击分隔线 | 恢复默认（268 / 384） |
| 收起左栏 | 头部右上角 `PanelLeftClose`；收起后中栏顶栏出现 `PanelLeftOpen` |
| 持久化 | `studio:left` / `studio:right` / `studio:leftCollapsed` |

### 两个实现约定（改代码时别破坏）

1. **拖动中只改 CSS 变量**（`--left` / `--right`），松手才 `setState` + 写 localStorage。
   如果改成每帧 `setState`，整棵子树（含 SVG 知识树）会重渲染，手感立刻变差。
2. **拖动时有一层 `absolute inset-0 z-10` 的透明遮罩**，用来吞掉指针事件
   （否则掠过 canvas / iframe 会丢事件）。它低于分隔线（`z-20`），高于内容。

### 与移动端的关系

`<768px` 时**分隔线不渲染**，左栏走抽屉（见下一节）；`leftCollapsed` 状态会被忽略，
切回宽屏再按原值生效。别把两套机制合并，抽屉是覆盖式、分栏是挤压式。

## 6. 响应式

断点：**`max-width: 767px`**（`matchMedia`，不是 Tailwind 断点）。

| 宽度 | 布局 |
|---|---|
| ≥ 768 | 四栏 `44 / 268 / 自适应 / 384` |
| < 768 | 两栏 `44 / 自适应`；左栏 280px 抽屉、右栏 `92vw`(max 420) 抽屉，均带遮罩与 ✕ |

窄屏下知识树整体 `scale(1.55)` —— 因为 SVG 等比缩放会把标签压到约 6px。
实测 504px：`44px 460px`、无横向溢出、7 个节点 0 个越界。

⚠️ 本机 headless Chrome 窗口宽度下限约 500px，**390px 没实测过**。

---

## 7. 不要动的地方

- **活动栏**：`/` 是工作台本身（`aria-current="page"`），聊天走 `/chat`（独立模块），设置走 `/profile`
- **遮罩层级**：抽屉 `z-40`、遮罩 `z-30`，反了会导致点不中抽屉
- **状态栏**：`gridColumn: '1 / -1'`，删了会破坏四栏网格
- `index.tsx` 里没有 store、没有请求、没有登录态读取 —— 补逻辑时建议保持「页面只管编排，数据走 hooks」
- **分栏的三条约束**：拖动只改变量、遮罩层级（线 20 / 遮罩 10）、中栏最小 360 —— 见上一节
- 分隔线的拖动高亮是石墨灰 `#4a5462`，不是 VS Code 的蓝；这是刻意的，别「修回去」
