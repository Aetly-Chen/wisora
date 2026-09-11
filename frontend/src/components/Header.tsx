import React from 'react';
import type { ViewDevice } from '../types/auth';
import { Sparkles } from 'lucide-react';

interface HeaderProps {
  viewDevice?: ViewDevice;
  onDeviceChange?: (device: ViewDevice) => void;
  lang?: 'zh' | 'en';
  onLangToggle?: () => void;
  /**
   * 视觉变体：
   *   default    - 暖白底色（适合内容页/登录页等）
   *   transparent- 背景透明 + 文字白色（适合首页等有彩色背景的场景）
   */
  variant?: 'default' | 'transparent';
}

export const Header: React.FC<HeaderProps> = ({
  variant = 'default',
}) => {
  const isTransparent = variant === 'transparent';

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
          'w-full max-w-6xl mx-auto px-4 pt-4 pb-2 flex items-center justify-between select-none ' +
          (isTransparent ? 'text-white' : '')
        }
      >
        {/* Wisora Brand */}
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-indigo-600 via-indigo-500 to-purple-600 flex items-center justify-center text-white shadow-md shadow-indigo-500/30 ring-2 ring-white shrink-0">
            <Sparkles className="w-5 h-5 text-amber-300" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span
                className={
                  'text-xl font-black tracking-tight font-sans ' +
                  (isTransparent ? 'text-white drop-shadow-sm' : 'text-slate-900')
                }
              >
                Wisora
              </span>
              <span
                className={
                  isTransparent
                    ? // 深色玻璃底：浅色场景（如远山、暮色）下仍可读
                      'px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-950/35 text-white border border-white/40 backdrop-blur-sm'
                    : 'px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-100 text-indigo-700'
                }
              >
                AI
              </span>
            </div>
            <p
              className={
                'text-[11px] font-medium hidden ' +
                // 透明变体下隐藏标签语：小字在纯白天空场景上无法保证可读
                (isTransparent ? '' : 'sm:block text-slate-600')
              }
            >
              多端响应式智能工作台
            </p>
          </div>
        </div>
      </header>
    </div>
  );
};