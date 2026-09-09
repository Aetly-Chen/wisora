// src/pages/About.tsx
import React from 'react';
import { Link } from 'react-router-dom';

const About: React.FC = () => (
  <div>
    <h2>关于 Wisora (About)</h2>
    <p>这是 Wisora 的项目介绍页面。</p>
    <Link to="/">返回首页</Link>
  </div>
);
export default About;