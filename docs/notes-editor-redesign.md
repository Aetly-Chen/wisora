# 笔记模块改版：向 Typora / Notion 看齐

> 2026-10-22。**这是选型与设计文档，不含实现**。
> 依据：GitHub 检索 + npm registry 实测 + 本仓库现状核对。

## 0. 结论先行

**推荐走 Typora 路线（Milkdown），不走 Notion 块编辑路线（BlockNote / Plate）。**

理由只有一条但很硬：**你的笔记正文是 Markdown 字符串，而 RAG 切块和 AI 工具都直接依赖这个格式。**

- `backend/src/rag/chunk.ts:44` —— `const heading = /^#{1,4}\s+(.+)$/.exec(line);`
  切块按 Markdown 标题分节。正文一旦变成块 JSON，**索引整条链断掉**
- AI 工具的 `write_my_note` / `update_my_note` 按 Markdown 文本读写，
  `search_my_notes` 的召回质量也建立在分块之上
- 导入（`frontend/src/lib/import-note.ts`）、分享、导出，全都以 `.md` 为契约

块编辑器要把内容转成 block JSON 才能编辑，保存时再转回 Markdown（**lossy**）。
多一层转换 = 多一类"编辑一次、格式就漂一点"的 bug，而且 RAG 与 AI 都要跟着改。
**为了 Editor 的手感，去动数据模型和检索链 —— 代价不成比例。**

---

## 1. 现状（核对过的，不是推测）

| 项 | 现状 | 位置 |
|---|---|---|
| 编辑方式 | 裸 `<textarea>` 写 Markdown | `pages/notes/index.tsx:1010` |
| 预览 | 右栏 `marked` + `DOMPurify` 渲染 | `components/MarkdownView.tsx` |
| 分屏 | `edit` / `split` / `preview` 三态 | 同文件 `mode` state |
| 大文档 | >100k 字符停止实时预览 | `PREVIEW_MAX_CHARS = 100_000` |
| 自动保存 | **已有**，`saving/saved/error` 三态 | `SAVE_LABEL` + `saveState` |
| 编辑器依赖 | **无**（只有 `marked` / `dompurify`） | `package.json` 实测 |
| 代码组织 | **单文件 1287 行** | `pages/notes/index.tsx` |

**能力缺口**（对照 Typora / Notion）：
无语法高亮、无表格可视化编辑、无斜杠命令、无块拖拽、无大纲、无快捷键、
无图片粘贴插入、任务清单不可勾选、公式/图表不支持。

---

## 2. GitHub 检索结果

按 star 排序，都是实测数字（2026-10-22 查询）：

| 方案 | Stars | 底层 | 内容模型 | React 19 | 定位 |
|---|---|---|---|---|---|
| **TipTap** `ueberdosis/tiptap` | **38.8k** | ProseMirror（无头） | 自己定（有 markdown 扩展） | ✅ 3.32.0 peer 含 ^19 | 造轮子的底座 |
| **Plate** `udecode/plate` | **16.6k** | Slate | 块 JSON（有 markdown 插件） | ✅ 49.0.0 peer `>=18` | Notion 式 + shadcn/ui |
| **Milkdown** `Milkdown/milkdown` | **12.0k** | ProseMirror + remark | **Markdown 原生** | ✅ 7.22.3 无 peer 限制 | **Typora 式** |
| **BlockNote** `TypeCellOS/BlockNote` | **10.3k** | TipTap / ProseMirror | 块 JSON（带 md 导入导出） | ✅ 0.56.0 peer 含 ^19 | Notion 式开箱即用 |
| **Yoopta** `yoopta-editor/Yoopta-Editor` | 3.1k | Slate | 块 JSON | 未核 | Notion 式轻量 |
| *AFFiNE* `toeverything/AFFiNE` | 73.7k | BlockSuite + CRDT | 二进制 | —— | **产品参考，不可复用** |

> 未收录：Novel（Next.js 起手的 AI 写作模板，偏 demo）、Vditor（非 React 原生）、
> Editor.js（HTML/JSON 模型，Markdown 支持弱）、SunEditor（传统富文本，非 Markdown）。
> AFFiNE 是产品级参考 —— 它的"文档 + 白板 + 数据库"三态值得看，但 BlockSuite 抽不出来用。

### 2.1 两条路线本质不同（这是选型的关键）

| | Typora 式（Milkdown） | Notion 式（BlockNote / Plate） |
|---|---|---|
| 心智 | **一个文档**，源码与渲染合一 | **一堆块**，每块是独立对象 |
| `# ` 输入 | 立刻变成大标题 | 变成 Heading 块 |
| 存储 | 还是那段 Markdown | 块的 JSON 树 |
| 块拖拽 | 无（或很弱） | 核心能力 |
| 协同 | 可行但要另加 | 天生适合（块 ID） |
| 与你的后端 | **零改动** | 要转格式，且转换 lossy |

---

## 3. 页面应该长什么样

```
┌────────────┬──────────────────────────────────┬────────────┐
│ 笔记树      │  面包屑：前端笔记 / 课程 3         │  大纲       │
│（现有）     │  ─────────────────────────────   │  ## 异步    │
│            │                                  │  ## 事件循环 │
│ ▾ 前端提升  │  第三课：异步编程                  │  ## 宏任务   │
│   ▸ 课程 1  │                                  │            │
│   ▾ 课程 3  │  正文（所见即所得）                 │            │
│     Promise │  ┌────────────────────────────┐  │            │
│     定时器   │  │ 代码块 · 语法高亮 · 复制按钮 │  │            │
│            │  └────────────────────────────┘  │            │
│            │                                  │            │
│            │  已保存 ✓          1,240 字       │            │
└────────────┴──────────────────────────────────┴────────────┘
```

要点：

1. **编辑区单栏居中**，正文阅读宽度约 **720px**（不是全宽）——
   全宽长行读起来很累，这是 Typora / Notion 共有的决定
2. **不再左右分屏**。分屏的本质是"你不信任渲染结果"，所见即所得之后这个诉求消失；
   需要看源码时用 **`Ctrl+/` 切源码模式**（保留逃生通道）
3. **大纲右栏**按 `##` 生成，点击跳转 —— 你的笔记层级深、篇目长，这个比什么都实用
4. **顶部一条细状态栏**：面包屑 + 保存态 + 字数，不要做成工具栏（会占地方）
5. **移动端**沿用聊天页的做法：树与编辑是**两个整屏视图**，不叠遮罩

---

## 4. 功能清单（按优先级，不是按难度）

### P0 · 不做就等于没改

| 功能 | 说明 |
|---|---|
| 所见即所得 | 核心。输入 `# ` `- ` `> ` ` ``` ` 即时成型 |
| 源码 / 预览切换 | `Ctrl+/`。给"我要精确控制"的时刻留出口 |
| 代码块 | 语法高亮（按语言）+ 复制按钮 + 语言选择 |
| 表格 | 可视化增删行列；Tab 在单元格间跳 |
| 任务清单 | `- [ ]` **可点击勾选**（现在是死文本） |
| 图片 | 粘贴 / 拖入 → 走现有附件上传 → 插入 `![](url)` |
| 快捷键 | `Ctrl+B/I/K`、`Ctrl+S`、`Tab/Shift+Tab` 缩进、`Ctrl+Z` 撤销 |
| 大纲 | 右栏，`##` 级，当前小节高亮 |

### P1 · 让它像个正经笔记软件

| 功能 | 说明 |
|---|---|
| 斜杠命令 `/` | 插入标题 / 列表 / 表格 / 代码 / 引用 / 分割线 |
| 公式 | KaTeX，`$...$` 与 `$$...$$` |
| 图表 | Mermaid 代码块渲染 |
| 双向链接 | `[[笔记标题]]` → 跳转 + 反链面板 |
| 查找替换 | `Ctrl+F`，带高亮 |
| 专注模式 | 打字机滚动 / 只高亮当前段 |

### P2 · 想清楚再做

| 功能 | 判断 |
|---|---|
| 协同编辑 | Yjs + 块 ID。**先别做** —— 单人工作台，收益远低于成本 |
| 版本历史 | 依赖后端加表，值得单独排期 |
| AI 行内补全 | 已有 Agent，但行内补全和对话是两套交互，别混 |

---

## 5. 选型：Milkdown 怎么用

```bash
# 只装需要的，别整包
pnpm add @milkdown/core @milkdown/react @milkdown/preset-commonmark \
         @milkdown/plugin-listener @milkdown/plugin-history
```

- **`@milkdown/preset-commonmark`** 覆盖标题/列表/引用/代码/分割线
- 表格、任务清单、数学、Mermaid 各自是独立 preset/plugin —— **按 P0/P1 分批装**
- 序列化：Milkdown 的文档树 ↔ Markdown 由 remark 双向转换，**存下来的仍是 Markdown 字符串**
- 值同步：用 `listener` 插件监听 `markdownUpdated`，debounce 后写回现有 `editContent`

> ⚠️ **依赖安装纪律**（这个仓库踩过三次）：**不要 `pnpm add` 直接装**，
> 项目里顶层链接缺失时用 junction 补；补 lockfile 用 `--lockfile-only`。
> 具体见项目 `MEMORY.md`。

### 为什么不选其他

| 方案 | 不选的理由 |
|---|---|
| **BlockNote** | 手感最像 Notion，但内容模型是块 JSON。要额外做 md↔blocks 双向转换，**转换是 lossy 的**，且 RAG 切块会退化。0.x 版本 API 还在变 |
| **Plate** | 生态最贴（shadcn/ui + React 19 + Tailwind 4），但 Slate 的块模型同样要转格式；插件体系重，学习成本高 |
| **TipTap** | 最灵活也最费事 —— 表格、任务清单、代码高亮、斜杠菜单全要自己写。**选它就等于自己造一个 Milkdown** |
| **Yoopta** | 星数少一个量级，长期维护风险 |

**如果哪天真要做 Notion 那种块拖拽/嵌套数据库**，那是一次**数据模型迁移**，
应该单独立项，而不是顺手在笔记模块里换编辑器。

---

## 6. 落地顺序（建议）

| 步 | 内容 | 验收 |
|---|---|---|
| 1 | 拆文件：1287 行 → `NotesTree` / `NoteEditor` / `AttachmentsPanel` / `NoteToolbar` | 行为不变，`tsc` 过 |
| 2 | 接入 Milkdown 替换 textarea，先只上 commonmark preset | 能写能存，**Markdown 字节不变** |
| 3 | 接 `markdownUpdated` → debounce 写回 + 保留 saveState | 关掉页面再开，内容一致 |
| 4 | P0 剩余：代码高亮、表格、任务清单、图片粘贴 | 逐项真机验证 |
| 5 | 大纲栏 + 快捷键 | —— |
| 6 | P1 按需 | —— |

**第 2 步的验收标准要写死：**用同一篇笔记，编辑前后 `content` 字符串完全一致（或者只有
空行差异）。**格式漂移是这类改造最容易埋的雷**，必须在接入当天就锁住。

---

## 7. 必须注意的坑

1. **深色模式**：Milkdown 自带主题是独立的，要改成吃 `index.css` 的令牌，
   否则和 shadcn 的 `:root` 打架（这个项目在 Tailwind v4 上踩过同类问题）
2. **`marked` 别急着删** —— 聊天消息卡片的笔记预览、分享出去的内容还在用它
3. **大文档性能**：现在是 >100k 字符关预览；换成编辑器后要重新测，
   ProseMirror 处理 100k+ 字符会明显卡，可能需要"只渲染可视区"或分段加载
4. **移动端输入法**：中文候选词弹出时 `Enter` 会被当成换行，需要 `isComposing` 判断
   （聊天页 `Composer.tsx` 已经处理过这个坑，可以抄）
5. **不要在组件内部定义子组件** —— 这个仓库的既有规矩，编辑器相关组件尤其容易犯

---

## 8. 参考

- Milkdown：https://github.com/Milkdown/milkdown
- Typora 式的产品参考（Milkdown 做的）：`SimonShiki/Typability`、`oratis/Markup`
- Notion 式（备选）：https://github.com/TypeCellOS/BlockNote
- 产品级功能参考：https://github.com/toeverything/AFFiNE

---

## 9. 实现踩坑（落地实测记录）

> 这一节记的是**真的踩过、并且靠实测才定位到**的坑。改动编辑器这块之前先读一遍 ——
> 其中一半是「编译通过、控制台干净、功能却没生效」的类型。

### 9.1 序列化：只能 `ctx.update`，不能 `ctx.set`

```ts
// ✅
ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, bullet: '-', rule: '-' }));
// ❌ 会把默认值里的 handlers（节点→mdast 映射）与 encode: [] 一起冲掉
ctx.set(remarkStringifyOptionsCtx, { bullet: '-', rule: '-' });
```

`ctx.set` 的后果不是报错，而是**代码块退化成缩进式、表格和图片直接序列化失败**。

不设这两项的话，remark 会把 `- ` 输出成 `* `、`---` 输出成 `***` —— 渲染等价，但
**所有存量笔记在第一次编辑后会被整体改写一遍**，看着像被动了手脚。

### 9.2 代码高亮：用 refractor，不要 prismjs

prismjs 的语言包是 `(function (Prism) {...}(Prism))` 形式的 IIFE，读**全局** `Prism`；
而核心 `prism.js` 是个普通 IIFE，**不会**把 Prism 挂到 window。在 Vite 里
`import 'prismjs/components/prism-typescript'` 直接 `Prism is not defined`。

refractor 是同一套算法的 ESM 版，也正是 `@milkdown/plugin-prism` 内部用的 ——
两侧共用同一实例，语言只注册一次。

- **jsx / tsx 不在 refractor common 的 30 种语言里**，而这俩是前端笔记里出现频率最高的。
  插件用 `listLanguages().includes(lang)` 判断，命中不了就 `console.warn` ——
  一篇笔记十几个 ` ```vue ` 就是十几条警告刷屏。
- `vue` / `node` / `mjs` / `console` 要 `refractor.alias` 补；
  **补之前必须确认源语言已注册**，否则会往 languages 里塞 `undefined`，highlight 直接崩。

### 9.3 额外 DOM 只能走 NodeView

代码块的 DOM 由 ProseMirror **全权重渲染**，手动 `appendChild` 进去的节点下一次
re-render 就没了。`editorViewOptionsCtx.nodeViews` 是唯一能稳定持有额外 DOM 的位置。

- `contentDOM` 必须指向 `<code>`，否则 Prism 的 inline decoration 落在
  `pre` 上会连带把按钮文字也高亮进去
- 复制按钮要读 `code.textContent`，**不能读 `pre.textContent`** ——
  按钮自己的「复制」两个字也是 `pre` 的子节点

### 9.4 gfm 的实际 DOM 结构：`li > p`，不是 `li > span`

旧 CSS 写的 `li[data-item-type='task'] > span::before` **从来没匹配上过** ——
任务清单前面的方框一直是空的（只有 `list-style: none` 生效），而且不报任何错。

**修饰第三方组件的内部结构之前，先把 `outerHTML` 打出来看。**

任务勾选的实现：方框是 `p::before`，在 `p` 的**内容区最左边**（不是 `p` 外面），
宽 13px + `margin-right: 0.5em` ≈ 19px，所以判定条件是
`clientX` 落在 `p.left` ~ `p.left+19` 才算点方框，右边一律交回 ProseMirror 放光标。

⚠️ `handleClick` 返回 `true` 会阻止浏览器默认聚焦，必须补一次 `view.focus()`，
否则勾完再打字输不进去。

### 9.5 表格：别用 gfm 的 `*Command`

gfm 导出了 `addRowAfterCommand` 这些，但**没有删行删列** —— 只给
`selectRowCommand` + `deleteSelectedCellsCommand`，两步 dispatch 之间选区已经变了，
很容易删错行。

用 `@milkdown/prose/tables` 的 prosemirror-tables 命令：
`(state, dispatch, view) => boolean`，一次 dispatch 完事。

- ⚠️ 工具条按钮的 `onMouseDown` **必须 `preventDefault`** —— 否则焦点移走、选区丢失，
  命令找不到「当前单元格」，表现是「点了没反应」
- 判断「光标在表格内」用插件的 `view().update` 比选区，**不要用 `handleDOMEvents`**：
  键盘移动光标不触发 DOM 事件
- ⚠️ `@milkdown/prose/tables` 是**裁剪版**（`grep -c columnResizing` = 0），
  没有 `columnResizing` / `TableView` → **列宽拖拽做不了**，除非引 `@milkdown/components`
  并重写整套表格样式
- 插入表格走 `insertTableCommand({ row, col })`；gfm 另有个隐藏输入规则
  `/^\|(\d+)[xX](\d+)\|\s$/`（打 `|3x2| ` 直接建表），但没人猜得到，所以还是做了按钮

### 9.6 图片：`attachment:<id>` + 三个静默失败点

正文里存 `attachment:<id>`（永久有效），**绝不存签名 URL**（1h 过期）。
渲染时再换直链，缓存见 `frontend/src/lib/attachment-url.ts`。

三个都会「没反应但也不报错」的点：

1. **`DataTransferItemList` 不是可迭代对象** —— `[...clipboardData.items]` 在 Chrome
   抛 `is not iterable`，异常冒到 ProseMirror 的 paste 处理里被吞掉 →
   「粘贴毫无反应、控制台干净」。必须 `Array.from`。
2. **`image` 节点的 `title` 必须是 string** —— 传 `null` 抛
   `Expected value of type string for attribute title on type image`，
   被 `try/catch` 接住后只弹一个 toast，不翻代码猜不到是哪一步。
3. **DOMPurify 会吃掉 `attachment:` 协议**（默认只放行 http/https 等）——
   要在 `ALLOWED_URI_REGEXP` 里追加，否则图片在渲染阶段就被删掉，
   后面的 hydrate 连目标都找不到。

⚠️ 链路某步静默失败时，**加 `window.__xxxProbe` 阶段标记**去 `eval` 读
（`console.log` 在 CDP 里读不到）。探针用完删。

图片独占段落：`replaceSelectionWith` 会把图塞进当前文本块末尾（正文里变成
「正文结束。![](...)」糊在一行）→ 插入前先 `tr.split($from.pos)`（仅当当前块非空）。

### 9.7 导出 .md：图片必须内联 base64

`attachment:<id>` 离开后端只是一段无意义的字符串，签名 URL 1h 就过期 ——
两者都会让导出的文件「图全裂」。

正确做法：导出时把每张图取回来转成 `data:image/png;base64,...` 内嵌。
体积 +33%，换「在 Typora / GitHub / 任何编辑器里都能直接看」。
取图失败时**保留原始 `attachment:<id>`**，不要静默丢掉。

验证下载内容：**hook `URL.createObjectURL` 截获 Blob 读 `.text()`**，
比设下载目录再读文件可靠。

### 9.8 一个纯前端验证手法

后端起不来时，`cdp.mjs mock` 可以喂固定 fixtures 走完整链路（响应信封
`{code,msg,data}`，2xx 即成功）。够验证编辑器、拖拽外的绝大多数交互。


---

## 10. P1 进度

| 功能 | 状态 | 落点 |
|---|---|---|
| 斜杠命令 `/` | ✅ 2026-11-01 | `lib/slash.ts` + `components/SlashMenu.tsx` |
| 公式 KaTeX | ✅ 2026-11-04 | `lib/math.ts`（行内 `$…$` + 块级 `$$…$$`） |
| 图表 Mermaid | ✅ 2026-11-04 | `lib/mermaid.ts`（装饰实现，源码可编辑） |
| 双向链接 `[[]]` | ✅ 2026-11-05（v1） | `lib/wikilink.ts` + `GET /notes/:id/backlinks`（§11） |
| 查找替换 `Ctrl+F` | ✅ 2026-11-01 | `lib/find.ts` + `components/FindBar.tsx` |
| 专注模式 | ✅ 2026-11-02 | `lib/focus.ts` + `NoteEditor` 工具条 |

### 10.1 斜杠命令的触发规则（别放宽）

只看**空选区 + 段落 + 光标在段末 + 内容以 `/` 开头 + `/` 后无空白**。
最后一条是硬约束：正文里写路径（`/usr/bin`）很常见，一旦允许空格，
每写一个路径都会弹菜单。

菜单用 `position: fixed` 定位（坐标来自 `coordsAtPos`，视口坐标系），
所以**滚动时必须关掉**——监听要挂在编辑器外壳上，**不能挂 window + capture**：
那样菜单内部列表的 `scrollIntoView` 也会冒到 window，键盘一按菜单就自己关了。

### 10.2 专注模式的两个效果都在「观感层」

只做两件事，都不碰文档：

1. **块级淡化**：`Decoration.node()` 给光标所在的**顶层块**加 `.focus-block`，
   CSS 把 `.ProseMirror > *` 压到 `opacity: .28`、把 `.focus-block` 拉回 1。
   用透明度而不是改文字颜色，是因为色阶一旦写死就会和标题/引用/代码块各自的
   字号颜色打架，淡下去之后对比度也不够。
2. **打字机滚动**：`keepCaretInBand()` —— 光标离开容器高度 22%~62% 的区间时，
   把 `scrollTop` 调到让光标回到 38% 处。

几个容易踩的点：

- **开关是 ref，不是布尔捕获**。插件在 `useEditor` 里只创建一次，`isEnabled`
  必须是 `() => focusModeRef.current`，否则开关永远读的是初始值。
- **切开关要补一个空事务**。装饰是「按 state 算」的，没有事务就不会重算，
  切过去的第一帧会变成「全部淡化但没有高亮」。`tr.setMeta('focus-mode', on)`
  即可；实测不进撤销栈，也不触发 `markdownUpdated`（doc 没变，库里的
  `updatedAt` 未变）。
- **不要用 `scrollIntoView`**：它把整块顶到顶部，长段落等于跳页；诉求是
  「细碎地跟着走」，所以直接算 `scrollTop` 增量。
- **点击同一个位置不会触发滚动**（`prev.selection.eq` 提前 return）。这是有意
  为之：selection 没变就没有重算的必要。**验证时别拿同一个坐标点两次**，
  否则会得出「滚动失效」的错误结论（2026-11-02 验收时踩过一次）。
- **文末有物理上限**：滚到 `maxScroll` 后光标到不了 38%，此时停在视口底部
  属正常。想让文末也居中，得给编辑器补底部 padding，那是另一个决定。

### 10.3 公式：官方没发布插件，四处坑都得自己躲

`@milkdown/plugin-math` 停在 7.5.9，与 core 7.22 的 ctx 不兼容。crepe 的
latex feature 也是自己拼的，所以照它的路子做：`remark-math` 出 mdast 节点、
`$node` 建两个 atom、**在 `toDOM` 里调 `katex.render`**。

1. **别用 `$view` 做渲染。** `$view` 的注册发生在 `await ctx.wait(SchemaReady)`
   之后，而 EditorView 构造时读的是当时的 `nodeViewCtx` 快照；两者是并行 handler，
   谁先完成不定。实测 7.22 上必输，症状极具误导性：节点**是** math 节点（属性、
   KaTeX 的 `data-*` 都对），DOM 却是纯文本 —— 因为没有 NodeView 就回落到 `toDOM`。
   写 NodeView 之前先想清楚这一点。
2. **序列化侧的 `addNode` 是三参数 `(type, children, value)`，不是解析侧的
   `(type, attrs, content)`。** 把 attrs 塞在第二参会被当成 children 去 `reduce`，
   抛 `children.reduce is not a function` —— 整个编辑器**挂载失败**，白屏只留在
   控制台里，页面上看是「编辑模式但没有任何输入区」。
3. **必须给 `$…$` 配 input rule，否则用户造不出公式。** remark-stringify 会把
   手打的 `$` 转义成 `\$`（remark-math 把 `$` 加进了 unsafe 字符集），存进库是
   `\$y^2\$`，再打开就不是公式了 —— 实测确认。所以入口只能是 input rule：先变成
   atom 节点，再由我们自己的 handler 序列化成 `$y^2$`。`inCode` 默认 false，
   代码块里打 `$` 不会误触发。

4. **input rule 的 handler 里看不到刚输入的文字。** `state` 是**插入前**的状态，
   所以「整段等于 `$$…$$`」这种校验不能用 `parent.textContent` 去比 —— 那时段落
   还是空的，比较永远不相等，规则静默失效（真机验的时候踩了一次，输进去的
   `$$…$$` 原样留成纯文本）。要判断「从段首开始」就用位置：
   `start === state.doc.resolve(start).start()`。

**块级公式的入口也是 input rule**：段首打 `$$…$$`，整段只有它时转成 `math_block`。
行内规则要加一道保险 —— 段首是 `$$` 就 return null，否则输 `$$x$$` 的过程中
敲到第三个 `$`（文字是 `$$x$`）会被行内规则先抢走，块级公式永远输不完。

**已知没做的**：块级公式转成 atom 后不能再改内容（和行内公式同一个取舍），
要改就选中删掉重打。想「边写边渲染」得像图表那样走装饰，那是另一个决定。

### 10.4 图表：走装饰，不走节点

` ```mermaid ` 代码块 → 代码块**下方**渲染一张图。三条都是被逼出来的：

1. **不能用自定义 atom 节点 + toDOM**（公式那套）：atom 里打不了字，而图表
   必须能改源码，否则改一个箭头都要重写整块。
2. **也不能用 NodeView**：`$view` 有注册竞态（见 10.3 坑 1），而图表恰恰需要
   一个「源码 + 预览」的复合结构。
3. 所以用 **ProseMirror 装饰**：`code_block` 原样保留（Markdown 契约还是
   ```mermaid 围栏），在块末尾挂一个 widget 显示渲染结果。源码照常编辑，
   每次 doc 变化重算装饰、预览跟着重画。副作用是「编辑器里能直接看到图，
   但文档结构里没有第二个节点」，导出/序列化不需要任何特殊处理。

两个实现细节：

- **渲染任务必须按 DOM 排队**。用一个 `pending` 变量存「待渲染的那一个」时，
  一篇笔记里有两张图，后一张会把前一张顶掉 —— 前一张永远停在「正在渲染图表…」
  （实测如此）。用 `Map<HTMLElement, code>` 攒起来，一次 flush 全渲染。
- **按源码缓存 SVG**。装饰每次事务都重建，widget 的 DOM 也是新的；命中缓存就
  同步填好，只有源码真的变了才排队重画，否则每敲一个字都要跑一次 mermaid。

错误处理：语法错落在预览面板里（红底 + 首行信息），编辑器不受影响；mermaid
渲染失败会往 body 留一个临时容器（`#d<id>`），要自己 remove 掉。


## 11. 双向链接 `[[标题]]`（v1：纯文本 + 读取时现算）

正文里写 `[[标题]]`，编辑器把它渲染成一个可点的引用；反过来，被引用的那篇
底部的「反向链接」区列出所有引用它的笔记。

### 为什么不是链接表

两种做法都能用，这里刻意选了**不建表**的那种：

| | 链接表（抽取 `NoteLink`） | 现算（v1 采用） |
|---|---|---|
| 数据 | 保存时抽 `[[…]]` 落表 | 正文就是唯一真相 |
| 迁移 | 要加表、要回填存量笔记 | 零迁移 |
| 一致性 | 表可能和正文不同步（漏跑/失败） | 不可能不同步 |
| 查询 | 走索引，快 | 按标题 `contains` 扫同用户的笔记，O(笔记数) |
| 改名 | 可以重写引用 | **旧引用直接断**（变成「悬空链接」样式） |

个人笔记量级（几百篇）扫一遍毫秒级，所以先要「不可能不同步」这条；
等到需要「按 id 稳定引用 / 改名自动重写 / 块级引用」时再上链接表，
那时正文语法也得跟着变（`[[标题|别名]]`、`[[#块]]`），是另一次决定。

### 实现

- **渲染**：`lib/wikilink.ts`，装饰（`Decoration.inline`）给 `[[…]]` 加 class，
  纯文本一个字都不动 —— 导出 `.md`、RAG 切块、AI 工具读到的还是 `[[标题]]`。
  解析不到同名笔记的挂 `--missing` 样式（琥珀色），点击不跳转、保留编辑光标。
- **点击**：`props.handleClick` 从点中的装饰 `span` 上取文本还原标题，
  比用 `pos` 反推更稳。找不到就返回 false，让 ProseMirror 走默认行为。
- **反向链接**：`GET /notes/:id/backlinks`，用 `[[当前标题]]` 扫同用户未删除的笔记，
  返回 `{ id, title, updatedAt, snippet }`；面板只在有引用时出现（`BacklinksPanel`）。
- **`[[` 自动补全**：`createWikilinkSuggestPlugin` 判定「光标前是 `[[…`」并给出锚点，
  菜单直接复用 `SlashMenu`（把它泛化成吃 `{key,label,hint}`），
  ↑/↓/Enter/Tab/Esc 的接管与斜杠命令同构；选中后把整段 `[[query` 换成 `[[标题]]`。
  候选排除当前笔记、按「前缀命中优先」排、最多 8 条。

### 三个坑

1. **装饰的文档位置不加 1**。`doc.descendants` 回调里文本节点的 `pos` 就是
   第一个字符的位置（`pos + i` 才是第 i 个字符）；加了 1 会整体右移一格，
   表现为 chip 少吞一个 `[`、多吞后面一个标点（真机验的时候一眼看到）。
2. **`contains` 是 LIKE**。标题里带 `%` / `_` 会被当通配符，所以先粗筛、
   再在 JS 里 `content.includes(needle)` 精确比对一次；摘要里的 Markdown 记号
   （`#`、`-`）也要剥掉，否则列表里第一眼看到的是 `# 标题`。
3. **序列化会把 `[[` 转义成 `\[\[`** —— 这条是**写完功能之后才发现的**，影响最大：
   remark-stringify 把 `[` 当链接起点，一律保守转义。读回来没问题（反解析还原成
   `[`，chip 照常渲染），但库里存的是 `\[\[周报]]`，而反链是按
   `content.includes('[[标题]]')` 匹配的 → **用户自己打的链接永远不出现在反链里**。
   之前没发现是因为验收数据是直接 SQL 写进库的（绕过了序列化，走了读路径而非写路径）。
   修法：`markdownUpdated` 里先 `unescapeWikilinks()`（`split('\\[\\[').join('[[')`）
   再交给 store；已有内容下次保存会自动修好。
   ⚠️ 这个还原**别写成正则字面量**：模式里「反斜杠 + `[`」要写成三个反斜杠，
   落到文件里很容易被某层转义吃掉一个，变成非法正则（`Unmatched ')'`），
   整页白屏且只有打开笔记才暴露。用普通字符串最稳。

### 还没做

- 改名不重写引用（见上表）。
- 补全不做拼音首字母检索：中文标题直接打两个字比记拼音快。

### 10.5 包体：KaTeX 按需加载

公式刚接上时是静态 `import katex`，于是 258 kB 的 JS + 28 kB CSS + 字体全被算进
**编辑器 chunk**（743 kB），打开任何笔记都要先下它 —— 而大多数笔记里没有公式。

现在：

- `lib/math.ts` 的 `preloadKatex()` 动态 `import('katex')` 与
  `import('katex/dist/katex.min.css')`，并缓存 `renderToString` 的结果
  （`toDOM` 每次重绘都会走，同一份源码不该重复算）。
- `MarkdownEditor` 外层挡一道：`initialValue` 里出现 `$` 才等 KaTeX 就位再挂
  编辑器。`toDOM` 是同步的，不等就会「先闪一下源码再变成公式」。
  不含 `$` 的笔记完全不下载 KaTeX。
- 打开之后才开始写的公式走异步填充：先按源码显示，加载完替换。
  实测从输入到出图 < 0.5s（katex.js + css + 2 个字体文件）。

结果：编辑器 chunk **743 → 489.66 kB**；katex 独立成 258.90 kB(+28.83 kB CSS)。
⚠️ 构建产物里会有**两个** katex chunk —— 另一个是 mermaid 自己依赖的，
不是重复打包，别顺手去「优化」它。

⚠️ 写播种脚本时的坑：LaTeX 一律用 `String.raw`，普通模板字符串会把 `\f`/`\i`/`\,`
当转义吃掉，公式进库就是坏的（表现为 KaTeX 的 ParseError，很容易误判成产品 bug）。

## 12. 多端 / Agent 改过之后：编辑器怎么跟上

一篇笔记可能同时存在于两个标签页，也可能刚被 Agent 在 `/agent` 里改过。
这边一直挂着旧内容，一保存就把对方的改动静默盖掉 —— 和 §11 之前那个
「丢更新」是同一类问题，只是发生在两个客户端之间。

### v1：回到页面对一下服务端

`index.tsx` 监听 `focus` 与 `visibilitychange`（400ms 防抖，`document.hidden`
时跳过），回调里：

```text
reloadActive() → 'dirty'     本地有未保存改动，什么都不做（本地赢）
              → 'unchanged'  服务端 updatedAt 与「已知最新」相同，什么都不做
              → 'reloaded'   换掉 active → 编辑器靠 key 里的 updatedAt 重挂载
```

然后顺手 `loadNotes()`，别处新建/改名的笔记才会出现在侧边栏。

### 为什么要有 `lastKnownUpdatedAt`

编辑器的 `key` 是 `${note.id}:${note.updatedAt}`（换正文必须重挂载，见 §9）。
如果本地保存成功后也去更新 `active.updatedAt`，**每次保存都会重挂载** ——
光标乱跳、输入法上屏被打断。所以保存在 store 里只推进 `lastKnownUpdatedAt`
（模块级变量），`active.updatedAt` 保持「上次从服务端读到的值」。

多端回读时比的也是 `lastKnownUpdatedAt`，不是 `active.updatedAt` ——
否则自己刚存完的那次也会被当成「外部改动」，白重挂载一次。
实测：保存完再触发 focus，`.ProseMirror` 节点引用不变（`sameNode: true`）。

### 实时推送（v1 之后补上的那一半）

focus 回读只管「回到页面时对齐」，断开期间发生的事要等下次回来。所以又接了一条
WebSocket 推送 —— 复用的是聊天那条既有连接，没有新增端口、没有新增握手逻辑。

链路：

```
NotesService.create/update/move/remove
  → RealtimeService.emitToUser(userId, 'event', { type: 'note.updated', … })
  → socket.io 房间 = userId（握手时已 join，见 chat.gateway）
  → 前端 subscribeRealtimeEvents → useNotesStore.applyRemoteNoteChange()
```

几个关键决定：

- **`RealtimeService` 是全局模块，不创建 socket server**。server 仍归 `chat.gateway`，
  它在 `afterInit` 里把 server 注册进来。方向是「网关交给服务」，而不是让
  `NotesModule` imports `ChatModule` —— 后者会成环（`ChatModule` 已经为了分享
  笔记 imports 了 `NotesModule`）。
- **在 service 层发事件，不在 controller 发**。AI 的笔记工具走的是同一个
  `NotesService`，这样「Agent 改完 → 打开着的编辑器跟着变」才是同一条路径，
  而不是给 HTTP 单独开一条。
- **和聊天共用一个 `event` 通道**：前端只挂一次 `socket.on('event')`，按载荷里的
  `type` 分派（聊天那条订阅先滤掉 `note.*`）。
- **自己写的那次也会收到推送**，靠 `lastKnownUpdatedAt` 挡掉，否则每保存一次就
  重挂载一次编辑器。
- 推送失败只记日志，不影响写接口 —— 库里已经写成功了，客户端下次 focus 也能对齐。

实测：接口 PATCH 之后 **542 ms** 编辑器就换成了新内容（全程没有 focus）；
删掉笔记后编辑器与侧边栏同时收起；自己打字保存后 `.ProseMirror`
节点引用不变（无重挂载）。

### 冲突：两边都改过时，交给用户拍板

推送到达时如果**本地正好有未保存的改动**，就是经典冲突。这时候替用户选任何一种
都会丢东西：换成远端 → 他正在写的没了；径直保存 → 对方的改动被盖掉。
所以立一个 `remoteConflict` 标记，编辑器上方出现一条琥珀色提示：

```
这篇笔记在别处被修改过（另一个标签页或 AI），而你这里有未保存的改动。
                                    [载入最新版本]  [保留我的]
```

- **载入最新版本** → `loadRemoteVersion()`：`cancelPending()` 丢掉排队中的保存，
  重新取详情、替换 `active`，并把 `editSeq = savedSeq`、推进 `lastKnownUpdatedAt`。
  最后那一步很关键 —— 不对齐的话，下一次 flush 会把已经不在界面上的旧内容
  当成「待保存」再写一遍。
- **保留我的** → 只清标记，正文与待保存的改动都不动；下次保存按
  last-write-wins 覆盖远端（按钮的 title 里写明了这点）。
- 标记会在这些时候自动清掉：保存成功（本地已覆盖远端）、开始载入远端版本、
  切换笔记、登出。

实测：两边都改 → 提示出现且正文仍是本地那份；点「载入最新版本」→ 编辑器换成远端、
提示消失、库内容仍是远端（旧内容没有被写回）；点「保留我的」→ 提示消失、
放行保存后库里是本地那份。

### 还没做（刻意）

- 删除是软删 + 逐个通知子树（`note.removed` ×N）；量大时可以改成一条
  `{ ids: [...] }`，现在没必要。
- 冲突只覆盖「同一篇笔记的正文」这一种。将来若要块级合并（像 CRDT / yjs），
  整条链路（存 Markdown 字符串）都得换，不是加个按钮的事。
