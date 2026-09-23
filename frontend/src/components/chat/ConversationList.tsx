import React from 'react';
import { Pin, VolumeX, Search, SquarePen } from 'lucide-react';
import type { Conversation, Friend, Message } from '@/types/chat';
import { formatListTime, peerAvatarClass } from '@/lib/chat-utils';
import { conversationPeer, conversationTitle } from '@/stores/useChatStore';
import { VirtualList } from '@/components/VirtualList';
import { Avatar } from '@/components/Avatar';

/**
 * 左侧会话列表（Telegram 版）。
 *
 * 与项目其它列表最大的区别是**选中项是实底蓝**，不是浅色卡片。
 * 这是 Telegram 桌面端最有辨识度的一处：打开哪个会话一眼可见，
 * 不需要靠"哪个卡片阴影深一点"去猜。代价是白字压蓝底，
 * 所以蓝色用的是加深档 --tg-brand-deep（白字 4.9:1），
 * 而不是原版的 #2aabee（只有 2.6:1，正文读不清）。
 *
 * 行高 72px 而不是共享的 44px：会话行要装下 48px 头像 + 两行文字，
 * 44px 会把摘要挤没。VirtualList 的 rowHeight 是可配的，见该组件注释。
 */

const ROW_HEIGHT = 72;

/**
 * 会话行里的摘要文案。
 *
 * 附件类消息不能直接显示 text（往往是空的），
 * 要按 kind 给出「[文件] 票据鉴权时序图.pdf」这种可读摘要，
 * 否则列表里会出现一整列空白。
 */
function messagePreview(message: Message | null, meId: string): string {
  if (!message) return '还没有消息';

  const prefix = message.senderId === meId ? '我：' : '';

  switch (message.kind) {
    case 'file':
      return `${prefix}[文件] ${message.attachment?.name ?? ''}`;
    case 'image':
      return `${prefix}[图片] ${message.text ?? message.attachment?.name ?? ''}`;
    case 'note':
      return `${prefix}[笔记] ${message.note?.title ?? ''}`;
    default:
      return `${prefix}${message.text ?? ''}`;
  }
}

interface ConversationListProps {
  conversations: Conversation[];
  friends: Friend[];
  meId: string;
  activeId?: string;
  loading: boolean;
  keyword: string;
  /** 会话 id → 正在输入的人 */
  typing: Record<string, string[]>;
  onKeywordChange: (value: string) => void;
  onOpen: (id: string) => void;
  onNewChat: () => void;
  onContextMenu: (e: React.MouseEvent, conversation: Conversation) => void;
}

export const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  friends,
  meId,
  activeId,
  loading,
  keyword,
  typing,
  onKeywordChange,
  onOpen,
  onNewChat,
  onContextMenu,
}) => (
  <div className="relative flex min-h-0 flex-1 flex-col">
    {/* 搜索：Telegram 是一个无描边的胶囊，靠浅底区分于列表的白底 */}
    <div className="relative px-3 pb-2 pt-1">
      <Search className="pointer-events-none absolute left-6 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-tg-text-muted" />
      <input
        value={keyword}
        onChange={(e) => onKeywordChange(e.target.value)}
        placeholder="搜索"
        aria-label="搜索会话"
        className="w-full rounded-full bg-tg-surface-hover py-2 pl-9 pr-3.5 text-[13px] text-tg-text-body placeholder:text-tg-text-muted focus:bg-white focus:ring-2 focus:ring-tg-brand-soft focus:outline-none"
      />
    </div>

    {loading ? (
      /* 骨架屏：形状对齐真实行，比居中转圈更能说明"这里将出现什么" */
      <div className="space-y-1 px-2 pt-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 px-2.5 py-2.5">
            <div className="h-12 w-12 shrink-0 animate-pulse rounded-full bg-black/[0.06]" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-3 w-1/3 animate-pulse rounded bg-black/[0.06]" />
              <div className="h-2.5 w-3/4 animate-pulse rounded bg-black/[0.045]" />
            </div>
          </div>
        ))}
      </div>
    ) : (
      <VirtualList
        count={conversations.length}
        rowHeight={ROW_HEIGHT}
        /* pb-20 给右下角的悬浮新建按钮让位，否则最后一行永远被压住 */
        className="min-h-0 flex-1 overflow-y-auto pb-20"
        data-testid="chat-conversation-list"
        empty={
          <div className="px-4 py-12 text-center">
            <p className="text-[13px] text-tg-text-muted">
              {keyword ? '没有匹配的会话' : '还没有会话'}
            </p>
            {!keyword && (
              <button
                type="button"
                onClick={onNewChat}
                className="mt-2 text-[13px] font-medium text-tg-brand hover:underline"
              >
                开始第一次聊天
              </button>
            )}
          </div>
        }
        renderRow={(index) => {
          const conversation = conversations[index];
          const title = conversationTitle(conversation, friends, meId);
          const peer = conversationPeer(conversation, friends, meId);
          const active = conversation.id === activeId;
          const typingUserIds = typing[conversation.id] ?? [];
          const typingName = typingUserIds.length
            ? friends.find((f) => f.id === typingUserIds[0])?.name
            : undefined;

          /*
           * 选中行整行反白，所有子元素都要跟着换色。
           * 单独铺一个 `active && 'text-white'` 是没用的：子元素各自
           * 带了显式颜色，父级的 color 继承不到。所以逐个分支。
           */
          const iconTone = active
            ? 'text-white'
            : 'text-tg-text-muted';

          return (
            <div
              role="button"
              tabIndex={0}
              onClick={() => onOpen(conversation.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(conversation.id);
                }
              }}
              onContextMenu={(e) => onContextMenu(e, conversation)}
              data-conversation-row={conversation.id}
              aria-current={active ? 'true' : undefined}
              className={`group flex h-full cursor-pointer items-center gap-3 px-3 transition-colors ${
                active
                  ? 'bg-tg-brand-deep'
                  : 'hover:bg-tg-surface-hover'
              }`}
            >
              <Avatar
                id={peer?.id ?? conversation.id}
                name={title}
                size="lg"
                presence={peer?.presence}
                group={conversation.kind === 'group'}
                fill={peerAvatarClass(peer?.id ?? conversation.id)}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {conversation.pinned && (
                    <Pin className={`h-3 w-3 shrink-0 ${iconTone}`} />
                  )}
                  <span
                    className={`truncate text-[14px] font-medium ${
                      active ? 'text-white' : 'text-tg-text'
                    }`}
                  >
                    {title}
                  </span>
                  {conversation.muted && (
                    <VolumeX className={`h-3 w-3 shrink-0 ${iconTone}`} />
                  )}
                  <span
                    className={`ml-auto shrink-0 text-[12px] ${
                      active ? 'text-white' : 'text-tg-text-muted'
                    }`}
                  >
                    {conversation.lastMessage
                      ? formatListTime(conversation.lastMessage.createdAt)
                      : ''}
                  </span>
                </div>

                <div className="mt-1 flex items-center gap-2">
                  {typingName ? (
                    <span
                      className={`truncate text-[13px] ${
                        active ? 'text-white' : 'text-tg-brand'
                      }`}
                    >
                      {conversation.kind === 'group' ? `${typingName} 正在输入…` : '正在输入…'}
                    </span>
                  ) : (
                    <span
                      className={`truncate text-[13px] ${
                        active ? 'text-white' : 'text-tg-text-muted'
                      }`}
                    >
                      {messagePreview(conversation.lastMessage, meId)}
                    </span>
                  )}

                  {conversation.unread > 0 &&
                    (conversation.muted ? (
                      /* 免打扰：只留一个点。显示数字会让人以为"还是要处理" */
                      <span
                        className={`ml-auto h-2 w-2 shrink-0 rounded-full ${
                          active ? 'bg-white' : 'bg-tg-text-soft'
                        }`}
                      />
                    ) : (
                      <span
                        className={`ml-auto flex h-[20px] min-w-[20px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11.5px] font-semibold ${
                          active
                            ? 'bg-white text-tg-brand-deep'
                            : 'bg-tg-online text-white'
                        }`}
                      >
                        {conversation.unread > 99 ? '99+' : conversation.unread}
                      </span>
                    ))}
                </div>
              </div>
            </div>
          );
        }}
      />
    )}

    {/*
      新建聊天：Telegram 是右下角的圆形悬浮按钮，不占列表高度。
      走 --tg-brand-press 而不是 --tg-brand：白图标压在 #2aabee 上
      只有 2.6:1，连图形的 3:1 都不到。
    */}
    <button
      type="button"
      onClick={onNewChat}
      aria-label="新建聊天"
      title="新建聊天"
      className="absolute right-4 bottom-4 flex h-12 w-12 items-center justify-center rounded-full bg-tg-brand-press text-white shadow-[0_2px_10px_rgb(0_0_0/0.22)] transition-transform hover:bg-tg-brand-deep active:scale-[0.96]"
    >
      <SquarePen className="h-5 w-5" />
    </button>
  </div>
);
