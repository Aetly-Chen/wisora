import React from 'react';
import { Users } from 'lucide-react';
import type { Presence } from '@/types/chat';
import { avatarTone, initials } from '@/lib/chat-utils';

/**
 * 首字母头像。
 *
 * 放在 components/ 而不是 components/chat/：它会出现在消息气泡、
 * 会话列表、顶部导航与个人资料页四处，其中两处根本不属于聊天模块。
 * 名字也去掉了 "Peer" —— 它同样用于当前用户自己的头像，
 * 而「自己」不是 peer。
 *
 * 为什么不做图片头像：项目还没有头像上传能力。用第三方占位图服务会
 * 引入外部依赖、离线直接开不出图；首字母 + 稳定底色在任何网络条件下
 * 都能渲染，也是 Telegram 在没有头像时的默认形态。
 *
 * 底色规则见 `lib/chat-utils` 的 avatarTone：由 id 稳定推导，
 * 同一人每次都是同一色，且限定在一组压过饱和度的色相里。
 */

type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASS: Record<AvatarSize, string> = {
  sm: 'h-7 w-7 text-[10.5px]',
  md: 'h-9 w-9 text-[12.5px]',
  lg: 'h-12 w-12 text-[15px]',
  /** 个人资料页的主视觉。比 lg 大一档，避免与列表里的头像混淆 */
  xl: 'h-20 w-20 text-[24px]',
};

/** 在线状态圆点的颜色。离线不画点，避免满屏小圆点 */
const PRESENCE_CLASS: Record<Presence, string> = {
  online: 'bg-emerald-500',
  away: 'bg-amber-400',
  offline: '',
};

interface AvatarProps {
  id: string;
  name: string;
  size?: AvatarSize;
  presence?: Presence;
  /** 群聊头像：用中性底色 + 图标，与个人头像区分开 */
  group?: boolean;
  /**
   * 覆盖底色。
   *
   * 聊天模块要的是 Telegram 那套纯色块（不是渐变），而纯色块与渐变
   * 是两条完整的 class，没法只替换其中一个 token，所以这里整体替换。
   * 不传时保持项目原有的渐变，导航栏与个人资料页不受影响。
   */
  fill?: string;
  className?: string;
}

export const Avatar: React.FC<AvatarProps> = ({
  id,
  name,
  size = 'md',
  presence = 'offline',
  group = false,
  fill,
  className = '',
}) => (
  <div className={`relative shrink-0 ${className}`}>
    {/*
      标记为装饰：名字在旁边的文本里已经读到了，
      不隐藏的话读屏会把它当作「三丰三丰」重复念一遍。
    */}
    <div
      className={`flex items-center justify-center rounded-full font-semibold text-white ${
        SIZE_CLASS[size]
      } ${
        fill ?? (group ? 'bg-gradient-to-tr from-slate-500 to-slate-600' : `bg-gradient-to-tr ${avatarTone(id)}`)
      }`}
      aria-hidden
    >
      {group ? (
        <Users className={size === 'lg' || size === 'xl' ? 'h-5 w-5' : 'h-4 w-4'} />
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
          width: size === 'sm' ? 8 : size === 'xl' ? 14 : 10,
          height: size === 'sm' ? 8 : size === 'xl' ? 14 : 10,
        }}
        className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white ${
          PRESENCE_CLASS[presence]
        }`}
      />
    )}
  </div>
);
