/** 笔记列表项（后端列表接口不返回正文，避免拖着几十 KB 的 Markdown） */
export interface NoteSummary {
  id: string; // 笔记主键（cuid），前后端通用
  title: string; // 标题；空标题由后端兜底成「无标题」
  pinned: boolean; // 是否置顶（只影响列表排序，不重建索引）
  /** 父页面 id；null 表示顶层页面 */
  parentId: string | null;
  createdAt: string; // 创建时间，ISO 字符串（后端 Date 直接序列化）
  updatedAt: string; // 最后更新时间，ISO 字符串；列表按它倒序
}

/** 附件元数据 */
export interface AttachmentMeta {
  id: string; // 附件主键；正文里用 `attachment:<id>` 引用它
  filename: string; // 原始文件名，展示与下载都用它
  mimeType: string; // MIME 类型，决定预览方式（图片 / 文本 / 其它）
  size: number; // 字节数，用于展示与上限校验
  noteId?: string | null; // 所属笔记；null 表示暂未挂到任何笔记（粘贴失败会留下这种）
  createdAt: string; // 上传时间，ISO 字符串
}

/** 子页面摘要（详情接口带回，用于「父页面无内容时展示子页面标题」） */
export interface NoteChildSummary {
  id: string; // 子页面主键
  title: string; // 子页面标题
  pinned: boolean; // 是否置顶，展示时可加标记
  updatedAt: string; // 最后更新时间，用于展示与排序
}

/** 笔记详情（含正文、子页面与附件） */
export interface NoteDetail extends NoteSummary {
  content: string; // Markdown 正文（RAG 切块、AI 读写都以此为准）
  children: NoteChildSummary[]; // 直接子页面（只一层，不带它们的子页）
  attachments: AttachmentMeta[]; // 挂在这篇笔记上的附件
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
  note: NoteSummary; // 这一行对应的笔记
  /** 缩进层级，顶层为 0 */
  depth: number;
  hasChildren: boolean; // 有无子页面，决定是否画展开箭头
}
