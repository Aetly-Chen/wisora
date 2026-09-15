// src/router/index.tsx
import React, { lazy, Suspense } from 'react';
import { createBrowserRouter } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { ProtectedRoute } from '../components/ProtectedRoute';

// 1. 使用 lazy 动态导入页面组件
const Home = lazy(() => import('../pages/Home'));
const About = lazy(() => import('../pages/About'));
const Agent = lazy(() => import('../pages/agent'));
const Notes = lazy(() => import('../pages/notes'));
const NotFound = lazy(() => import('../pages/NotFound'));
const Auth = lazy(() => import('../pages/auth/login'));

// 2. 封装加载等待的高阶函数/组件
const lazyLoad = (Component: React.LazyExoticComponent<React.FC>) => (
  <Suspense fallback={<div style={{ padding: '20px' }}>页面加载中...</div>}>
    <Component />
  </Suspense>
);

// 3. 配置路由表
export const router = createBrowserRouter([
  // 开放路由（无需 Token）
  {
    path: '/auth',
    element: lazyLoad(Auth),
  },
  
  // 受受保护路由（需要 Token 校验）
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <Layout />
      </ProtectedRoute>
    ),
    children: [
      {
        index: true,
        element: lazyLoad(Home),
      },
      {
        path: 'about',
        element: lazyLoad(About),
      },
      {
        path: 'agent',
        element: lazyLoad(Agent),
      },
      {
        path: 'notes',
        element: lazyLoad(Notes),
      },
      {
        path: '*',
        element: lazyLoad(NotFound),
      },
    ],
  },
]);