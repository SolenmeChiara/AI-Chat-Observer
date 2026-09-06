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

entry
  .then(({ default: Root }) => {
    root.render(
      <React.StrictMode>
        <Root />
      </React.StrictMode>
    );
  })
  .catch(err => {
    // 动态 import 失败没有兜底就是纯白屏，而且失败是常态：发新版本后旧 HTML 会去请求
    // 已经删掉的 chunk hash，手机走出 WiFi 时同理。至少留一行能看懂的字 + 一条控制台记录。
    console.error('[main] 入口模块加载失败', err);
    rootElement.innerHTML = [
      '<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;',
      'font:14px/1.6 system-ui,-apple-system,\'Segoe UI\',sans-serif;color:#71717a;padding:24px;text-align:center;">',
      '<div>加载失败，请刷新页面</div>',
      '<div>Failed to load. Please refresh the page.</div>',
      '</div>',
    ].join('');
  });
