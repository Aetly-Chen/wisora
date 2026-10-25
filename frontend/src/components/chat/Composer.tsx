import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Send, Upload, X } from 'lucide-react';
import { CHAT_COLUMN, CHAT_FILE_MAX_BYTES, formatBytes } from '@/lib/chat-utils';

/**
 * 输入区（Telegram 版）。
 *
 * 形态照 Telegram：一条白色圆角输入域，回形针在域内左侧，
 * 右侧是圆形的蓝底纸飞机按钮。整个输入区站在白色条带上，
 * 壁纸只铺到这一条的上沿为止 —— 输入框压在渐变壁纸上时，
 * 白底输入域和背景的边界会糊在一起。
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
  value: string; // 输入框文本，受控值
  onChange: (value: string) => void; // 文本变化时回传
  onSubmit: () => void; // 发送；Enter 在非输入法组合态触发
  /** 没有选中会话时为 true，整个输入区禁用 */
  disabled: boolean;
  sending: boolean; // 正在发送；按钮转圈并禁止再次提交
  upload?: { name: string; percent: number }; // 上传中的文件名与进度 0-100；有值时整行换成进度条
  onAttachFile: (file: File) => void; // 选中或拖入文件时回调，超限的已过滤
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
      /*
       * 底色两个分支必须互斥。
       * 写成「固定的 bg-tg-surface + 拖拽时再加 bg-tg-brand-tint」时，
       * 同一个元素上会有两个 background-color 工具类，谁生效只看
       * Tailwind 的生成顺序 —— 实测 bg-tg-surface 赢，拖拽高亮整块不显示
       * （而"松开即可发送该文件"的文案会变，所以很容易以为拖拽态是好的）。
       */
      className={`shrink-0 border-t border-tg-border-subtle px-3 py-2.5 transition-colors sm:px-5 ${
        dragging ? 'bg-tg-brand-tint' : 'bg-tg-surface'
      }`}
    >
      <div className={CHAT_COLUMN}>
        {upload ? (
          /* 上传中：用进度条替换整个输入行，避免用户以为卡住了 */
          <div className="flex items-center gap-3 rounded-[14px] border border-tg-border bg-tg-surface px-3 py-2.5">
            <Upload className="h-4 w-4 shrink-0 text-tg-brand-press" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-tg-text-body">
                {upload.name}
              </p>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-tg-surface-hover">
                <div
                  className="h-full rounded-full bg-tg-brand transition-[width] duration-150"
                  style={{ width: `${upload.percent}%` }}
                />
              </div>
            </div>
            <span className="shrink-0 font-mono text-[11.5px] text-tg-text-muted">
              {upload.percent}%
            </span>
          </div>
        ) : (
          <div
            className={`flex items-end gap-1 rounded-[14px] border bg-tg-surface px-1.5 py-1 transition-colors ${
              dragging
                ? 'border-tg-brand'
                : 'border-tg-border focus-within:border-tg-brand'
            }`}
          >
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled}
              title={`发送文件（单文件不超过 ${formatBytes(CHAT_FILE_MAX_BYTES)}）`}
              aria-label="发送文件"
              className="shrink-0 rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip className="h-5 w-5" />
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
              className="min-w-0 flex-1 resize-none border-0 bg-transparent py-2.5 text-[14px] leading-[1.4] text-tg-text-body placeholder:text-tg-text-muted focus:outline-none disabled:cursor-not-allowed"
            />

            {value.trim() && (
              <button
                type="button"
                onClick={() => onChange('')}
                aria-label="清空输入"
                className="shrink-0 rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover"
              >
                <X className="h-4 w-4" />
              </button>
            )}

            {/*
              发送按钮走加深档蓝：Telegram 原版用 #2aabee，白图标压上去
              只有 2.6:1，连图形要求的 3:1 都不到。
            */}
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="发送"
              className="mb-0.5 shrink-0 rounded-full bg-tg-brand-press p-2.5 text-white transition-colors hover:bg-tg-brand-deep disabled:cursor-not-allowed disabled:bg-tg-surface-hover disabled:text-tg-text-faint"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>
        )}

        <p className="mt-1.5 px-1 text-[11.5px] text-tg-text-muted">
          {dragging
            ? '松开即可发送该文件'
            : 'Enter 发送，Shift + Enter 换行；也可以把文件拖到这里'}
        </p>
      </div>
    </div>
  );
};
