import React, { useRef, useState } from 'react';
import { ArrowLeft, MoreVertical, Pin, PinOff, Volume2, VolumeX } from 'lucide-react';
import type { Conversation, Friend } from '@/types/chat';
import { conversationPeer, conversationTitle } from '@/stores/useChatStore';
import { ContextMenu } from '@/components/ContextMenu';
import { PeerAvatar } from './PeerAvatar';

/**
 * 会话头部。
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
    <div className="flex shrink-0 items-center gap-2.5 border-b border-slate-200/80 px-3 py-2.5">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="返回会话列表"
          className="-ml-1 shrink-0 rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 md:hidden"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      )}

      <PeerAvatar
        id={peer?.id ?? conversation.id}
        name={title}
        size="sm"
        presence={peer?.presence}
        group={isGroup}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <h2 className="truncate text-[14px] font-semibold text-slate-900">{title}</h2>
          {conversation.muted && (
            <VolumeX className="h-3.5 w-3.5 shrink-0 text-slate-300" aria-label="免打扰" />
          )}
        </div>
        <p
          className={`truncate text-[11.5px] ${
            typingName ? 'text-indigo-600' : 'text-slate-500'
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
        className="shrink-0 rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        <MoreVertical className="h-4 w-4" />
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
  );
};
