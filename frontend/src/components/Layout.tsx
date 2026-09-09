import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { Header } from "../components/Header";

export const Layout: React.FC = () => {
  const location = useLocation();
  const hideHeader = location.pathname === "/agent";
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