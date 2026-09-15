import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Header } from "../components/Header";

export const Layout: React.FC = () => {
  const location = useLocation();
  // AI 助手与笔记是整屏工作区（内部自带宽高布局），全局导航会挤压它们
  const hideHeader =
    location.pathname === "/agent" || location.pathname.startsWith("/notes");
  // 首页用透明导航栏，叠在视差背景上；其它页用默认暖白底。
  const headerTransparent = location.pathname === "/";

  return (
    <div>
      {!hideHeader && <Header variant={headerTransparent ? "transparent" : "default"} />}
      <main>
        <Outlet />
      </main>
    </div>
  );
};