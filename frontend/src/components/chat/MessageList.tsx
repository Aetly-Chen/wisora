import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  Check,
  CheckCheck,
  FileText,
  Folder,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import type { Conversation, Friend, Message } from '@/types/chat';
import {
  FILE_KIND_LABEL,
  fileKind,
  formatBytes,
  formatClock,
  formatDayDivider,
  isPreviewableImage,
} from '@/lib/chat-utils';
import { downloadChatAttachment } from '@/request/chat';
import { Avatar } from '@/components/Avatar';
import { ChatImage } from './ChatImage';

/**
 * 消息流。
 *
 * 气泡分组与 Telegram 对齐：同一个人 5 分钟内的连续消息收紧间距、
 * 只在最后一条挂头像。不分组的话，逐条消息都顶着一个头像，
 * 一屏能看到的对话轮次会少很多。
 *
 * 两个容易被忽略但很影响体验的细节：
 * 1. **自动滚到底只在用户本来就在底部时发生**。用户往上翻历史时
 *    来了新消息就把他拽回底部，是聊天类产品最招人烦的行为之一。
 * 2. **失败的消息不删**，标红并给重试入口。直接删掉会把用户写的内容弄丢。
 */

/** 同一个人的连续消息在这个时间窗口内视为一组 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** 距底部小于这个距离就算「在底部」 */
const BOTTOM_THRESHOLD = 80;

interface MessageListProps {
  conversation: Conversation;
  messages: Message[];
  friends: Friend[];
  meId: string;
  loading: boolean;
  /** 正在输入的人（会话里除我之外的成员） */
  typingUserIds: string[];
  onRetry: (messageId: string) => void;
  onOpenNote: (noteId: string) => void;
}

interface RenderItem {
  message: Message;
  /** 需要在该消息前插入日期分隔 */
  dayDivider?: string;
  /** 一组连续消息的起始（要显示发送者名与头像位） */
  firstOfGroup: boolean;
  /** 一组连续消息的结束（头像挂在这里） */
  lastOfGroup: boolean;
}

/* ------------------------------ 气泡内的附件 ------------------------------ */

const FileCard: React.FC<{ message: Message; mine: boolean }> = ({ message, mine }) => {
  const attachment = message.attachment;
  if (!attachment) return null;

  const kind = fileKind(attachment.name, attachment.mimeType);

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 ${
        mine ? 'bg-white/60' : 'bg-slate-50'
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          mine ? 'bg-indigo-100 text-indigo-600' : 'bg-white text-slate-500 ring-1 ring-slate-200/70'
        }`}
      >
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[12.5px] font-medium text-slate-800">
          {attachment.name}
        </p>
        <p className="text-[11px] text-slate-500">
          {FILE_KIND_LABEL[kind]} · {formatBytes(attachment.size)}
        </p>
      </div>
      {/*
        下载必须走接口取流，不能用 <a href={previewUrl} download> ——
        附件接口需要 Authorization 头，而导航跳转带不上自定义头，会 401。
      */}
      <button
        type="button"
        onClick={() => void downloadChatAttachment(attachment.id, attachment.name)}
        className="shrink-0 rounded-lg px-2 py-1 text-[11.5px] font-medium text-indigo-600 transition-colors hover:bg-indigo-50"
      >
        下载
      </button>
    </div>
  );
};

const NoteCard: React.FC<{
  message: Message;
  mine: boolean;
  onOpenNote: (noteId: string) => void;
}> = ({ message, mine, onOpenNote }) => {
  const note = message.note;
  if (!note) return null;

  const isFolder = note.kind === 'folder';

  return (
    <button
      type="button"
      onClick={() => onOpenNote(note.noteId)}
      className={`w-full rounded-lg px-2.5 py-2 text-left transition-colors ${
        mine
          ? 'bg-white/60 hover:bg-white/80'
          : 'bg-slate-50 hover:bg-slate-100'
      }`}
    >
      <div className="flex items-center gap-2">
        {isFolder ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-indigo-500" />
        )}
        <span className="truncate text-[12.5px] font-medium text-slate-800">
          {note.title}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-slate-500">
        {isFolder
          ? note.childCount > 0
            ? `目录 · 含 ${note.childCount} 个子页面`
            : '目录'
          : '笔记'}
        <span className="ml-1.5 text-indigo-600">点击打开</span>
      </p>
    </button>
  );
};

/* ------------------------------ 主组件 ------------------------------ */

export const MessageList: React.FC<MessageListProps> = ({
  conversation,
  messages,
  friends,
  meId,
  loading,
  typingUserIds,
  onRetry,
  onOpenNote,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  const isGroup = conversation.kind === 'group';

  const items = useMemo(() => {
    // 分组预处理放在 useMemo 里：每渲染一次都重算会把长会话拖慢
    const result: RenderItem[] = [];
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      const previous = messages[index - 1];
      const next = messages[index + 1];

      const dayChanged =
        !previous ||
        new Date(previous.createdAt).toDateString() !==
          new Date(message.createdAt).toDateString();

      const gap = previous
        ? new Date(message.createdAt).getTime() -
          new Date(previous.createdAt).getTime()
        : Number.POSITIVE_INFINITY;

      const sameSenderAsPrev =
        !!previous && previous.senderId === message.senderId && !dayChanged;
      const firstOfGroup = !sameSenderAsPrev || gap > GROUP_WINDOW_MS;

      const nextSameSender =
        !!next &&
        next.senderId === message.senderId &&
        new Date(next.createdAt).toDateString() ===
          new Date(message.createdAt).toDateString() &&
        new Date(next.createdAt).getTime() -
          new Date(message.createdAt).getTime() <=
          GROUP_WINDOW_MS;

      result.push({
        message,
        dayDivider: dayChanged ? formatDayDivider(message.createdAt) : undefined,
        firstOfGroup,
        lastOfGroup: !nextSameSender,
      });
    }
    return result;
  }, [messages]);

  const scrollToBottom = (smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    atBottomRef.current = true;
    setShowJumpButton(false);
  };

  // 切换会话时直接跳到底部（不要平滑滚动，否则会看到"从中间滑下去"）
  useEffect(() => {
    scrollToBottom(false);
  }, [conversation.id]);

  // 有新消息时，只有用户本来就在底部才跟着滚
  useEffect(() => {
    if (atBottomRef.current) scrollToBottom(false);
  }, [messages.length]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < BOTTOM_THRESHOLD;
    setShowJumpButton(!atBottomRef.current && messages.length > 6);
  };

  const typingNames = typingUserIds
    .map((id) => friends.find((f) => f.id === id)?.name)
    .filter(Boolean)
    .join('、');

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-3 py-3 sm:px-5"
        data-testid="chat-message-list"
      >
        {loading ? (
          <div className="mx-auto max-w-2xl space-y-4 pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex gap-2.5">
                <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-900/[0.05]" />
                <div className="h-14 w-2/5 animate-pulse rounded-2xl bg-slate-900/[0.045]" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="text-[13px] text-slate-500">还没有消息</p>
            <p className="mt-1 text-[12px] text-slate-400">
              发一条消息，或者把笔记分享过来
            </p>
          </div>
        ) : (
          /*
           * min-h-full + justify-end：让消息贴着输入框排列。
           * 不这么做的话，短会话的消息会停在顶部、下方留一大片空白 ——
           * 与用户「消息从底部往上堆」的预期相反，滚动时也会先看到空白。
           */
          <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end">
            {items.map((item) => {
              const { message, dayDivider, firstOfGroup, lastOfGroup } = item;
              const mine = message.senderId === meId;
              const sender = friends.find((f) => f.id === message.senderId);

              return (
                <React.Fragment key={message.id}>
                  {dayDivider && (
                    /* 日期分隔做成居中胶囊：长会话靠它定位 */
                    <div className="my-3 flex justify-center">
                      <span className="rounded-full bg-slate-900/[0.05] px-2.5 py-0.5 text-[10.5px] font-medium text-slate-500">
                        {dayDivider}
                      </span>
                    </div>
                  )}

                  <div
                    className={`flex items-end gap-2 ${
                      mine ? 'justify-end' : 'justify-start'
                    } ${firstOfGroup ? 'mt-2.5' : 'mt-0.5'}`}
                  >
                    {/* 对方消息左侧留头像位；非组尾用等宽占位，保证气泡对齐 */}
                    {!mine &&
                      (lastOfGroup ? (
                        <Avatar
                          id={message.senderId}
                          name={sender?.name ?? '?'}
                          size="sm"
                          className="mb-0.5"
                        />
                      ) : (
                        <span className="h-7 w-7 shrink-0" aria-hidden />
                      ))}

                    <div className="flex max-w-[min(560px,78%)] flex-col">
                      {/* 群聊里只在每组的首条显示发送者名 */}
                      {isGroup && !mine && firstOfGroup && (
                        <span className="mb-0.5 pl-1 text-[11px] font-medium text-slate-500">
                          {sender?.name ?? '未知成员'}
                        </span>
                      )}

                      <div
                        className={`rounded-2xl px-3 py-1.5 text-[13px] leading-relaxed shadow-sm ${
                          mine
                            ? 'bg-indigo-50 text-slate-800 ring-1 ring-indigo-100'
                            : 'bg-white text-slate-800 ring-1 ring-slate-200/80'
                        } ${mine ? 'rounded-br-md' : 'rounded-bl-md'}`}
                      >
                        {message.kind === 'image' && message.attachment && (
                          <div className="space-y-1.5">
                            {isPreviewableImage(message.attachment) ? (
                              <ChatImage attachment={message.attachment} />
                            ) : (
                              <div className="flex h-32 items-center justify-center rounded-lg bg-slate-100 text-[12px] text-slate-400">
                                图片预览不可用
                              </div>
                            )}
                            {message.text && <p>{message.text}</p>}
                          </div>
                        )}

                        {message.kind === 'file' && (
                          <FileCard message={message} mine={mine} />
                        )}

                        {message.kind === 'note' && (
                          <div className="space-y-1.5">
                            <NoteCard message={message} mine={mine} onOpenNote={onOpenNote} />
                            {message.text && (
                              <p className="px-0.5 text-[12.5px]">{message.text}</p>
                            )}
                          </div>
                        )}

                        {message.kind === 'text' && <p>{message.text}</p>}

                        {/* 时间与状态放在气泡内右下角，不额外占一行 */}
                        <div
                          className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${
                            mine ? 'text-slate-400' : 'text-slate-400'
                          }`}
                        >
                          <span>{formatClock(message.createdAt)}</span>
                          {mine && (
                            <>
                              {message.status === 'sending' && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              )}
                              {message.status === 'sent' && (
                                <Check className="h-3 w-3" aria-label="已发送" />
                              )}
                              {message.status === 'read' && (
                                <CheckCheck
                                  className="h-3 w-3 text-indigo-500"
                                  aria-label="已读"
                                />
                              )}
                              {message.status === 'failed' && (
                                <button
                                  type="button"
                                  onClick={() => onRetry(message.id)}
                                  className="flex items-center gap-0.5 text-red-500 hover:text-red-600"
                                >
                                  <RotateCcw className="h-3 w-3" />
                                  重发
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            })}

            {/* 正在输入：三个跳动的点，Telegram 的经典指示 */}
            {typingNames && (
              <div className="mt-2.5 flex items-center gap-2">
                <span className="h-7 w-7 shrink-0" aria-hidden />
                <div className="rounded-2xl rounded-bl-md bg-white px-3 py-2 ring-1 ring-slate-200/80">
                  <span className="flex items-center gap-1" aria-label={`${typingNames} 正在输入`}>
                    {[0, 1, 2].map((i) => (
                      <span
                        key={i}
                        className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300"
                        style={{ animationDelay: `${i * 120}ms` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 离开底部时才出现，避免和输入框抢注意力 */}
      {showJumpButton && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          className="absolute bottom-4 right-5 flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-[11.5px] text-slate-600 shadow-md transition-colors hover:bg-slate-50"
        >
          <ArrowDown className="h-3.5 w-3.5" />
          回到最新
        </button>
      )}
    </div>
  );
};
