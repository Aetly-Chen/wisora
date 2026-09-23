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
  peerAvatarClass,
  peerNameClass,
} from '@/lib/chat-utils';
import { downloadChatAttachment } from '@/request/chat';
import { Avatar } from '@/components/Avatar';
import { ChatImage } from './ChatImage';

/**
 * 消息流（Telegram 版）。
 *
 * 与项目其它区域的视觉差异集中在这里，三处是「Telegram 之所以是 Telegram」：
 *
 * 1. **自己发的是浅绿气泡 #effdde，对方是白气泡**。不是两侧同色，
 *    也不是"用户靠右蓝气泡"这种通用做法。
 * 2. **尾巴**只出现在一组连续消息的最后一条，且那一侧的圆角归零。
 *    逐条挂尾巴会让每条消息都像一个独立的对话框。
 * 3. **时间戳在气泡内右下角**，与已读勾同行，不额外占一行。
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

/** 尾巴尺寸。7×16 接近 Telegram 的比例，改大会显得笨重 */
const TAIL_W = 7;
const TAIL_H = 16;

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
  startOfGroup: boolean;
  /** 一组连续消息的结束（头像与尾巴挂在这里） */
  endOfGroup: boolean;
}

/**
 * 气泡圆角。
 *
 * 四个角分开写，而不是「先 rounded-xl 再覆盖某一个角」——
 * 同名属性上叠加两个 Tailwind 工具类，谁生效取决于生成顺序，
 * 这个项目已经在这上面栽过一次（见项目记忆里的 Tailwind 顺序一条）。
 * 分开写之后每个角只会输出一个类，不存在竞争。
 */
function bubbleRadius(mine: boolean, endOfGroup: boolean): string {
  const tailCorner = endOfGroup
    ? mine
      ? 'rounded-br-none'
      : 'rounded-bl-none'
    : undefined;

  const corners = [
    'rounded-tl-[12px]',
    'rounded-tr-[12px]',
    mine ? tailCorner ?? 'rounded-br-[12px]' : 'rounded-br-[12px]',
    mine ? 'rounded-bl-[12px]' : tailCorner ?? 'rounded-bl-[12px]',
  ];

  return corners.join(' ');
}

/* ------------------------------ 气泡尾巴 ------------------------------ */

/**
 * 气泡尾巴。
 *
 * 用 SVG 而不是那个常见的 CSS 三角 hack（border 拼三角形）：
 * 三角是两条直线，Telegram 的尾巴外缘是一条弧线，用三角会做出
 * "对话框"而不是"气球"。这里一条三次贝塞尔就够了。
 *
 * 位置由使用方的 padding 让出来（自己发的气泡右侧留 7px、
 * 对方左侧留 7px），尾巴绝对定位填在那条空隙里，而不是叠在气泡上 ——
 * 叠上去会把气泡的圆角盖住。
 */
const BubbleTail: React.FC<{ mine: boolean }> = ({ mine }) => (
  <svg
    viewBox={`0 0 ${TAIL_W} ${TAIL_H}`}
    width={TAIL_W}
    height={TAIL_H}
    aria-hidden
    className={`absolute bottom-0 ${mine ? 'right-0' : 'left-0'}`}
    style={{ fill: mine ? 'var(--tg-bubble-out)' : 'var(--tg-bubble-in)' }}
  >
    <path
      d={
        mine
          ? `M0 0 C0 6.5 2.2 11.4 ${TAIL_W} ${TAIL_H} L0 ${TAIL_H} Z`
          : `${TAIL_W} 0 C${TAIL_W} 6.5 4.8 11.4 0 ${TAIL_H} L${TAIL_W} ${TAIL_H} Z`
      }
    />
  </svg>
);

/* ------------------------------ 气泡内的附件 ------------------------------ */

const FileCard: React.FC<{ message: Message; mine: boolean }> = ({ message, mine }) => {
  const attachment = message.attachment;
  if (!attachment) return null;

  const kind = fileKind(attachment.name, attachment.mimeType);

  return (
    <div
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 ${
        mine ? 'bg-white/60' : 'bg-tg-surface-hover'
      }`}
    >
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-tg-brand-press ${
          mine ? '' : 'ring-1 ring-black/[0.05]'
        }`}
      >
        <FileText className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-tg-text-body">
          {attachment.name}
        </p>
        <p className="text-[11.5px] text-tg-text-muted">
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
        className="shrink-0 rounded-lg px-2 py-1 text-[12px] font-medium text-tg-brand-deep transition-colors hover:bg-black/[0.05]"
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
          ? 'bg-white/60 hover:bg-white/85'
          : 'bg-tg-surface-hover hover:bg-black/[0.06]'
      }`}
    >
      <div className="flex items-center gap-2">
        {isFolder ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-tg-brand-press" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-tg-brand-press" />
        )}
        <span className="truncate text-[13px] font-medium text-tg-text-body">
          {note.title}
        </span>
      </div>
      <p className="mt-0.5 text-[11.5px] text-tg-text-muted">
        {isFolder
          ? note.childCount > 0
            ? `目录 · 含 ${note.childCount} 个子页面`
            : '目录'
          : '笔记'}
        <span className="ml-1.5 font-medium text-tg-brand-deep">点击打开</span>
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
      const startOfGroup = !sameSenderAsPrev || gap > GROUP_WINDOW_MS;

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
        startOfGroup,
        endOfGroup: !nextSameSender,
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
          <div className="mx-auto max-w-3xl space-y-4 pt-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-end gap-2">
                <div
                  className={`h-12 w-12 shrink-0 animate-pulse rounded-full bg-black/[0.06] ${
                    i === 1 ? 'invisible' : ''
                  }`}
                />
                <div className="h-16 w-2/5 animate-pulse rounded-[12px] bg-black/[0.05]" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <p className="text-[14px] font-medium text-tg-text-body">
              还没有消息
            </p>
            <p className="mt-1 text-[13px] tg-wallpaper-text">
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
              const { message, dayDivider, startOfGroup, endOfGroup } = item;
              const mine = message.senderId === meId;
              const sender = friends.find((f) => f.id === message.senderId);

              /* 时间 + 发送状态。自己气泡里的时间与勾用同色系深绿，
                 灰字压在浅绿气泡上读不清（见 index.css 的 --tg-meta-out） */
              const meta = (
                <span
                  className={`inline-flex items-center gap-1 text-[11.5px] ${
                    mine
                      ? 'text-tg-meta-out'
                      : 'text-tg-text-muted'
                  }`}
                >
                  <span>{formatClock(message.createdAt)}</span>
                  {mine && (
                    <>
                      {message.status === 'sending' && (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      )}
                      {message.status === 'sent' && (
                        <Check className="h-3.5 w-3.5" aria-label="已发送" />
                      )}
                      {message.status === 'read' && (
                        <CheckCheck
                          className="h-3.5 w-3.5 text-tg-tick-read"
                          aria-label="已读"
                        />
                      )}
                      {message.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => onRetry(message.id)}
                          className="flex items-center gap-0.5 font-medium text-tg-danger hover:underline"
                        >
                          <RotateCcw className="h-3 w-3" />
                          重发
                        </button>
                      )}
                    </>
                  )}
                </span>
              );

              return (
                <React.Fragment key={message.id}>
                  {dayDivider && (
                    /* 日期分隔做成居中胶囊：长会话靠它定位 */
                    <div className="my-4 flex justify-center">
                      <span className="rounded-full bg-white/85 px-3 py-1 text-[12px] font-medium text-tg-text-body shadow-[0_1px_2px_rgb(0_0_0/0.05)] backdrop-blur-[2px]">
                        {dayDivider}
                      </span>
                    </div>
                  )}

                  <div
                    className={`flex items-end gap-2 ${
                      mine ? 'justify-end' : 'justify-start'
                    } ${startOfGroup ? 'mt-2.5' : 'mt-0.5'}`}
                  >
                    {/* 对方消息左侧留头像位；非组尾用等宽占位，保证气泡对齐 */}
                    {!mine &&
                      (endOfGroup ? (
                        <Avatar
                          id={message.senderId}
                          name={sender?.name ?? '?'}
                          size="lg"
                          className="mb-0.5"
                          fill={peerAvatarClass(message.senderId)}
                        />
                      ) : (
                        <span className="h-12 w-12 shrink-0" aria-hidden />
                      ))}

                    <div className="flex max-w-[min(560px,78%)] flex-col">
                      {/* 群聊里只在每组的首条显示发送者名，颜色按人固定 */}
                      {isGroup && !mine && startOfGroup && (
                        <span
                          className={`mb-0.5 pl-1.5 text-[13px] font-medium ${peerNameClass(
                            message.senderId,
                          )}`}
                        >
                          {sender?.name ?? '未知成员'}
                        </span>
                      )}

                      {/*
                        自己发的气泡右侧留出尾巴的空隙，对方的留在左侧。
                        空隙是恒定的，不能只给"组尾"留 —— 否则同一组里的
                        气泡会因为有没有尾巴而左右错位。
                      */}
                      <div className={`relative ${mine ? 'pr-[7px]' : 'pl-[7px]'}`}>
                        {endOfGroup && <BubbleTail mine={mine} />}

                        <div
                          className={`${bubbleRadius(mine, endOfGroup)} px-3 py-2 text-[14px] leading-[1.42] text-tg-text-body ${
                            /*
                             * 两个分支写成完整字面量，不要拼成
                             * `bg-tg-bubble-${mine ? 'out' : 'in'}`。
                             * Tailwind 是在构建期扫源码文本生成工具类的，
                             * 看不见模板拼接的结果 —— 那样写不会报错，
                             * 但类名不会被生成，气泡直接变成透明的。
                             */
                            mine ? 'bg-tg-bubble-out' : 'bg-tg-bubble-in'
                          }`}
                        >
                          {message.kind === 'image' && message.attachment && (
                            <div className="space-y-1.5">
                              {isPreviewableImage(message.attachment) ? (
                                <ChatImage attachment={message.attachment} />
                              ) : (
                                <div className="flex h-32 w-56 items-center justify-center rounded-lg bg-black/[0.05] text-[12px] text-tg-text-muted">
                                  图片预览不可用
                                </div>
                              )}
                            </div>
                          )}

                          {message.kind === 'file' && (
                            <FileCard message={message} mine={mine} />
                          )}

                          {message.kind === 'note' && (
                            <NoteCard message={message} mine={mine} onOpenNote={onOpenNote} />
                          )}

                          {/*
                           * 时间、状态与说明文字
                           *
                           * 说明文字（附件消息的附言）**只在这里渲染一次**。
                           * 之前把附言同时写在「图片块里」和这里，图片消息的
                           * 附言会重复显示两遍 —— 所以现在统一收到这一个分支，
                           * 各类型自己的块里不再碰 message.text。
                           *
                           * 纯文本气泡用 float-right 把时间塞进最后一行的行尾 ——
                           * Telegram 就是这样，短消息的时间就贴着文字右端，
                           * 只有排不下时才另起一行。做成独立一行的话，
                           * 每个气泡都会多出一条几乎空白的行，整屏立刻变松散。
                           *
                           * 卡片类（图片 / 文件 / 笔记）不适用：卡片自己占满宽度，
                           * 时间只能另起一行，所以走下面的块级版本。
                           */}
                          {message.kind === 'text' ? (
                            <p className="whitespace-pre-wrap break-words">
                              {message.text}
                              <span className="float-right relative top-[3px] ml-2.5">
                                {meta}
                              </span>
                            </p>
                          ) : (
                            <>
                              {message.text && (
                                <p className="mt-1.5 whitespace-pre-wrap break-words">
                                  {message.text}
                                </p>
                              )}
                              <div className="mt-1 flex justify-end">{meta}</div>
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
              <div className="mt-2.5 flex items-end gap-2">
                <span className="h-12 w-12 shrink-0" aria-hidden />
                <div className="relative pl-[7px]">
                  <BubbleTail mine={false} />
                  <div className="rounded-tl-[12px] rounded-tr-[12px] rounded-br-[12px] rounded-bl-none bg-tg-bubble-in px-3 py-2.5">
                    <span
                      className="flex items-center gap-1.5"
                      aria-label={`${typingNames} 正在输入`}
                    >
                      {[0, 1, 2].map((i) => (
                        <span
                          key={i}
                          className="h-2 w-2 animate-bounce rounded-full bg-tg-text-soft"
                          style={{ animationDelay: `${i * 120}ms` }}
                        />
                      ))}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/*
        离开底部时才出现，避免和输入框抢注意力。
        Telegram 这里是圆形无文字按钮，所以去掉可见文案，
        但保留 aria-label 与 title —— 图标语义不能只靠猜。
      */}
      {showJumpButton && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          aria-label="回到最新"
          title="回到最新"
          className="absolute right-4 bottom-4 flex h-11 w-11 items-center justify-center rounded-full bg-tg-surface text-tg-brand-deep shadow-[0_2px_10px_rgb(0_0_0/0.18)] transition-colors hover:bg-tg-surface-hover"
        >
          <ArrowDown className="h-5 w-5" />
        </button>
      )}
    </div>
  );
};
