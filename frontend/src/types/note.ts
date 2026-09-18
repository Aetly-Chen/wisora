/** 笔记列表项（后端列表接口不返回正文，避免拖着几十 KB 的 Markdown） */
export interface NoteSummary {
  id: string;
  title: string;
  pinned: boolean;
  /** 父页面 id；null 表示顶层页面 */
  parentId: string | null;
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

/** 子页面摘要（详情接口带回，用于「父页面无内容时展示子页面标题」） */
export interface NoteChildSummary {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
}

/** 笔记详情（含正文、子页面与附件） */
export interface NoteDetail extends NoteSummary {
  content: string;
  children: NoteChildSummary[];
  attachments: AttachmentMeta[];
}

/** 本地保存状态，用于编辑器顶部提示 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * 树摊平后的一行。
 *
 * 侧边栏仍走虚拟列表，而虚拟列表只认「一维数组 + 固定行高」，
 * 所以把树按展开状态摊平成一维再交给它 ——
 * 这样既有了层级，也没丢掉之前的虚拟化。
 */
export interface NoteTreeRow {
  note: NoteSummary;
  /** 缩进层级，顶层为 0 */
  depth: number;
  hasChildren: boolean;
}
