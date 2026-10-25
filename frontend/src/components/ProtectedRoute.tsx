// src/components/ProtectedRoute.tsx
import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { getToken } from '../request/storage';

interface ProtectedRouteProps {
  children: React.ReactNode; // 受保护的路由内容；无 token 时不渲染
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const location = useLocation();
  
  // 从本地存储或状态库中获取 token
  const token = getToken(); 

  if (!token) {
    // replace 阻止产生无效的历史记录；state 记录来源页面，方便登录后跳回
    return <Navigate to="/auth" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};