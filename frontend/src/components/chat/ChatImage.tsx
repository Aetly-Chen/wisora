import React, { useEffect, useState } from 'react';
import { ImageOff, Loader2 } from 'lucide-react';
import { fetchChatAttachmentBlob } from '@/request/chat';
import type { ChatAttachment } from '@/types/chat';

/**
 * 聊天图片。
 *
 * 存在的唯一理由：附件接口需要 Authorization 头，而 `<img src>` 带不上
 * 自定义头 —— 直接把服务端给的 previewUrl 塞进 src 会 401，图片全碎。
 *
 * 所以这里统一「先 fetch 成 Blob，再转 objectURL」。笔记模块的
 * AttachmentPreview 是同一套做法。
 *
 * objectUrl（本地刚选的文件）优先于 previewUrl：自己发的图不该再绕一圈网络。
 */
export const ChatImage: React.FC<{
  attachment: ChatAttachment;
  className?: string;
}> = ({ attachment, className }) => {
  const localUrl = attachment.objectUrl;
  const [blobUrl, setBlobUrl] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // 本地已有预览地址，或服务端没给（非图片），都不需要取流
    if (localUrl || !attachment.previewUrl) {
      if (!localUrl && !attachment.previewUrl) setFailed(true);
      return;
    }

    let cancelled = false;
    let created: string | undefined;

    void fetchChatAttachmentBlob(attachment.id)
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setBlobUrl(created);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      /*
       * 必须 revoke：聊天页一屏可能几十张图，滚过去又滚回来
       * 会不断产生新的 objectURL，不释放就是持续泄漏内存。
       */
      if (created) URL.revokeObjectURL(created);
    };
  }, [attachment.id, attachment.previewUrl, localUrl]);

  const src = localUrl ?? blobUrl;

  if (failed) {
    return (
      <div className="flex h-32 w-56 items-center justify-center gap-2 rounded-lg bg-black/[0.05] text-[12px] text-tg-text-muted">
        <ImageOff className="h-4 w-4" />
        图片加载失败
      </div>
    );
  }

  if (!src) {
    return (
      <div className="flex h-32 w-56 items-center justify-center rounded-lg bg-black/[0.05] text-tg-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={attachment.name}
      loading="lazy"
      className={className ?? 'max-h-64 w-full rounded-lg object-cover'}
    />
  );
};
