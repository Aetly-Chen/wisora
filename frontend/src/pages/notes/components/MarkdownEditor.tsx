import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Editor,
  commandsCtx,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  prosePluginsCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { prism, prismConfig } from '@milkdown/plugin-prism';
import { commonmark } from '@milkdown/preset-commonmark';
import {
  createCodeBlockCommand,
  insertHrCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/preset-commonmark';
import { gfm, insertTableCommand } from '@milkdown/preset-gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import { Plugin } from '@milkdown/prose/state';
import type { EditorState } from '@milkdown/prose/state';
import type { EditorView, ViewMutationRecord } from '@milkdown/prose/view';
import { toast } from 'sonner';
// 副作用导入：注册 jsx / tsx 与一批别名。Prism 插件用的是**同一个** refractor
// 实例（模块单例），所以这里注册完，插件那边直接能查到。
import { sharedRefractor } from '@/lib/code-highlight';
import {
  ATTACHMENT_SCHEME,
  ensureSigned,
  getAttachmentUrl,
  parseAttachmentRef,
} from '@/lib/attachment-url';
import { uploadAttachment } from '@/request/notes';
import { useNotesStore } from '@/stores/useNotesStore';
import { TableToolbar, type TableCommand } from './TableToolbar';
import { SlashMenu, type MenuItem } from './SlashMenu';
import { FindBar } from './FindBar';
import { createFindPlugin, setFind, type FindState } from '../lib/find';
import { createFocusPlugin } from '../lib/focus';
import { createWikilinkPlugin, createWikilinkSuggestPlugin, insertWikilink, unescapeWikilinks, type WikilinkAnchor } from '../lib/wikilink';
import {
  mathBlockInputRule,
  mathBlockSchema,
  mathInlineInputRule,
  mathInlineSchema,
  remarkMath,
} from '../lib/math';
import { mermaidPlugin } from '../lib/mermaid';
import {
  createSlashPlugin,
  filterSlashItems,
  type SlashAnchor,
  type SlashItemDef,
} from '../lib/slash';
import 'katex/dist/katex.min.css';
import './markdown-editor.css';

/** 光标（或选区头）是否落在表格内 */
function isInTable(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') return true;
  }
  return false;
}

/**
 * 光标进出表格时通知外部。
 *
 * 用 `view().update` 而不是 `props.handleDOMEvents`：需要的是「选区变了」，
 * 而不是「鼠标点了」，键盘移动光标同样要更新。
 */
function tableWatcher(onChange: (inTable: boolean) => void) {
  return new Plugin({
    view: () => ({
      update(view, prev) {
        if (prev.selection.eq(view.state.selection) && prev.doc.eq(view.state.doc)) {
          return;
        }
        onChange(isInTable(view.state));
      },
    }),
  });
}

/** 复制按钮：编辑区与预览区样式一致，行为也一致 */
function createCopyButton(getCode: () => string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'code-copy';
  btn.contentEditable = 'false';
  btn.textContent = '复制';

  /*
   * mousedown 必须 preventDefault。
   * 否则点按钮时浏览器先把光标移到按钮上 —— 代码块失焦、
   * 浮动工具条消失，接着 click 又触发一次重排，观感是「点了没反应」。
   */
  btn.addEventListener('mousedown', (e) => e.preventDefault());

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const text = getCode();
    if (!text) return;

    void navigator.clipboard.writeText(text).then(() => {
      btn.textContent = '已复制';
      btn.dataset.state = 'done';
      window.setTimeout(() => {
        btn.textContent = '复制';
        delete btn.dataset.state;
      }, 1400);
    });
  });

  return btn;
}

/**
 * 任务清单可勾选。
 *
 * gfm preset 把任务项渲染成 `li[data-item-type="task"][data-checked]`，
 * 那个方框是 `span::before` 画的 —— **纯 CSS 装饰，没有真实 input**，
 * 所以默认点不动，勾选状态只能靠改 Markdown 源码。
 *
 * 这里刻意不改成真实 `<input type="checkbox">`：那要推翻 preset 的 toDOM
 * 并重写整套列表样式，等于为了一个交互和内置实现打架。
 * 改为在 click 上判定「点的位置是不是方框那一块」——
 * 方框画在 `span` 左侧（负 margin），所以 `clientX` 落在 span 左边界之外
 * 就是点在框上；点文字照常交给 ProseMirror 放光标。
 */
const taskCheckboxPlugin = new Plugin({
  props: {
    handleClick(view, _pos, event) {
      const target = event.target as HTMLElement | null;
      const item = target?.closest?.('li[data-item-type="task"]') as HTMLElement | null;
      if (!item) return false;

      /*
       * 任务项的内容容器是 `<p>`，不是 `<span>` ——
       * 这是 gfm preset 现在的 toDOM（`['li', ['p', 0]]`），
       * 原样式表里写的 `> span` 从来没匹配上（方框一直没画出来）。
       * 两种都认，避免再被结构变化坑一次。
       */
      const label = item.querySelector(':scope > p, :scope > span');
      if (!label) return false;

      /*
       * 方框是 `p::before` —— 在 `<p>` **内容区的最左边**，不是 p 的外面。
       * 它宽 13px、margin-right 0.5em（≈6.5px），所以水平方向前 19px 属于方框。
       * 落在这个区间内算点方框，右边一律交给 ProseMirror 放光标。
       */
      const rect = label.getBoundingClientRect();
      if (event.clientX < rect.left - 2 || event.clientX >= rect.left + 19) return false;

      const $pos = view.state.doc.resolve(view.posAtDOM(item, 0));
      for (let depth = $pos.depth; depth > 0; depth -= 1) {
        if ($pos.node(depth).type.name !== 'list_item') continue;

        const itemPos = $pos.before(depth);
        const node = view.state.doc.nodeAt(itemPos);
        if (!node || node.attrs.checked == null) return false;

        view.dispatch(
          view.state.tr.setNodeMarkup(itemPos, undefined, {
            ...node.attrs,
            checked: !node.attrs.checked,
          }),
        );

        /*
         * handleClick 返回 true 会阻止浏览器的默认聚焦，
         * 勾完再打字发现输入不进去。补一次 focus。
         */
        view.focus();
        return true;
      }
      return false;
    },
  },
});

/**
 * 粘贴图片 → 上传 → 在光标处插入 `![](attachment:<id>)`。
 *
 * 只在剪贴板里是**文件**时接管（截图、从文件管理器复制图片）。
 * 从网页复制的 `<img src="https://...">` 走 ProseMirror 默认逻辑，
 * 直接插入外链 —— 那种图本来就不该收进自己的存储。
 */
async function insertPastedImages(
  view: EditorView,
  files: File[],
  noteId: string,
): Promise<void> {
  for (const file of files) {
    try {
      const meta = await uploadAttachment(file, noteId);
      await ensureSigned([meta.id]);

      // await 期间编辑器可能已被销毁（切笔记 / 关页面）
      if (view.isDestroyed) return;

      const imageType = view.state.schema.nodes.image;
      if (!imageType) {
        toast.error('当前编辑器不支持插入图片');
        return;
      }

      const alt = file.name.replace(/\.[^.]+$/, '') || '图片';
      const node = imageType.create({
        src: `${ATTACHMENT_SCHEME}${meta.id}`,
        alt,
        /*
         * `title` 必须给字符串：这个 attrs 的类型是 `string`（没有 default），
         * 传 `null` 会抛
         * `Expected value of type string for attribute title on type image`。
         * 空串序列化出来就是普通的 `![alt](url)`，不带 title。
         */
        title: '',
      });

      /*
       * 图片独占一段。
       *
       * 直接 `replaceSelectionWith` 会把图片塞进当前文本块末尾 ——
       * 正文里就变成「正文结束。![图](...)」糊在一行。
       * 先 `split` 把当前块断开，图片落进新段落，和 Typora 的行为一致。
       */
      let tr = view.state.tr;
      const { $from } = view.state.selection;
      if ($from.parent.content.size > 0) {
        tr = tr.split($from.pos);
      }
      tr = tr.replaceSelectionWith(node);
      view.dispatch(tr);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '图片上传失败');
      return;
    }
  }
}

interface ImageNode {
  type: { name: string }; // 节点类型（这里恒为 'image'，用于 update 时判断能不能接管）
  attrs: { src?: unknown; alt?: unknown }; // src 是 `attachment:<id>`（不是直链）；alt 作图片说明
}

/**
 * `image` 的自定义渲染。
 *
 * 正文里存的是 `![alt](attachment:<id>)` —— 一个与存储位置无关、永久有效的引用。
 * 真正要显示时得换成带签名的短时直链，而**签名是异步的**。
 *
 * ProseMirror 的 `toDOM` 是同步函数，拿不到异步结果；直接改 DOM 的 `src`
 * 又会在下一次 re-render 被覆盖。NodeView 是唯一能「先挂个空图、拿到签名再补 src」
 * 的位置。
 *
 * 失败时留空 src + alt，图片显示为裂图 —— 不让一张图拖垮整篇渲染。
 */
function imageNodeView(initialNode: ImageNode) {
  const img = document.createElement('img');
  let currentId: string | null = null;

  const hydrate = (node: ImageNode) => {
    const raw = typeof node.attrs.src === 'string' ? node.attrs.src : '';
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
    img.alt = alt;

    const id = parseAttachmentRef(raw);
    currentId = id;

    if (!id) {
      // 外链图片（http/data）原样用
      img.src = raw;
      return;
    }

    const ready = getAttachmentUrl(id);
    if (ready) {
      img.src = ready;
      return;
    }

    void ensureSigned([id]).then(() => {
      // 这期间可能已经切到别的图了，别把旧 URL 写回去
      if (currentId !== id) return;
      const url = getAttachmentUrl(id);
      if (url) img.src = url;
    });
  };

  hydrate(initialNode);

  return {
    dom: img,
    // 叶子节点：没有 contentDOM
    update(node: ImageNode) {
      if (node.type.name !== 'image') return false;
      hydrate(node);
      return true;
    },
    ignoreMutation: () => true,
  };
}

interface CodeBlockNode {
  type: { name: string }; // 节点类型（恒为 'code_block'），用于 update 时校验
  attrs: { language?: string | null }; // 代码语言标记（```js 里的 js），null/空表示未标注
}

/**
 * `code_block` 的自定义渲染。
 *
 * 为什么必须用 NodeView 而不是在 ProseMirror 外面加点缀：
 * 代码块的 DOM 由编辑器全权重渲染，任何手动 `appendChild` 进去的节点
 * 都会在下一次 re-render 时被丢掉。NodeView 是唯一能稳定持有额外 DOM
 * 的位置。
 *
 * `contentDOM` 指向 `<code>`，因此 Prism 的 inline decoration 仍然作用在
 * 正确的文本节点上 —— 高亮和按钮互不干扰。
 */
function codeBlockNodeView(initialNode: CodeBlockNode) {
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  const langLabel = document.createElement('span');
  const btn = createCopyButton(() => code.textContent ?? '');

  langLabel.className = 'code-lang';
  // 顺序有意义：按钮绝对定位，标签跟在 code 后面、不参与正文流
  pre.append(code, langLabel, btn);

  const sync = (node: CodeBlockNode) => {
    const language = (node.attrs.language ?? '').trim();
    langLabel.textContent = language;
    langLabel.hidden = language === '';
  };
  sync(initialNode);

  return {
    dom: pre,
    contentDOM: code,
    update(node: CodeBlockNode) {
      if (node.type.name !== 'code_block') return false;
      sync(node);
      return true;
    },
    /**
     * 忽略 contentDOM 之外的 DOM 变更 —— 否则「已复制」根本看不到。
     *
     * ProseMirror 的 DOMObserver 监听整个 view.dom，一旦发现在 contentDOM 外面
     * 有它没做的改动，就判定为外部污染并**重绘这个节点**。而复制按钮的反馈
     * 就是 `btn.textContent = '已复制'`，于是按钮被换成新节点、文案回到「复制」，
     * 实测间隔 < 250ms（`b.click()` 后立刻 `__tag` 就丢了）。
     *
     * 这里只放行 `<code>` 内部的变化（真正的内容编辑）。
     */
    ignoreMutation: (m: ViewMutationRecord) => !code.contains(m.target),
  };
}/** 编辑器内部：Milkdown 实例必须活在 Provider 里面 */
const Inner: React.FC<{
  /** 仅作初始值。之后的正文变化由编辑器自己产生，不再回灌 —— 见下方说明 */
  initialValue: string;
  onChange: (markdown: string) => void;
  /** 粘贴图片时要带上，附件挂在当前笔记下 */
  noteId: string;
  /** 专注模式开关（只影响观感，不影响文档） */
  focusMode: boolean;
}> = ({ initialValue, onChange, noteId, focusMode }) => {
  /*
   * 用 ref 转一层，而不是把 onChange 塞进 useEditor 的依赖数组。
   *
   * 依赖数组一变，useEditor 会销毁重建整个 ProseMirror 实例 ——
   * 表现就是「每敲一个字光标跳到开头」。而父级每次渲染都会传一个新的
   * 回调函数（inline arrow），所以这个 ref 是必须的。
   */
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  /*
   * 初始值同样只读一次。
   *
   * 这里刻意**不**把父级传下来的 value 持续同步进编辑器：
   * 编辑 → 回调 → store 更新 → 新 value → 回灌编辑器，
   * 这条环会让光标在每次输入后跳位。
   * 切换笔记靠外层 `key={note.id}` 强制重挂载，而不是同步内容。
   */
  const initialRef = useRef(initialValue);

  /*
   * noteId 走 ref：粘贴回调是在 useEditor 的闭包里捕获的，
   * 而 useEditor 的依赖数组是 `[]`（变了会重建整个编辑器）。
   * 用 ref 才能既拿到最新值、又不触发重建。
   */
  const noteIdRef = useRef(noteId);
  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  const [inTable, setInTable] = useState(false);

  /* ---------------- 专注模式 ---------------- */

  /*
   * 插件在编辑器创建时捕获一次，开关却是随时变的 —— 用 ref 给它读最新值。
   * 不用 state 触发重建：重建 ProseMirror 实例会把光标和撤销栈一起丢掉。
   */
  const focusModeRef = useRef(focusMode);
  focusModeRef.current = focusMode;

  /* ---------------- 斜杠命令 ---------------- */

  const [slash, setSlash] = useState<SlashAnchor | null>(null);
  const [slashActive, setSlashActive] = useState(0);

  const slashItems = useMemo(
    () => filterSlashItems(slash?.query ?? ''),
    [slash?.query],
  );

  /** 菜单组件只吃 {key,label,hint}；命令项额外带 kind，这里剥掉 */
  const slashMenuItems = useMemo<MenuItem[]>(
    () => slashItems.map((i) => ({ key: i.kind, label: i.label, hint: i.hint })),
    [slashItems],
  );

  /**
   * 插件只能拿到「创建时」的闭包，而 `slash` / `slashItems` / `slashActive`
   * 每个 keystroke 都在变 —— 用 ref 做一份实时镜像给它读。
   */
  const slashRef = useRef<{
    anchor: SlashAnchor | null;
    items: SlashItemDef[];
    active: number;
  }>({ anchor: null, items: [], active: 0 });
  slashRef.current.anchor = slash;
  slashRef.current.items = slashItems;
  slashRef.current.active = slashActive;

  /** 按 Esc 关掉的菜单，在同一个 `/` 上不要再自己弹回来 */
  const dismissedRef = useRef<number | null>(null);

  /** 执行项的回调要后置注入（它依赖下面 useEditor 返回的 get） */
  const pickRef = useRef<(item: SlashItemDef) => void>(() => {});

  const shellRef = useRef<HTMLDivElement>(null);

  const handleSlashAnchor = useCallback((anchor: SlashAnchor | null) => {
    if (!anchor) {
      dismissedRef.current = null;
      setSlash((prev) => (prev === null ? prev : null));
      return;
    }
    if (dismissedRef.current === anchor.from) {
      setSlash((prev) => (prev === null ? prev : null));
      return;
    }
    setSlash((prev) =>
      /*
       * 同一个锚点、同一段查询词就不换新对象：
       * 每敲一个字都 setState 会让整棵编辑器跟着重渲染。
       */
      prev &&
      prev.from === anchor.from &&
      prev.to === anchor.to &&
      prev.query === anchor.query
        ? prev
        : anchor,
    );
  }, []);

  const handleSlashKey = useCallback((event: KeyboardEvent) => {
    const anchor = slashRef.current.anchor;
    if (!anchor) return false;
    const items = slashRef.current.items;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return true;
      event.preventDefault();
      setSlashActive((i) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        return (i + step + items.length) % items.length;
      });
      return true;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[slashRef.current.active];
      if (item) pickRef.current(item);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      dismissedRef.current = anchor.from;
      setSlash(null);
      return true;
    }

    return false;
  }, []);

  // 查询词一变，高亮回到第一项（否则会停在一个已经不在列表里的下标上）
  useEffect(() => {
    setSlashActive(0);
  }, [slash?.query]);

  /*
   * 滚动时关掉菜单：它用 `position: fixed` 定位，滚动后就跟光标错位了。
   * 只监听外壳自身 —— 挂 window + capture 的话，菜单内部列表的
   * `scrollIntoView` 也会被当成滚动，键盘一按菜单就自己关了。
   */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !slash) return;
    const onScroll = () => {
      dismissedRef.current = slash.from;
      setSlash(null);
    };
    shell.addEventListener('scroll', onScroll, { passive: true });
    return () => shell.removeEventListener('scroll', onScroll);
  }, [slash]);

  /* ---------------- `[[` 选笔记 ---------------- */

  const [wiki, setWiki] = useState<WikilinkAnchor | null>(null);
  const [wikiActive, setWikiActive] = useState(0);
  /*
   * 订阅笔记列表：菜单的候选就是它。
   *
   * 这里用**订阅**而不是 `getState()`：列表本身变了（新建/改名/删除）候选要跟着变，
   * 而列表变化频率很低，多这一次重渲染可以忽略。
   */
  const notes = useNotesStore((s) => s.notes);

  /**
   * 候选：排除自己（自引用没有意义），前缀命中排前面，最多 8 条。
   * 不做拼音检索 —— 笔记标题是中文时拼音首字母的意义远不如「直接打两个字」。
   */
  const wikiItems = useMemo<MenuItem[]>(() => {
    const q = (wiki?.query ?? '').trim().toLowerCase();
    const rank = (title: string) => (q && title.toLowerCase().startsWith(q) ? 0 : 1);
    return notes
      .filter((n) => n.id !== noteId)
      .filter((n) => !q || n.title.toLowerCase().includes(q))
      .sort(
        (a, b) =>
          rank(a.title) - rank(b.title) ||
          a.title.localeCompare(b.title, 'zh-Hans-CN'),
      )
      .slice(0, 8)
      .map((n) => ({
        key: n.id,
        label: n.title || '无标题',
        hint: n.pinned ? '置顶' : '',
      }));
  }, [notes, wiki?.query, noteId]);

  const wikiRef = useRef<{
    anchor: WikilinkAnchor | null;
    items: MenuItem[];
    active: number;
  }>({ anchor: null, items: [], active: 0 });
  wikiRef.current.anchor = wiki;
  wikiRef.current.items = wikiItems;
  wikiRef.current.active = wikiActive;

  /** Esc 关掉的菜单，别在同一个 `[[` 上自己弹回来 */
  const wikiDismissedRef = useRef<number | null>(null);

  const handleWikiAnchor = useCallback((anchor: WikilinkAnchor | null) => {
    if (!anchor) {
      wikiDismissedRef.current = null;
      setWiki((prev) => (prev === null ? prev : null));
      return;
    }
    if (wikiDismissedRef.current === anchor.from) {
      setWiki((prev) => (prev === null ? prev : null));
      return;
    }
    setWiki((prev) =>
      prev &&
      prev.from === anchor.from &&
      prev.to === anchor.to &&
      prev.query === anchor.query
        ? prev
        : anchor,
    );
  }, []);

  const handleWikiKey = useCallback((event: KeyboardEvent) => {
    const anchor = wikiRef.current.anchor;
    if (!anchor) return false;
    const items = wikiRef.current.items;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (items.length === 0) return true;
      event.preventDefault();
      setWikiActive((i) => {
        const step = event.key === 'ArrowDown' ? 1 : -1;
        return (i + step + items.length) % items.length;
      });
      return true;
    }

    // Tab 也当确认：手不用离开主键区
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const item = items[wikiRef.current.active];
      if (item) pickWikiRef.current(item.label);
      else setWiki(null);
      return true;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      wikiDismissedRef.current = anchor.from;
      setWiki(null);
      return true;
    }

    return false;
  }, []);

  useEffect(() => {
    setWikiActive(0);
  }, [wiki?.query]);

  const pickWikiRef = useRef<(title: string) => void>(() => {});

  /** 滚动时同样要关：fixed 定位的菜单不会跟着走 */
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell || !wiki) return;
    const onScroll = () => {
      wikiDismissedRef.current = wiki.from;
      setWiki(null);
    };
    shell.addEventListener('scroll', onScroll, { passive: true });
    return () => shell.removeEventListener('scroll', onScroll);
  }, [wiki]);

  /* ---------------- 查找替换 ---------------- */

  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplacement, setFindReplacement] = useState('');
  const [findState, setFindState] = useState<FindState>({
    query: '',
    matches: [],
    current: -1,
  });

  /*
   * 插件与事件回调都是「创建时捕获」的，读不到最新的 React 状态 ——
   * 这几个 ref 是给它们用的实时镜像。
   */
  const findOpenRef = useRef(false);
  const findStateRef = useRef(findState);
  const findReplacementRef = useRef(findReplacement);
  findOpenRef.current = findOpen;
  findStateRef.current = findState;
  findReplacementRef.current = findReplacement;

  const handleFindState = useCallback((next: FindState) => {
    // 关闭状态下不跟着动，省掉每敲一个字都重渲染
    if (!findOpenRef.current) return;
    setFindState((prev) =>
      prev.query === next.query &&
      prev.current === next.current &&
      prev.matches.length === next.matches.length &&
      prev.matches[0]?.from === next.matches[0]?.from &&
      prev.matches[prev.matches.length - 1]?.from ===
        next.matches[next.matches.length - 1]?.from
        ? prev
        : next,
    );
  }, []);

  const { loading, get } = useEditor(
    (root) =>
      Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, root);
          ctx.set(defaultValueCtx, initialRef.current);

          /*
           * 序列化选项：把无序列表符号和分隔线改回 `-` / `---`。
           *
           * remark 默认输出 `*` 开头、`***` 分隔线 —— 渲染上等价，但会让
           * **每一篇存量笔记在第一次编辑后被整体改写一遍**，看着像被动了手脚。
           *
           * ⚠️ 必须用 `update` 合并、不能用 `set`：这个 ctx 的默认值里还带着
           * `handlers`（ProseMirror 节点 → mdast 的映射）与 `encode: []`，
           * 直接 set 一个只含 bullet/rule 的对象会把它们冲掉 —— 代码块会退化成
           * 缩进式、表格和图片直接序列化失败。这一点在探针里实测确认过。
           */
          ctx.update(remarkStringifyOptionsCtx, (prev) => ({
            ...prev,
            /**
             * `as const` 不能省：对象字面量在回调返回值里会被放宽成 `string`，
             * 而这两个字段声明的是 `'-' | '*' | '+'` 这类**字面量联合**。
             * 去掉它 tsc 会报 TS2322（vite build 照样过，所以一直没被看见）。
             */
            bullet: '-' as const,
            rule: '-' as const,
            /*
             * 公式的序列化。
             *
             * remark-stringify 不认识 mdast 的 `inlineMath` / `math` 节点
             * （`remark-math` v6 只导出了解析侧的插件，没导出 toMarkdown 扩展），
             * 不补 handler 的话公式会被**静默丢弃**，用户保存一次就没了。
             *
             * 格式钉死在 `$…$` 与 `$$\n…\n$$`：`Note.content` 是 Markdown 契约，
             * RAG 切块、AI 工具、导入导出都按这个读。
             */
            handlers: {
              ...(prev.handlers as Record<string, unknown> | undefined),
              inlineMath: (node: { value?: string }) => `$${node.value ?? ''}$`,
              math: (node: { value?: string }) => `$$\n${node.value ?? ''}\n$$`,
            } as never,
          }));

          /*
           * 代码高亮。
           *
           * `configureRefractor` 的默认实现是空函数，插件内部直接用的是
           * refractor 的模块单例 —— 而 jsx / tsx 与那批别名已经在
           * `@/lib/code-highlight` 里注册过一次，这里把同一个实例显式交回去，
           * 保证「注册过」和「用来高亮」的是同一个对象。
           *
           * 用 `update` 合并而不是 `set`：这个 ctx 的类型是 Options 对象，
           * 将来插件加字段时 set 会静默丢掉新字段。
           */
          ctx.update(prismConfig.key, (prev) => ({
            ...prev,
            configureRefractor: () => sharedRefractor,
          }));

          /*
           * 接管 code_block 的渲染，放进复制按钮与语言标签。
           *
           * 只覆盖 `code_block`，其余节点仍走 preset 默认实现 ——
           * nodeViews 是「按节点名覆盖」，不需要把默认的抄一遍。
           */
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            nodeViews: {
              ...prev.nodeViews,
              code_block: codeBlockNodeView,
              image: imageNodeView,
            },
            /*
             * 粘贴图片：只有剪贴板里真有 image/* 文件时接管，
             * 纯文本 / HTML 粘贴原样交回 ProseMirror。
             *
             * ⚠️ 必须用 `Array.from`，不能用展开语法 ——
             * `DataTransferItemList` 是类数组、**不是** iterable，
             * `[...items]` 在 Chrome 直接抛 "is not iterable"。
             * 异常会冒到 ProseMirror 的 paste 处理里被吞掉，
             * 表现为「粘贴毫无反应，控制台也干净」（踩过一次）。
             */
            handlePaste: (view, event) => {
              const items = event.clipboardData
                ? Array.from(event.clipboardData.items)
                : [];
              const files = items
                .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);

              if (files.length === 0) return false;

              event.preventDefault();
              void insertPastedImages(view, files, noteIdRef.current);
              return true;
            },
          }));

          // 任务清单勾选（见 taskCheckboxPlugin 的说明）
          ctx.update(prosePluginsCtx, (prev) => [
            ...prev,
            taskCheckboxPlugin,
            // 光标进出表格时切换工具条
            tableWatcher(setInTable),
            // `/` 插入菜单（触发判定 + 键盘接管都在这里）
            createSlashPlugin({
              onAnchor: handleSlashAnchor,
              onKey: handleSlashKey,
            }),
            // 查找命中高亮
            createFindPlugin({ onState: handleFindState }),
            // 专注模式：只标当前块 + 打字机滚动
            createFocusPlugin({ isEnabled: () => focusModeRef.current }),
            /*
             * 双向链接 `[[标题]]`。
             *
             * 解析与跳转都走 store 的**即时快照**（`getState()`），而不是闭包里的
             * 旧值：侧边栏改了标题、新建了同名页，这里的解析要立刻跟着变。
             */
            createWikilinkPlugin({
              resolve: (title) =>
                useNotesStore.getState().notes.find((n) => n.title === title)?.id,
              open: (id) => {
                void useNotesStore.getState().openNote(id);
              },
            }),
            // `[[` 选笔记（触发判定 + 键盘接管）
            createWikilinkSuggestPlugin({
              onAnchor: handleWikiAnchor,
              onKey: handleWikiKey,
            }),
          ]);

          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            /*
             * `unescapeWikilinks` 不能省：remark-stringify 会把 `[[` 转义成 `\[\[`，
             * 存进库就变成 `\[\[标题]]`，后端按 `[[标题]]` 匹配反链会全部落空。
             * 详见 `lib/wikilink.ts` 里那段注释。
             */
            onChangeRef.current(unescapeWikilinks(markdown));
          });
        })
        .use(commonmark)
        .use(gfm)
        // 公式：解析（remark-math）+ 两个 atom 节点，渲染在各自的 toDOM 里
        .use(remarkMath)
        .use(mathInlineSchema)
        .use(mathBlockSchema)
        .use(mathInlineInputRule)
        .use(mathBlockInputRule)
        // 图表：```mermaid 代码块下方的预览（装饰实现，源码照常可编辑）
        .use(mermaidPlugin)
        .use(prism)
        .use(history)
        .use(listener),
    [],
  );

  /**
   * 执行一条斜杠命令。
   *
   * 顺序不能反：先把 `/查询` 删掉，命令才作用在**留下的空段落**上。
   * 反过来先转标题、再删文本，删的就是标题里的字，看着像"命令没生效"。
   *
   * 命令走 `commandsCtx` 而不是自己拼 transaction —— 标题、列表、引用
   * 这些 preset 都在命令里处理了「当前块能不能转」和转完的选区位置。
   */
  const runSlashItem = useCallback(
    (item: SlashItemDef) => {
      const anchor = slashRef.current.anchor;
      if (!anchor) return;
      const editor = get();
      if (!editor) return;

      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.delete(anchor.from, anchor.to));
      });

      editor.action((ctx) => {
        const commands = ctx.get(commandsCtx);
        switch (item.kind) {
          case 'h1':
            commands.call(wrapInHeadingCommand.key, 1);
            break;
          case 'h2':
            commands.call(wrapInHeadingCommand.key, 2);
            break;
          case 'h3':
            commands.call(wrapInHeadingCommand.key, 3);
            break;
          case 'bullet':
          // 任务清单先当无序列表建，再补 checked 属性（见下）
          case 'task':
            commands.call(wrapInBulletListCommand.key);
            break;
          case 'ordered':
            commands.call(wrapInOrderedListCommand.key);
            break;
          case 'quote':
            commands.call(wrapInBlockquoteCommand.key);
            break;
          case 'code':
            commands.call(createCodeBlockCommand.key);
            break;
          // 图表就是一个 `language=mermaid` 的代码块，预览由装饰插件画在它下面
          case 'mermaid':
            commands.call(createCodeBlockCommand.key, 'mermaid');
            break;
          case 'table':
            commands.call(insertTableCommand.key, { row: 3, col: 3 });
            break;
          case 'hr':
            commands.call(insertHrCommand.key);
            break;
        }
      });

      /*
       * 任务清单：gfm 的 `list_item` 靠 `checked` 属性决定是不是任务项
       * （`null` = 普通列表项，`false` = 未勾选）。preset 没有提供
       * 「建任务列表」的命令，所以建完列表再把这个属性补上。
       */
      if (item.kind === 'task') {
        editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          const { $from } = view.state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            if ($from.node(depth).type.name !== 'list_item') continue;
            const pos = $from.before(depth);
            const node = view.state.doc.nodeAt(pos);
            if (node && node.attrs.checked == null) {
              view.dispatch(
                view.state.tr.setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  checked: false,
                }),
              );
            }
            break;
          }
        });
      }

      setSlash(null);
      setSlashActive(0);
      editor.action((ctx) => ctx.get(editorViewCtx).focus());
    },
    [get],
  );

  // 插件通过 ref 取最新的执行函数（它自己是在编辑器创建时捕获的）
  useEffect(() => {
    pickRef.current = runSlashItem;
  }, [runSlashItem]);

  /**
   * `[[` 选中某一篇后把它写成链接。
   *
   * 与 `runSlashItem` 一样放这里而不是上面的状态区：它要用 `get()`，
   * 而 `get` 来自下面的 `useEditor` 返回值。
   */
  const runWikiPick = useCallback(
    (title: string) => {
      const anchor = wikiRef.current.anchor;
      if (!anchor) return;
      const editor = get();
      if (!editor) return;
      editor.action((ctx) => insertWikilink(ctx.get(editorViewCtx), anchor, title));
      setWiki(null);
      editor.action((ctx) => ctx.get(editorViewCtx).focus());
    },
    [get],
  );

  useEffect(() => {
    pickWikiRef.current = runWikiPick;
  }, [runWikiPick]);

  /**
   * 开关一变就补一个空事务。
   *
   * 装饰是「按 state 算」的：没有事务就不会重算，切开关时第一帧会是
   * 全部淡化、却没有 `.focus-block`（实测如此）。用一个 meta 事务把
   * 渲染踢一下，成本可以忽略。
   */
  useEffect(() => {
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(view.state.tr.setMeta('focus-mode', focusMode));
    });
  }, [focusMode, get]);

  /* ---------------- 查找替换的动作 ---------------- */

  /*
   * 四个动作都直接走 ProseMirror 事务，不经过 store：
   * 替换应当是一次**可撤销的编辑**，而不是「改完再存」。
   * 走 store 的话，撤销栈里就没有它，Ctrl+Z 也救不回来。
   */
  const applyFindQuery = useCallback(
    (value: string) => {
      setFindQuery(value);
      const editor = get();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(setFind(view.state, { query: value }));
      });
    },
    [get],
  );

  const gotoMatch = useCallback(
    (step: 1 | -1) => {
      const { matches, current } = findStateRef.current;
      if (matches.length === 0) return;
      const index =
        (((current + step) % matches.length) + matches.length) % matches.length;
      const editor = get();
      if (!editor) return;
      editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(setFind(view.state, { current: index }));
      });
    },
    [get],
  );

  const replaceCurrent = useCallback(() => {
    const { matches, current } = findStateRef.current;
    const match = matches[current];
    const editor = get();
    if (!editor || !match) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(
        view.state.tr.insertText(
          findReplacementRef.current,
          match.from,
          match.to,
        ),
      );
      /*
       * 换完把焦点交回编辑器：
       * 否则焦点还在按钮上，`Ctrl+Z` 落不到 ProseMirror 的撤销栈里 ——
       * 用户会以为「替换撤不掉」。
       */
      view.focus();
    });
  }, [get]);

  const replaceAll = useCallback(() => {
    const { matches } = findStateRef.current;
    const editor = get();
    if (!editor || matches.length === 0) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      /*
       * 从后往前改：位置是按原文档算的，倒序处理时后面的编辑
       * 不会让前面区间的坐标失效。
       */
      let tr = view.state.tr;
      for (let i = matches.length - 1; i >= 0; i -= 1) {
        tr = tr.insertText(findReplacementRef.current, matches[i].from, matches[i].to);
      }
      view.dispatch(tr);
      view.focus();
    });
  }, [get]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    setFindQuery('');
    setFindReplacement('');
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      view.dispatch(setFind(view.state, { query: '', matches: [], current: -1 }));
      view.focus();
    });
  }, [get]);

  /* Ctrl+F 打开（只在所见即所得模式下存在 —— 源码/预览模式没有挂这个组件） */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setFindOpen(true);
        return;
      }
      /*
       * Esc 关闭挂到 window，而不是只挂在查找条上：
       * 替换之后焦点已经交回编辑器，只挂条上的话 Esc 就失效了。
       */
      if (e.key === 'Escape' && findOpenRef.current) {
        e.preventDefault();
        closeFind();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closeFind]);

  /* 当前命中滚进视野 */
  useEffect(() => {
    if (!findOpen || findState.current < 0) return;
    shellRef.current
      ?.querySelector('.find-hit-current')
      ?.scrollIntoView({ block: 'center' });
  }, [findOpen, findState.current, findState.matches.length]);

  /**
   * 执行一条表格命令。
   *
   * 不用 `commandsCtx`：prosemirror-tables 的命令是普通的
   * `(state, dispatch) => boolean`，直接 dispatch 更直观，
   * 也省掉「先 selectRow 再 deleteSelectedCells」那种两步操作
   * （两步之间选区已经变了，容易删错）。
   */
  const runTableCommand = useCallback(
    (cmd: TableCommand) => {
      const editor = get();
      if (!editor) return;
      const view = editor.action((ctx) => ctx.get(editorViewCtx));
      if (!view) return;

      const applied = cmd(view.state, view.dispatch, view);
      if (applied) view.focus();
    },
    [get],
  );

  /**
   * 插入一个 3×3 表格。
   *
   * 走 gfm 的 `insertTableCommand`（payload `{row, col}`）而不是自己拼节点：
   * 它内部会处理「当前块能不能放表格」和插入后的选区（落到第一个单元格）。
   */
  const insertTable = useCallback(() => {
    const editor = get();
    if (!editor) return;
    editor.action((ctx) => {
      ctx.get(commandsCtx).call(insertTableCommand.key, { row: 3, col: 3 });
      ctx.get(editorViewCtx).focus();
    });
  }, [get]);

  return (
    /*
     * `md-body` 不能少：编辑区的标题/列表/表格/引用排版全部复用预览区那套规则，
     * 这样「所见」和「所得」才是同一套字号与间距。
     * 少了这个类，ProseMirror 会退化成浏览器默认样式（标题不放大、列表没圆点）。
     */
    <div
      className="md-editor-shell md-body"
      ref={shellRef}
      data-focus={focusMode ? 'on' : 'off'}
    >
      <TableToolbar
        inTable={inTable}
        onCommand={runTableCommand}
        onInsertTable={insertTable}
      />
      {findOpen && (
        <FindBar
          query={findQuery}
          replacement={findReplacement}
          total={findState.matches.length}
          current={findState.current}
          onQueryChange={applyFindQuery}
          onReplacementChange={setFindReplacement}
          onPrev={() => gotoMatch(-1)}
          onNext={() => gotoMatch(1)}
          onReplaceOne={replaceCurrent}
          onReplaceAll={replaceAll}
          onClose={closeFind}
        />
      )}
      {loading && (
        <div className="md-editor-loading" aria-hidden>
          编辑器加载中…
        </div>
      )}
      <Milkdown />
      {slash && (
        <SlashMenu
          left={slash.left}
          bottom={slash.bottom}
          items={slashMenuItems}
          active={slashActive}
          onHover={setSlashActive}
          onPick={(index) => {
            const item = slashItems[index];
            if (item) runSlashItem(item);
          }}
        />
      )}
      {wiki && (
        <SlashMenu
          left={wiki.left}
          bottom={wiki.bottom}
          items={wikiItems}
          active={wikiActive}
          onHover={setWikiActive}
          onPick={(index) => {
            const item = wikiItems[index];
            if (item) runWikiPick(item.label);
          }}
          emptyText="没有匹配的笔记"
          ariaLabel="插入链接"
        />
      )}
    </div>
  );
};

/**
 * 所见即所得 Markdown 编辑器（Milkdown / ProseMirror）。
 *
 * **数据契约不变**：进来是 Markdown 字符串，出去也是 Markdown 字符串。
 * 后端 `rag/chunk.ts` 按 `#{1,4}` 切块、AI 工具按 md 文本读写、
 * 导入导出以 `.md` 为契约 —— 所以这里绝不能用块 JSON 做存储格式。
 *
 * 换笔记时请在外层用 `key={note.id}`，不要依赖 `initialValue` 变化。
 */
export const MarkdownEditor: React.FC<{
  initialValue: string;
  onChange: (markdown: string) => void;
  noteId: string;
  /** 专注模式（只作用于所见即所得这一态） */
  focusMode: boolean;
}> = ({ initialValue, onChange, noteId, focusMode }) => (
  <MilkdownProvider>
    <Inner
      initialValue={initialValue}
      onChange={onChange}
      noteId={noteId}
      focusMode={focusMode}
    />
  </MilkdownProvider>
);
