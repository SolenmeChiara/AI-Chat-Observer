// 手机观众端自带的小词典。
// 刻意不复用 i18n.tsx 的字典：那边归电脑端维护（PHONE_VIEWER_PLAN §4.4 还要往里加 key），
// 观众端只有这几十条文案，单独放一份比抢同一个文件省事。
// 约定同 i18n.tsx：key 就是中文原文，en 里查不到就原样回退。

export type ViewerLocale = 'zh' | 'en';

const en: Record<string, string> = {
  // 引导页 / 连接
  '需要访问令牌': 'Access token required',
  '请在电脑端点开「📱 手机观看」，用手机扫那个二维码进来。': 'On your computer, open "📱 Phone Viewer" and scan the QR code with your phone.',
  '令牌无效或已过期': 'Invalid or expired token',
  '电脑端换过令牌，或者链接是旧的。请重新扫一次码。': 'The computer rotated its token, or this link is stale. Please scan the QR code again.',
  '清除本机令牌': 'Clear stored token',
  '连不上电脑端': 'Cannot reach the computer',
  '重试': 'Retry',
  '加载中...': 'Loading…',
  '正在连接...': 'Connecting…',
  '连接已断开，正在重连...': 'Disconnected, reconnecting…',

  // 头部 / 状态条
  '跟随电脑': 'Follow computer',
  '在线': 'Online',
  '离线': 'Offline',
  '自动播放': 'Auto-play',
  '已暂停': 'Paused',
  '正在生成': 'Generating',
  '选择会话': 'Select session',
  '未命名会话': 'Untitled session',

  // 消息列表
  '加载更早': 'Load earlier',
  '正在加载...': 'Loading…',
  '已经是最早的消息': 'Beginning of the conversation',
  '这个会话还没有消息': 'No messages in this session yet',
  '回到底部': 'Back to bottom',
  '发送中': 'Sending',

  // 发送
  '发送': 'Send',
  '说点什么...': 'Say something…',
  '电脑端已离线，暂时发不出消息': 'The computer is offline, cannot send right now',
  '只能给电脑端当前打开的会话发消息': 'You can only send to the session currently open on the computer',
  '发送失败': 'Send failed',
  '网络不通': 'network unreachable',
  '电脑端已离线，消息没发出去': 'The computer went offline, the message was not sent',
  '电脑端已经切到别的会话了，消息没发出去': 'The computer switched to another session, the message was not sent',
  '发得太快了，缓一缓再发': 'Too many messages, slow down a bit',
  '消息为空或太长（上限 4000 字）': 'Message is empty or too long (4000 chars max)',
  '访问令牌无效，请重新扫码': 'Invalid token, please scan the QR code again',
  '提及成员 (@)': 'Mention (@)',
};

export function makeViewerT(locale: ViewerLocale): (key: string) => string {
  return (key: string) => (locale === 'zh' ? key : en[key] ?? key);
}

export { en as viewerEn };
