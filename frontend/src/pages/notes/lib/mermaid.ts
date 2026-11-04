import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorState, Transaction } from '@milkdown/prose/state';
import { Decoration, DecorationSet } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';

/**
 * Mermaid 图表预览（```mermaid 代码块 → 代码块下方渲染一张图）。
 *
 * ⚠️ 为什么不用 NodeView：`$view` 的注册发生在 `await ctx.wait(SchemaReady)`
 * 之后，而 EditorView 构造时读的是当时的 `nodeViewCtx` 快照 —— 两者并行，
 * 7.22 上必输（公式那里踩过，见 `lib/math.ts` 的注释）。
 *
 * ⚠️ 为什么也不用「自定义节点 + toDOM」：那样代码就没法编辑了（atom 节点里
 * 打不了字）。公式可以只读，图表必须能改。
 *
 * 所以走装饰：`code_block` 保持原样（Markdown 契约就是 ```mermaid 围栏，
 * 库里的形态一个字都不用改），在块后面挂一个 widget 显示渲染结果。
 * 源码照常编辑，预览跟着重画。
 */

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, code: string) => Promise<{ svg: string }>;
};

/** 缓存：同一份源码只渲染一次（每次事务重建装饰时靠它免掉重复渲染） */
const svgCache = new Map<string, string>();
const errorCache = new Map<string, string>();

let apiPromise: Promise<MermaidApi> | null = null;
let renderSeq = 0;

/**
 * 懒加载 mermaid。
 *
 * 它是个几百 kB 的大包，编辑器首屏不该为它买单；等到真的出现
 * ```mermaid 块时再 import。`initialize` 只做一次。
 */
function loadMermaid(): Promise<MermaidApi> {
  if (!apiPromise) {
    apiPromise = import('mermaid').then((mod) => {
      const api = ((mod as unknown as { default?: MermaidApi }).default ?? mod) as MermaidApi;
      api.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
      return api;
    });
  }
  return apiPromise;
}

/**
 * 把要渲染的任务攒一下，别每敲一个字符就渲染一次。
 *
 * ⚠️ 必须按 DOM 排队，不能用「一个 pending 变量」：一篇笔记里有两张图时，
 * 后一张会把前一张的任务顶掉，前一张永远停在「正在渲染图表…」（实测如此）。
 */
const pendingJobs = new Map<HTMLElement, string>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRender(dom: HTMLElement, code: string): void {
  pendingJobs.set(dom, code);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    const jobs = [...pendingJobs.entries()];
    pendingJobs.clear();
    for (const [target, source] of jobs) void renderInto(target, source);
  }, 350);
}

function paintError(dom: HTMLElement, message: string): void {
  dom.classList.add('md-mermaid--error');
  dom.textContent = `图表语法有误：${message}`;
}

async function renderInto(dom: HTMLElement, code: string): Promise<void> {
  // 装饰每次事务都会重建，异步回来时这块 DOM 可能已经不在树上了
  if (!dom.isConnected) return;
  const id = `md-mermaid-${(renderSeq += 1)}`;
  try {
    const api = await loadMermaid();
    const { svg } = await api.render(id, code);
    svgCache.set(code, svg);
    errorCache.delete(code);
    if (dom.isConnected) {
      dom.classList.remove('md-mermaid--error');
      dom.innerHTML = svg;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errorCache.set(code, message);
    // mermaid 渲染失败时会往 body 里留一个临时容器，清掉它
    document.getElementById(`d${id}`)?.remove();
    if (dom.isConnected) paintError(dom, message.split('\n')[0] ?? message);
  }
}

/** 建一个预览容器：命中缓存就同步填好，不命中才排队渲染 */
function createPreview(code: string): HTMLElement {
  const dom = document.createElement('div');
  dom.className = 'md-mermaid';
  dom.setAttribute('contenteditable', 'false');

  const failed = errorCache.get(code);
  if (failed) {
    paintError(dom, failed);
    return dom;
  }
  const cached = svgCache.get(code);
  if (cached) {
    dom.innerHTML = cached;
    return dom;
  }
  if (!code.trim()) {
    dom.classList.add('md-mermaid--empty');
    dom.textContent = '在代码块里写 Mermaid 语法，这里会显示图表';
    return dom;
  }
  dom.textContent = '正在渲染图表…';
  scheduleRender(dom, code);
  return dom;
}

function isMermaidBlock(node: ProseNode): boolean {
  return (
    node.type.name === 'code_block' &&
    String(node.attrs.language ?? '').toLowerCase() === 'mermaid'
  );
}

/** 扫一遍文档，给每个 mermaid 代码块后面挂一个预览 */
function buildDecorations(doc: ProseNode): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!isMermaidBlock(node)) return true;
    const code = node.textContent;
    decorations.push(
      Decoration.widget(pos + node.nodeSize, () => createPreview(code), {
        side: 1,
        // 源码变了就当另一个 widget，位置不变时 ProseMirror 也能正确替换
        key: `mermaid-${pos}-${code.length}-${code.slice(0, 24)}`,
        ignoreSelection: true,
      }),
    );
    // 代码块内部不用再往下找
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export const mermaidPlugin = $prose(() => {
  const key = new PluginKey('mermaid-preview');
  return new Plugin({
    key,
    state: {
      init: (_config, state: EditorState) => buildDecorations(state.doc),
      apply: (tr: Transaction, value: DecorationSet, _old, newState: EditorState) => {
        if (!tr.docChanged) return value;
        return buildDecorations(newState.doc);
      },
    },
    props: {
      decorations(state) {
        return key.getState(state) ?? DecorationSet.empty;
      },
    },
  });
});
