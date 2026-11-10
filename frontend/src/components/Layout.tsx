import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Header } from "../components/Header";

export const Layout: React.FC = () => {
  const location = useLocation();
  /*
   * 整屏工作区（内部自带宽高布局）不挂全局导航 —— 顶栏 64px 会挤掉它们，
   * 工作台还会把底部状态栏顶出视口（实测过）。
   * 工作台有自己的三栏 chrome，不需要再来一层导航。
   */
  const hideHeader =
    location.pathname === "/agent" ||
    location.pathname.startsWith("/notes") ||
    location.pathname.startsWith("/chat") ||
    location.pathname.startsWith("/workbench");
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