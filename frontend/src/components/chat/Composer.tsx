import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Send, Upload, X } from 'lucide-react';
import { CHAT_FILE_MAX_BYTES, formatBytes } from '@/lib/chat-utils';

/**
 * 输入区。
 *
 * 四个不写会出问题的点：
 *
 * 1. **中文输入法**。拼音选字时按 Enter 是「确认候选词」，不是「发送」。
 *    不判断 isComposing 的话，中文用户每打一句都会被提前发出去
 *    （而且发出去的是半截拼音）。
 * 2. **高度自增但要有上限**。写长消息时输入框要跟着长，
 *    但长到占掉半个屏幕就得自己滚，否则消息流被挤没。
 * 3. **拖拽计数**。dragenter/leave 会在子元素间来回触发，
 *    用深度计数才能判断"真正离开"，否则拖过按钮就会闪一下。
 * 4. **上传中禁止再次发送**。否则用户连点会同时发起多个上传。
 */

/** 输入框最大高度，超过就内部滚动 */
const MAX_TEXTAREA_HEIGHT = 160;

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** 没有选中会话时为 true，整个输入区禁用 */
  disabled: boolean;
  sending: boolean;
  upload?: { name: string; percent: number };
  onAttachFile: (file: File) => void;
}

export const Composer: React.FC<ComposerProps> = ({
  value,
  onChange,
  onSubmit,
  disabled,
  sending,
  upload,
  onAttachFile,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  // 高度自增：先归零再按 scrollHeight 设，否则删字时高度不会回落
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  // 切换会话时把焦点放回输入框，省去用户一次点击
  useEffect(() => {
    if (!disabled) textareaRef.current?.focus();
  }, [disabled]);

  const canSend = value.trim().length > 0 && !disabled && !sending && !upload;

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;

    // 输入法组合中：这个 Enter 属于输入法，不归我们管
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    if (e.shiftKey) return; // Shift+Enter 交给默认行为（换行）

    e.preventDefault();
    if (canSend) onSubmit();
  };

  const pickFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    if (file.size > CHAT_FILE_MAX_BYTES) return;
    onAttachFile(file);
  };

  return (
    <div
      onDragEnter={(e) => {
        if (disabled) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
      }}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        if (disabled) return;
        pickFiles(e.dataTransfer.files);
      }}
      className={`shrink-0 border-t border-slate-200/80 px-3 py-2.5 transition-colors sm:px-5 ${
        dragging ? 'bg-indigo-50/60' : ''
      }`}
    >
      <div className="mx-auto max-w-3xl">
        {upload ? (
          /* 上传中：用进度条替换整个输入行，避免用户以为卡住了 */
          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-2.5">
            <Upload className="h-4 w-4 shrink-0 text-indigo-500" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[12.5px] text-slate-700">{upload.name}</p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-indigo-500 transition-[width] duration-150"
                  style={{ width: `${upload.percent}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 font-mono text-[11px] text-slate-500">
              {upload.percent}%
            </span>
          </div>
        ) : (
          <div
            className={`flex items-end gap-2 rounded-2xl border bg-white px-2 py-1.5 transition-shadow focus-within:border-slate-300 focus-within:shadow-md ${
              dragging ? 'border-indigo-300' : 'border-slate-200/80'
            }`}
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              title={`发送文件（单文件不超过 ${formatBytes(CHAT_FILE_MAX_BYTES)}）`}
              aria-label="发送文件"
              className="shrink-0 rounded-full p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip className="h-4 w-4" />
            </button>

            <input
              ref={fileRef}
              type="file"
              hidden
              onChange={(e) => {
                pickFiles(e.target.files);
                // 清空以便连续选同一个文件也能触发 change
                e.target.value = '';
              }}
            />

            <textarea
              ref={textareaRef}
              value={value}
              rows={1}
              disabled={disabled}
              placeholder={disabled ? '选择一个会话后开始输入' : '输入消息，Enter 发送'}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              className="min-w-0 flex-1 resize-none border-0 bg-transparent py-2 text-[13px] leading-relaxed text-slate-800 placeholder:text-slate-400 focus:outline-none disabled:cursor-not-allowed"
            />

            {value.trim() && (
              <button
                type="button"
                onClick={() => onChange('')}
                aria-label="清空输入"
                className="shrink-0 rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}

            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="发送"
              className="shrink-0 rounded-full bg-indigo-600 p-2 text-white transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>
        )}

        <p className="mt-1.5 px-1 text-[10.5px] text-slate-400">
          {dragging
            ? '松开即可发送该文件'
            : 'Enter 发送，Shift + Enter 换行；也可以把文件拖到这里'}
        </p>
      </div>
    </div>
  );
};
