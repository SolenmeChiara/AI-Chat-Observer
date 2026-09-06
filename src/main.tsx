import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Optional global styles

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);

// /viewer 是手机观众模式（PHONE_VIEWER_PLAN.md §5）。
// 两个入口都走动态 import：只有这样手机端才不会顺带下载整个 App
// （App 一旦是静态 import 就会被打进入口 chunk，懒加载 ViewerApp 就白做了）。
const entry = window.location.pathname === '/viewer'
  ? import('../viewer/ViewerApp')
  : import('../App');

entry.then(({ default: Root }) => {
  root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
});
