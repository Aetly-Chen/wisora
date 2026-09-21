import React from 'react';
import { Users } from 'lucide-react';
import type { Presence } from '@/types/chat';
import { avatarTone, initials } from '@/lib/chat-utils';

/**
 * 首字母头像。
 *
 * 为什么不用图片头像：mock 阶段没有真实头像资源，
 * 而用第三方占位图服务会引入外部依赖、离线就打不开。
 * 首字母 + 稳定底色的做法在任何网络条件下都能渲染，
 * 也是 Telegram 在没有头像时的默认形态。
 *
 * 底色的取色规则见 `lib/chat-utils` 的 avatarTone：
 * 由 id 稳定推导，同一人每次都是同一色，且限定在低饱和色组里。
 */

type AvatarSize = 'sm' | 'md' | 'lg';

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-7 w-7 text-[10.5px]',
  md: 'h-9 w-9 text-[12.5px]',
  lg: 'h-12 w-12 text-[15px]',
};

/** 在线状态圆点的颜色。离线不画点，避免满屏小圆点 */
const PRESENCE_CLASS: Record<Presence, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-400',
  offline: '',
};

interface PeerAvatarProps {
  id: string;
  name: string;
  size?: AvatarSize;
  presence?: Presence;
  /** 群聊头像：用中性底色 + 图标，与个人头像区分开 */
  group?: boolean;
  className?: string;
}

export const PeerAvatar: React.FC<PeerAvatarProps> = ({
  id,
  name,
  size = 'md',
  presence = 'offline',
  group = false,
  className = '',
}) => (
  <div className={`relative shrink-0 ${className}`}>
    <div
      className={`flex items-center justify-center rounded-full font-semibold text-white ${
        SIZE_CLASS[size]
      } ${
        group
          ? 'bg-gradient-to-tr from-slate-500 to-slate-600'
          : `bg-gradient-to-tr ${avatarTone(id)}`
      }`}
      aria-hidden
    >
      {group ? (
        <Users className={size === 'lg' ? 'h-5 w-5' : 'h-4 w-4'} />
      ) : (
        initials(name)
      )}
    </div>

    {/* 在线状态：只在在线/离开时画点。这是真实语义状态，不是装饰 */}
    {!group && presence !== 'offline' && (
      <span
        title={presence === 'online' ? '在线' : '离开'}
        aria-label={presence === 'online' ? '在线' : '离开'}
        style={{
          width: size === 'sm' ? 8 : 10,
          height: size === 'sm' ? 8 : 10,
        }}
        className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white ${
          PRESENCE_CLASS[presence]
        }`}
      />
    )}
  </div>
);
