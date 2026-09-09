// src/pages/NotFound.tsx
import React from 'react';
import { Link } from 'react-router-dom';

 const NotFound: React.FC = () => (
  <div>
    <h2>404 - 页面未找到</h2>
    <Link to="/">返回首页</Link>
  </div>
);
export default NotFound;