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
