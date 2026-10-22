import type { SaveState } from '@/types/note';

/**
 * 编辑区三态。
 *
 * `edit`   —— 所见即所得（Milkdown），默认
 * `source` —— 原始 Markdown，逃生通道（Ctrl+/ 切换）
 * `preview`—— 只渲染不可编辑，用于通读排版效果
 *
 * 原来的 `split`（左右分栏）已移除：所见即所得之后，
 * 「随时能看到渲染结果」这个诉求本身就消失了，分栏只剩浪费宽度。
 */
export type ViewMode = 'edit' | 'source' | 'preview';

/**
 * 实时预览的正文长度上限。
 *
 * 实测：打开 1.1MB 的笔记会让主线程一次性阻塞 1.1 秒 —— 那是
 * marked 解析 + DOMPurify 清洗 + 渲染上万节点 DOM 的合计耗时。
 * 这个量级的文档本来也不需要逐字预览，所以超过阈值就暂停实时渲染，
 * 给一个「仍然渲染」的按钮让用户自己决定。
 */
export const PREVIEW_MAX_CHARS = 100_000;

export const SAVE_LABEL: Record<SaveState, string> = {
  idle: '',
  dirty: '待保存',
  saving: '保存中',
  saved: '已保存',
  error: '保存失败',
};
