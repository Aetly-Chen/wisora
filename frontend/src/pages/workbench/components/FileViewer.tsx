import React, { useEffect, useState } from 'react';
import { Download, FileQuestion, Loader2 } from 'lucide-react';
import { ensureSigned, getAttachmentUrl } from '@/lib/attachment-url';
import type { AttachmentMeta } from '@/types/note';

/**
 * 工作区文件预览（中栏）。
 *
 * 定位是「像 VS Code 一样点文件看内容」，所以：
 * - **只读**，不提供编辑。笔记正文才走编辑器，文件是附件（pdf/图片/md/txt 等）。
 * - **按 MIME 分流**：图片直接 `<img>`、pdf 用 `<iframe>`、文本按纯文本渲染、
 *   其它给下载入口。不做「猜类型」的骚操作，类型不可用就落到下载。
 *
 * 为什么要签名：`<img src>` / `<iframe src>` 带不了 Authorization 头，
 * `/attachments/:id/content` 挂了 guard 必然 401。所以先用 `POST /attachments/sign`
 * 换一个带 HMAC 的短时直链（见后端 attachments-public.controller）。
 *
 * ⚠️ 签名返回的是**相对路径**，必须经 `lib/attachment-url` 拼上 `VITE_BASE_API`：
 * 直接把相对路径交给 fetch，请求会落到前端 dev server，被 SPA fallback 返回
 * index.html（第一版就是这么把一整页 HTML 渲染进预览区的）。
 */
const TEXT_LIMIT = 200_000; // 超过 200KB 不渲染，改成下载（浏览器会卡）

const isText = (mime: string) =>
  mime.startsWith('text/') ||
  mime === 'application/json' ||
  mime === 'text/markdown';

const isImage = (mime: string) => mime.startsWith('image/');
const isPdf = (mime: string) => mime === 'application/pdf';

export const FileViewer: React.FC<{ file: AttachmentMeta; noteTitle?: string }> = ({
  file,
  noteTitle,
}) => {
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setText(null);
    setUrl(null);

    void (async () => {
      try {
        /*
         * 必须走 lib/attachment-url：它会把相对路径拼上 VITE_BASE_API 并缓存。
         * 直接 fetch(`/attachments/...`) 会打到前端 dev server 上，
         * 被 SPA fallback 接走、返回 index.html（实测渲染出一整页 HTML 源码）。
         */
        await ensureSigned([file.id]);
        const href = getAttachmentUrl(file.id);
        if (!href) throw new Error('拿不到签名链接');
        if (cancelled) return;
        setUrl(href);

        // 文本类额外把内容取回来渲染（PDF/图片交给浏览器）
        if (isText(file.mimeType) && file.size <= TEXT_LIMIT) {
          const res = await fetch(href);
          if (!res.ok) throw new Error(`读取失败（${res.status}）`);
          const raw = await res.text();
          if (!cancelled) setText(raw);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file.id, file.mimeType, file.size]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-slate-400">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        <span className="text-[12.5px]">读取文件…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-slate-500">
        <FileQuestion className="h-6 w-6 text-slate-300" />
        <p className="text-[12.5px]">{error}</p>
        {url && (
          <a
            href={url}
            download={file.filename}
            className="text-[12.5px] text-slate-600 underline underline-offset-2"
          >
            直接下载
          </a>
        )}
      </div>
    );
  }

  /* 文本：等宽 + 行号栏留白，读起来像「源文件」而不是渲染后的文章 */
  if (text !== null) {
    return (
      <div className="flex h-full flex-col bg-white">
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-6 py-5 font-mono text-[12.5px] leading-[1.75] text-slate-700">
          {text || '（空文件）'}
        </pre>
        {file.size > TEXT_LIMIT && (
          <p className="border-t border-slate-200/70 px-6 py-2 text-[11.5px] text-slate-500">
            文件较大，只展示了开头部分
          </p>
        )}
      </div>
    );
  }

  if (isImage(file.mimeType) && url) {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-[#f4f3ef] p-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={file.filename}
          className="max-h-full max-w-full rounded-sm border border-slate-200 bg-white object-contain shadow-sm"
        />
      </div>
    );
  }

  if (isPdf(file.mimeType) && url) {
    return (
      <iframe
        src={url}
        title={file.filename}
        className="h-full w-full border-0 bg-[#f4f3ef]"
      />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-slate-500">
      <FileQuestion className="h-7 w-7 text-slate-300" />
      <p className="text-[12.5px]">这种类型（{file.mimeType || '未知'}）不能内嵌预览</p>
      {url && (
        <a
          href={url}
          download={file.filename}
          className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
        >
          <Download className="h-3.5 w-3.5" />
          下载 {noteTitle ? `（来自《${noteTitle}》）` : ''}
        </a>
      )}
    </div>
  );
};

export default FileViewer;
