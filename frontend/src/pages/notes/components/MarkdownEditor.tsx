import React, { useEffect, useRef } from 'react';
import { Editor, defaultValueCtx, remarkStringifyOptionsCtx, rootCtx } from '@milkdown/core';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { history } from '@milkdown/plugin-history';
import { commonmark } from '@milkdown/preset-commonmark';
import { gfm } from '@milkdown/preset-gfm';
import { Milkdown, MilkdownProvider, useEditor } from '@milkdown/react';
import './markdown-editor.css';

/** 编辑器内部：Milkdown 实例必须活在 Provider 里面 */
const Inner: React.FC<{
  /** 仅作初始值。之后的正文变化由编辑器自己产生，不再回灌 —— 见下方说明 */
  initialValue: string;
  onChange: (markdown: string) => void;
}> = ({ initialValue, onChange }) => {
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

  const { loading } = useEditor(
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
            bullet: '-',
            rule: '-',
          }));

          ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
            onChangeRef.current(markdown);
          });
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener),
    [],
  );

  return (
    <div className="md-editor-shell">
      {loading && (
        <div className="md-editor-loading" aria-hidden>
          编辑器加载中…
        </div>
      )}
      <Milkdown />
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
}> = ({ initialValue, onChange }) => (
  <MilkdownProvider>
    <Inner initialValue={initialValue} onChange={onChange} />
  </MilkdownProvider>
);
