import request from './index';
import type { AttachmentMeta, NoteDetail, NoteSummary } from '../types/note';

const BASE = import.meta.env.VITE_BASE_API ?? '';

/** 列表，可按关键词搜索标题与正文 */
export function listNotes(keyword?: string) {
  return request.get<NoteSummary[]>('/notes', {
    params: keyword ? { keyword } : undefined,
    loading: false,
  });
}

export function createNote(
  payload: { title?: string; content?: string; parentId?: string | null } = {},
) {
  return request.post<NoteDetail>('/notes', payload, { loading: false });
}

export function getNote(id: string) {
  return request.get<NoteDetail>(`/notes/${id}`, { loading: false });
}

export function updateNote(
  id: string,
  payload: { title?: string; content?: string; pinned?: boolean },
) {
  return request.patch<NoteDetail>(`/notes/${id}`, payload, { loading: false });
}

export function deleteNote(id: string) {
  return request.delete(`/notes/${id}`, { loading: false });
}

/** 上传附件到指定笔记（noteId 可空，允许先传文件再挂笔记） */
export function uploadAttachment(file: File, noteId?: string) {
  const form = new FormData();
  form.append('file', file);
  return request.post<AttachmentMeta>(
    `/attachments${noteId ? `?noteId=${encodeURIComponent(noteId)}` : ''}`,
    form,
    { loading: false },
  );
}

export function deleteAttachment(id: string) {
  return request.delete(`/attachments/${id}`, { loading: false });
}

/**
 * 拉取附件二进制内容。
 *
 * 为什么不用 <iframe src="/attachments/:id/content"> 直接预览：
 * 附件接口挂在 JwtAuthGuard 下，需要 Authorization 头，
 * 而 iframe / img 的请求带不上自定义头。所以先用 axios 取成 Blob，
 * 再交给 URL.createObjectURL 在页面内渲染，令牌始终留在请求头里。
 */
export async function fetchAttachmentBlob(id: string): Promise<Blob> {
  const token = (await import('./storage')).getToken();
  const res = await fetch(`${BASE}/attachments/${id}/content`, {
    headers: { Authorization: `Bearer ${token ?? ''}` },
  });
  if (!res.ok) {
    throw new Error(`加载附件失败（HTTP ${res.status}）`);
  }
  return res.blob();
}

/** 触发浏览器下载 */
export async function downloadAttachment(id: string, filename: string) {
  const blob = await fetchAttachmentBlob(id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
