import React from 'react';
import { Pin, VolumeX, Search, Plus } from 'lucide-react';
import type { Conversation, Friend, Message } from '@/types/chat';
import { formatListTime } from '@/lib/chat-utils';
import { conversationPeer, conversationTitle } from '@/stores/useChatStore';
import { VirtualList } from '@/components/VirtualList';
import { Avatar } from '@/components/Avatar';

/**
 * 左侧会话列表。
 *
 * 结构照 Telegram：搜索框在最上，下面是会话行（头像 + 标题 + 摘要 + 时间），
 * 未读用数字气泡，免打扰的会话只显示一个小点不显示数字。
 *
 * 行高 68px 而不是共享的 44px：会话行要装下头像 + 两行文字，
 * 44px 会把摘要挤没。VirtualList 的 rowHeight 是可配的，见该组件注释。
 */

const ROW_HEIGHT = 68;

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
  <div className="flex min-h-0 flex-1 flex-col">
    {/* 搜索 */}
    <div className="relative px-2.5 pb-2">
      <Search className="pointer-events-none absolute left-5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input
        value={keyword}
        onChange={(e) => onKeywordChange(e.target.value)}
        placeholder="搜索会话"
        aria-label="搜索会话"
        className="w-full rounded-lg border border-slate-200/80 bg-white py-1.5 pl-8 pr-2.5 text-[12.5px] text-slate-700 placeholder:text-slate-400 focus:border-indigo-300 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </div>

    {loading ? (
      /* 骨架屏：形状对齐真实行，比居中转圈更能说明"这里将出现什么" */
      <div className="space-y-1 px-2 pt-1">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-2.5 px-1.5 py-2">
            <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-slate-900/[0.05]" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <div className="h-3 w-1/3 animate-pulse rounded bg-slate-900/[0.05]" />
              <div className="h-2.5 w-3/4 animate-pulse rounded bg-slate-900/[0.04]" />
            </div>
          </div>
        ))}
      </div>
    ) : (
      <VirtualList
        count={conversations.length}
        rowHeight={ROW_HEIGHT}
        className="min-h-0 flex-1 overflow-y-auto px-2"
        data-testid="chat-conversation-list"
        empty={
          <div className="px-3 py-12 text-center">
            <p className="text-[13px] text-slate-500">
              {keyword ? '没有匹配的会话' : '还没有会话'}
            </p>
            {!keyword && (
              <button
                type="button"
                onClick={onNewChat}
                className="mt-2 text-[12.5px] text-indigo-600 hover:underline"
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
              className={`group flex h-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 transition-colors ${
                active
                  ? 'bg-white shadow-sm ring-1 ring-slate-900/5'
                  : 'hover:bg-slate-900/[0.035]'
              }`}
            >
              <Avatar
                id={peer?.id ?? conversation.id}
                name={title}
                presence={peer?.presence}
                group={conversation.kind === 'group'}
              />

              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  {conversation.pinned && (
                    <Pin className="h-3 w-3 shrink-0 text-slate-400" />
                  )}
                  <span className="truncate text-[13px] font-medium text-slate-800">
                    {title}
                  </span>
                  {conversation.muted && (
                    <VolumeX className="h-3 w-3 shrink-0 text-slate-300" />
                  )}
                  <span className="ml-auto shrink-0 text-[10.5px] text-slate-400">
                    {conversation.lastMessage
                      ? formatListTime(conversation.lastMessage.createdAt)
                      : ''}
                  </span>
                </div>

                <div className="mt-0.5 flex items-center gap-2">
                  {typingName ? (
                    <span className="truncate text-[12px] text-indigo-600">
                      {conversation.kind === 'group' ? `${typingName} 正在输入…` : '正在输入…'}
                    </span>
                  ) : (
                    <span className="truncate text-[12px] text-slate-500">
                      {messagePreview(conversation.lastMessage, meId)}
                    </span>
                  )}

                  {conversation.unread > 0 &&
                    (conversation.muted ? (
                      /* 免打扰：只留一个点。显示数字会让人以为"还是要处理" */
                      <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
                    ) : (
                      <span className="ml-auto flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-indigo-600 px-1.5 text-[10.5px] font-semibold text-white">
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

    {/* 新建聊天：固定在底部，不随列表滚动 */}
    <div className="px-2.5 pt-1.5">
      <button
        type="button"
        onClick={onNewChat}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2 text-[12.5px] text-slate-500 transition-colors hover:border-indigo-300 hover:bg-indigo-50/60 hover:text-indigo-600"
      >
        <Plus className="h-3.5 w-3.5" />
        新建聊天
      </button>
    </div>
  </div>
);
