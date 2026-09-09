import * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * shadcn/ui 的 Sonner 封装。
 *
 * 本项目为纯浅色主题（index.css 中 color-scheme: light），
 * 因此不需要 next-themes 做主题切换。
 *
 * 这里只把 Sonner 的 CSS 变量映射到 shadcn 的 design token，
 * 让 toast 自动继承 Card / Popover 的圆角、描边与配色。
 */
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      className="toaster group"
      position="top-center"
      style={
        {
          "--normal-bg": "var(--color-popover)",
          "--normal-text": "var(--color-popover-foreground)",
          "--normal-border": "var(--color-border)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
