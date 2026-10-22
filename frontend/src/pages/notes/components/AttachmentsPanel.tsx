import React from 'react';
import { FileText, Paperclip, X } from 'lucide-react';
import { downloadAttachment } from '@/request/notes';
import type { AttachmentMeta } from '@/types/note';
import { formatSize, isPreviewable } from '../lib/format';

/** 笔记详情页底部的附件区：列出、预览、下载、删除 */
export const AttachmentsPanel: React.FC<{
  attachments: AttachmentMeta[];
  dragging: boolean;
  onPreview: (a: AttachmentMeta) => void;
  onDelete: (id: string) => void;
}> = ({ attachments, dragging, onPreview, onDelete }) => (
  <div
    className={`border-t border-slate-200/80 px-4 py-3 transition-colors sm:px-6 ${
      dragging ? 'bg-indigo-50/60' : ''
    }`}
  >
    <div className="mb-2 flex items-center gap-2 text-[11.5px] font-medium uppercase tracking-wide text-slate-400">
      <Paperclip className="h-3.5 w-3.5" />
      附件
      {attachments.length > 0 && <span className="text-slate-300">{attachments.length}</span>}
    </div>

    {attachments.length === 0 ? (
      <p className="text-[12.5px] text-slate-400">
        {dragging
          ? '松开即可 · md / html / txt 会导入为笔记'
          : 'PDF、图片等拖到这里作为附件；md / html / txt 会导入为笔记'}
      </p>
    ) : (
      <ul className="flex flex-wrap gap-2">
        {attachments.map((a) => (
          <li
            key={a.id}
            className="group flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[12.5px]"
          >
            <FileText className="h-3.5 w-3.5 shrink-0 text-slate-400" />
            <button
              type="button"
              onClick={() => (isPreviewable(a.mimeType) ? onPreview(a) : downloadAttachment(a.id, a.filename))}
              className="max-w-[180px] truncate text-slate-700 hover:text-indigo-700"
              title={a.filename}
            >
              {a.filename}
            </button>
            <span className="text-slate-400">{formatSize(a.size)}</span>
            <button
              type="button"
              aria-label={`删除附件 ${a.filename}`}
              onClick={() => onDelete(a.id)}
              className="rounded p-0.5 text-slate-300 transition-colors hover:text-red-600"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    )}
  </div>
);
