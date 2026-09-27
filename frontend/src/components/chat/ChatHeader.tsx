import React, { useRef, useState } from 'react';
import { ArrowLeft, MoreVertical, Pin, PinOff, Volume2, VolumeX } from 'lucide-react';
import type { Conversation, Friend } from '@/types/chat';
import { CHAT_COLUMN, peerAvatarClass } from '@/lib/chat-utils';
import { conversationPeer, conversationTitle } from '@/stores/useChatStore';
import { ContextMenu } from '@/components/ContextMenu';
import { Avatar } from '@/components/Avatar';

/**
 * 会话头部（Telegram 版）。
 *
 * 三件事按 Telegram 的比例来：头像用 48px（和会话列表同一档，
 * 切换会话时头像位置不会跳）、名字 15px、状态行 13px。
 * 头部底色是纯白，只有底边一条 hairline，不做阴影 ——
 * 加了阴影之后会和下面的壁纸一起形成两层"浮起来"的东西。
 *
 * 副标题按会话类型给不同信息：
 * - 单聊：在线状态（在线 / 离开 / 离线），比显示"最后上线时间"更省空间
 * - 群聊：成员名字，最多 3 个，超出用「等 N 人」
 *
 * 「更多」复用了通用 ContextMenu 组件而不是另写一套下拉：
 * 两者的定位与关闭逻辑完全一样，再写一份必然出现
 * 「一个支持 Esc、另一个不支持」这种不一致。
 */

interface ChatHeaderProps {
  conversation: Conversation;
  friends: Friend[];
  meId: string;
  /** 正在输入的人名，非空时优先于在线状态显示 */
  typingName?: string;
  onBack?: () => void;
  onTogglePin: () => void;
  onToggleMute: () => void;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  conversation,
  friends,
  meId,
  typingName,
  onBack,
  onTogglePin,
  onToggleMute,
}) => {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const isGroup = conversation.kind === 'group';
  const title = conversationTitle(conversation, friends, meId);
  const peer = conversationPeer(conversation, friends, meId);

  const members = conversation.memberIds
    .map((id) => friends.find((f) => f.id === id))
    .filter((f): f is Friend => !!f);

  const subtitle = typingName
    ? isGroup
      ? `${typingName} 正在输入…`
      : '正在输入…'
    : isGroup
      ? `${members
          .slice(0, 3)
          .map((m) => m.name)
          .join('、')}${members.length > 3 ? ` 等 ${members.length} 人` : ''}`
      : peer?.presence === 'online'
        ? '在线'
        : peer?.presence === 'away'
          ? '离开'
          : '离线';

  return (
    /*
     * 分两层：外层只负责满宽的底色与下边框（分隔线要横贯整个会话区），
     * 内层用与消息列、输入区相同的列约束 —— 否则头像和名字会贴在窗口最左边，
     * 而下面的消息和输入框在中间，三条左基准线对不齐。
     */
    <div className="shrink-0 border-b border-tg-border-subtle bg-tg-surface px-3 py-2 sm:px-5">
      <div className={`${CHAT_COLUMN} flex items-center gap-3`}>
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="返回会话列表"
            className="-ml-1 shrink-0 rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover md:hidden"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}

        <Avatar
          id={peer?.id ?? conversation.id}
          name={title}
          size="lg"
          presence={peer?.presence}
          group={isGroup}
          fill={peerAvatarClass(peer?.id ?? conversation.id)}
        />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[15px] font-medium text-tg-text">
              {title}
            </h2>
            {conversation.muted && (
              <VolumeX
                className="h-3.5 w-3.5 shrink-0 text-tg-text-soft"
                aria-label="免打扰"
              />
            )}
          </div>
          <p
            className={`truncate text-[13px] ${
              typingName
                ? 'text-tg-brand'
                : 'text-tg-text-muted'
            }`}
          >
            {subtitle}
          </p>
        </div>

        <button
          ref={moreButtonRef}
          type="button"
          aria-label="会话设置"
          aria-haspopup="menu"
          aria-expanded={!!menuAt}
          onClick={() => {
            const rect = moreButtonRef.current?.getBoundingClientRect();
            setMenuAt(rect ? { x: rect.right - 184, y: rect.bottom + 6 } : { x: 0, y: 0 });
          }}
          className="shrink-0 rounded-full p-2 text-tg-text-muted transition-colors hover:bg-tg-surface-hover"
        >
          <MoreVertical className="h-5 w-5" />
        </button>

        <ContextMenu
          open={!!menuAt}
          x={menuAt?.x ?? 0}
          y={menuAt?.y ?? 0}
          onClose={() => setMenuAt(null)}
          items={[
            {
              id: 'pin',
              label: conversation.pinned ? '取消置顶' : '置顶会话',
              icon: conversation.pinned ? PinOff : Pin,
              onSelect: onTogglePin,
            },
            {
              id: 'mute',
              label: conversation.muted ? '取消免打扰' : '开启免打扰',
              icon: conversation.muted ? Volume2 : VolumeX,
              onSelect: onToggleMute,
            },
          ]}
        />
      </div>
    </div>
  );
};
