import React, { useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Menu, Sparkles } from 'lucide-react';

import { Avatar } from '@/components/Avatar';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useUserStore } from '@/stores/useAppStore';
import { useCurrentUserId } from '@/lib/use-current-user';

/** 主导航项。AI 助手、笔记、聊天都是工作区，关于页放在最后。 */
const NAV_ITEMS = [
  { to: '/', label: '首页' },
  { to: '/agent', label: 'AI 助手' },
  { to: '/notes', label: '笔记' },
  { to: '/chat', label: '聊天' },
  { to: '/about', label: '关于' },
] as const;

interface HeaderProps {
  /**
   * 视觉变体：
   *   default    - 暖白底色（适合内容页/登录页等）
   *   transparent- 背景透明 + 文字白色（适合首页等有彩色背景的场景）
   */
  variant?: 'default' | 'transparent';
}

export const Header: React.FC<HeaderProps> = ({ variant = 'default' }) => {
  const isTransparent = variant === 'transparent';
  const location = useLocation();

  const username = useUserStore((s) => s.username);
  const email = useUserStore((s) => s.email);
  // 缺用户资料时按令牌回查一次，否则头像上只会显示一个问号
  const userId = useCurrentUserId();

  const [menuOpen, setMenuOpen] = useState(false);

  /*
   * 路由变化时收起侧栏。
   * 必须显式处理：点导航项只是换了 URL，侧栏本身还开着，
   * 在手机上会盖住刚打开的新页面。
   */
  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  const displayName = username || email.split('@')[0] || '我';

  /** 桌面行内导航与移动端侧栏共用的样式：同一套导航不能长得不一样 */
  const navClass = (isActive: boolean) =>
    [
      'rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors',
      isTransparent
        ? isActive
          ? 'bg-white/20 text-white'
          : 'text-white/80 hover:bg-white/10 hover:text-white'
        : isActive
          ? 'bg-slate-900/[0.06] text-slate-900'
          : 'text-slate-600 hover:bg-slate-900/[0.04] hover:text-slate-900',
    ].join(' ');

  const iconButtonClass = isTransparent
    ? 'text-white hover:bg-white/15'
    : 'text-slate-600 hover:bg-slate-900/[0.05] hover:text-slate-900';

  /** 头像位。拿到 id 前先画个中性圆占位 ——
   *  底色由 id 推导，先渲染再换会闪一下颜色 */
  const avatarSlot = (
    <span className={isTransparent ? 'ring-2 ring-white/60 rounded-full' : 'rounded-full'}>
      {userId ? (
        <Avatar id={userId} name={displayName} size="md" />
      ) : (
        <span className="block h-9 w-9 rounded-full bg-slate-400/40" aria-hidden />
      )}
    </span>
  );

  return (
    <div
      className={
        isTransparent
          ? // 透明 + fixed 顶部定位：bg 完全透出场景图，
            // 顶部自带渐变暗角，保证浅色场景（如远山）下白色文字仍可读
            'fixed inset-x-0 top-0 z-50 bg-gradient-to-b from-slate-950/65 via-slate-950/25 to-transparent [text-shadow:0_1px_4px_rgba(15,23,42,0.65)]'
          : 'w-full bg-[#f6f5f0]'
      }
    >
      <header
        className={
          'mx-auto flex w-full max-w-6xl items-center justify-between px-4 pb-2 pt-4 select-none ' +
          (isTransparent ? 'text-white' : '')
        }
      >
        {/* Wisora Brand */}
        <Link to="/" className="flex items-center gap-3" aria-label="Wisora 首页">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-purple-600 text-white shadow-md shadow-indigo-500/30 ring-2 ring-white">
            <Sparkles className="h-5 w-5 text-amber-300" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span
                className={
                  'font-sans text-xl font-black tracking-tight ' +
                  (isTransparent ? 'text-white drop-shadow-sm' : 'text-slate-900')
                }
              >
                Wisora
              </span>
              <span
                className={
                  isTransparent
                    ? // 深色玻璃底：浅色场景（如远山、暮色）下仍可读
                      'rounded-full border border-white/40 bg-slate-950/35 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm'
                    : 'rounded-full bg-indigo-100 px-2 py-0.5 text-[10px] font-bold text-indigo-700'
                }
              >
                AI
              </span>
            </div>
            <p
              className={
                'hidden text-[11px] font-medium ' +
                // 透明变体下隐藏标签语：小字在纯白天空场景上无法保证可读
                (isTransparent ? '' : 'sm:block text-slate-600')
              }
            >
              多端响应式智能工作台
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-1.5">
          {/* 桌面：行内导航 */}
          <nav className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) => navClass(isActive)}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          {/* 桌面：头像入口。移动端放进侧栏 ——
              顶栏挤三个元素（品牌 + 头像 + 菜单）在窄屏上会互相压 */}
          <Link
            to="/profile"
            aria-label="查看个人资料"
            title="个人资料"
            data-testid="header-avatar"
            className="ml-1 hidden rounded-full transition-transform hover:scale-[1.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 md:block"
          >
            {avatarSlot}
          </Link>

          {/* 移动端：侧栏入口 */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label="打开导航菜单"
                data-testid="nav-trigger"
                className={`-mr-1 rounded-lg p-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 md:hidden ${iconButtonClass}`}
              >
                <Menu className="h-5 w-5" />
              </button>
            </SheetTrigger>

            <SheetContent side="right" className="md:hidden" data-testid="nav-drawer">
              <SheetTitle className="sr-only">导航菜单</SheetTitle>

              {/* 用户卡片：点进个人资料。放顶部是 Telegram 的排法，
                  也是移动端唯一的头像入口 */}
              <Link
                to="/profile"
                className="flex items-center gap-2.5 border-b border-slate-200/80 px-4 py-4 pr-12 transition-colors hover:bg-slate-900/[0.03]"
              >
                {avatarSlot}
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-slate-800">
                    {displayName}
                  </p>
                  <p className="truncate text-[11.5px] text-slate-500">
                    {email || '查看个人资料'}
                  </p>
                </div>
              </Link>

              <nav className="flex flex-col gap-0.5 p-2">
                {NAV_ITEMS.map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    className={({ isActive }) =>
                      [
                        'rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors',
                        isActive
                          ? 'bg-slate-900/[0.06] text-slate-900'
                          : 'text-slate-600 hover:bg-slate-900/[0.04] hover:text-slate-900',
                      ].join(' ')
                    }
                  >
                    {item.label}
                  </NavLink>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </header>
    </div>
  );
};
