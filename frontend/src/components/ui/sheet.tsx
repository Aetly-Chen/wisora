import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * 侧栏（drawer）。
 *
 * 用 Radix Dialog 而不是自己写一个 fixed + transform 的浮层：
 * 焦点陷阱、Esc 关闭、遮罩点击关闭、打开时锁定背景滚动、
 * 关闭后把焦点还给触发按钮 —— 这几件事都得有，自己实现必然漏一两个。
 * 这里只是把 Dialog 的内容区改成贴边的一整条，行为全部沿用。
 *
 * 与 ui/dialog.tsx 分开而不是加个 side 参数：DialogContent 的居中定位
 * （left-1/2 top-1/2 -translate-*）与贴边定位是互斥的，靠 className 覆盖
 * 不可靠 —— Tailwind 的同级工具类顺序由生成顺序决定，不由 class 属性顺序决定。
 */

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

const SIDE_CLASS = {
  right:
    'inset-y-0 right-0 h-full w-[280px] border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
  left: 'inset-y-0 left-0 h-full w-[280px] border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left',
} as const;

interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  side?: keyof typeof SIDE_CLASS; // 从哪一侧滑出（top/right/bottom/left），默认 right
  /** 关闭按钮的无障碍标签，默认「关闭」 */
  closeLabel?: string;
}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  SheetContentProps
>(({ className, children, side = 'right', closeLabel = '关闭', ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-slate-900/25 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none',
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col bg-[#fafaf8] shadow-xl outline-none',
        'duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 motion-reduce:animate-none',
        SIDE_CLASS[side],
        className,
      )}
      {...props}
    >
      {children}
      <DialogPrimitive.Close
        aria-label={closeLabel}
        className="absolute right-3 top-3 rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-900/[0.05] hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = DialogPrimitive.Content.displayName;

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-[15px] font-semibold text-slate-900', className)}
    {...props}
  />
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-[12.5px] text-slate-500', className)}
    {...props}
  />
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetDescription,
};
