import type { SaveState } from '@/types/note';

/** 编辑区三态：纯编辑 / 左右分栏 / 纯预览 */
export type ViewMode = 'edit' | 'split' | 'preview';

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
