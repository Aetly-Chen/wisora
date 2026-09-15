/** 笔记列表项（后端列表接口不返回正文，避免拖着几十 KB 的 Markdown） */
export interface NoteSummary {
  id: string;
  title: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 附件元数据 */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  noteId?: string | null;
  createdAt: string;
}

/** 笔记详情（含正文与附件） */
export interface NoteDetail extends NoteSummary {
  content: string;
  attachments: AttachmentMeta[];
}

/** 本地保存状态，用于编辑器顶部提示 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';
