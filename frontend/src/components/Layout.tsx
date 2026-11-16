import React from "react";
import { Outlet } from "react-router-dom";

export const Layout: React.FC = () => {
  return (
    <main>
      <Outlet />
    </main>
  );
};