import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { downloadAttachment, fetchAttachmentBlob } from '@/request/notes';
import type { AttachmentMeta } from '@/types/note';

/** 附件预览：图片走 img、PDF/文本走 iframe，其余只能下载 */
export const AttachmentPreview: React.FC<{
  attachment: AttachmentMeta | null;
  onClose: () => void;
}> = ({ attachment, onClose }) => {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState<string>();

  useEffect(() => {
    if (!attachment) {
      setUrl(undefined);
      setFailed(undefined);
      return;
    }
    let objectUrl: string | undefined;
    let cancelled = false;

    // 附件接口需要 Authorization 头，iframe 带不上，
    // 所以先取 Blob 再转 objectURL 交给浏览器原生渲染
    fetchAttachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((err: Error) => {
        if (!cancelled) setFailed(err.message);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment]);

  return (
    <Dialog open={!!attachment} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl gap-3 p-4 sm:p-5">
        <DialogHeader className="pr-8">
          <DialogTitle className="truncate text-[14px] font-medium text-slate-800">
            {attachment?.filename}
          </DialogTitle>
        </DialogHeader>

        <div className="flex h-[68vh] items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
          {failed ? (
            <p className="px-6 text-center text-[13px] text-slate-500">{failed}</p>
          ) : !url ? (
            <span className="flex items-center gap-2 text-[13px] text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在加载
            </span>
          ) : attachment?.mimeType.startsWith('image/') ? (
            <img src={url} alt={attachment.filename} className="max-h-full max-w-full object-contain" />
          ) : (
            <iframe src={url} title={attachment?.filename} className="h-full w-full" />
          )}
        </div>

        {attachment && (
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg text-[12.5px]"
              onClick={() => downloadAttachment(attachment.id, attachment.filename)}
            >
              下载原文件
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
