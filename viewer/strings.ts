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
  '正在生成': 'Generating',
  '未命名会话': 'Untitled session',

  // ---- 四期：侧边栏 ----
  '菜单': 'Menu',
  '打开菜单': 'Open menu',
  '关闭菜单': 'Close menu',
  '返回': 'Back',
  '控制': 'Controls',
  '主题': 'Theme',
  '浅色': 'Light',
  '深色': 'Dark',
  '跟随': 'Auto',
  '编辑角色': 'Edit agent',
  '让电脑切到这个会话': 'Open on the computer',
  // 五期：新建群 / 新建对话
  '新建群组': 'New group',
  '新建对话': 'New session',
  '在这个群新建对话': 'New session in this group',
  '取消': 'Cancel',
  // 默认名的预览（placeholder 拼成「对话 3」/ "Chat 3"）。电脑端真正落盘的名字按**它自己**的
  // 语言生成，两端语言不同时预览和结果会差一个词，这是预览不是承诺。
  '群组': 'Group',
  '对话': 'Chat',
  '电脑端': 'Computer',
  '电脑端正在播放': 'The computer is playing',
  '电脑端已暂停': 'The computer is paused',
  '会话跟着电脑端走': 'Follow whatever the computer opens',
  '手机自己选会话': 'Pick sessions on the phone yourself',
  '深浅色跟随电脑端': 'Light/dark follows the computer',

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

  // 遥控自动播放
  '遥控失败': 'Remote control failed',
  '电脑端已离线，遥控没生效': 'The computer is offline, the command did not take effect',
  '电脑端当前不在这个会话，开启「跟随电脑」再试': 'The computer is on another session — turn on "Follow computer" and try again',
  '操作太频繁，缓一缓再试': 'Too many actions, slow down a bit',

  // ---- 三期：远程动作 ----

  // 侧边栏分区（三期叫「抽屉与分栏」，四期改成侧边栏后 key 没变）
  '管理': 'Manage',
  '成员': 'Members',
  '编辑': 'Edit',
  '会话': 'Sessions',
  '电脑端已离线，暂时不能操作': 'The computer is offline, actions are unavailable',

  // 动作名（toast 前缀）
  '发送消息': 'Send message',
  '切换会话': 'Switch session',
  '添加成员': 'Add member',
  '移出成员': 'Remove member',
  '禁言': 'Mute',
  '解禁': 'Unmute',
  '点名发言': 'Ask to speak',
  '修改角色': 'Update agent',
  '新建角色': 'Create agent',

  // 动作结果
  '成功': 'done',
  '失败': 'failed',
  '电脑端没有回应': 'the computer did not respond',
  '找不到这个角色': 'agent not found',
  '这个模型不在该供应商下': 'that model does not belong to this provider',
  '找不到这个供应商': 'provider not found',
  '找不到这个会话': 'session not found',
  '找不到这个群组': 'group not found',
  '要引用的那条消息不在了': 'the quoted message is gone',
  'TA 不在当前群里': 'they are not in the current group',
  'TA 已经在群里了': 'they are already in the group',
  'TA 正在禁言中': 'they are muted right now',
  'TA 在电脑端被停用了': 'they are disabled on the computer',
  'TA 正在生成，稍后再试': 'busy generating, try again shortly',
  '电脑端没能写进这条消息': 'the computer could not append the message',
  '电脑端执行时出错了': 'the computer hit an error while running it',
  '电脑端不认识这个操作，可能版本太旧': 'the computer does not know this action — it may be an older build',
  '电脑端已离线': 'the computer is offline',
  '电脑端已经切到别的会话了': 'the computer switched to another session',
  '请求被拒绝': 'request rejected',
  '操作太快了，缓一缓': 'too many actions, slow down',

  // 成员面板
  '这个群还没有成员': 'This group has no members yet',
  '没有可添加的角色': 'No other agents available',
  '管理员': 'Admin',
  '普通成员': 'Member',
  '禁言中': 'Muted',
  '剩余': 'left',
  '永久': 'Forever',
  '15 分钟': '15 min',
  '1 小时': '1 hour',
  '移出': 'Remove',
  '再点一次确认': 'Tap again to confirm',
  '发言': 'Speak',
  '不到 1 分钟': 'under a minute',
  '分钟': 'min',
  '小时': 'h',
  '天': 'd',
  '电脑端当前在': 'The computer is on',
  '这里的操作都作用于那个会话': 'actions here apply to that session',
  '跳过去': 'Go there',

  // 编辑 / 新建角色
  '选择角色': 'Select agent',
  '名字': 'Name',
  '供应商': 'Provider',
  '模型': 'Model',
  '提示词': 'System prompt',
  '温度': 'Temperature',
  '最大输出': 'Max tokens',
  '仅被 @ 时发言': 'Only speak when mentioned',
  '允许私讯': 'Allow private messages',
  '身份': 'Role',
  '指令方式': 'Command mode',
  '文本协议': 'Text protocol',
  '原生函数调用': 'Native function calls',
  '保存': 'Save',
  '创建': 'Create',
  '没有改动': 'No changes',
  '跟随默认': 'Default',
  '加入当前群': 'Add to the current group',
  '没有可用的供应商': 'No providers available',
  '这台电脑还没配供应商，或者服务端版本较旧': 'No providers configured on the computer, or the server is an older build',
  '名字不能为空': 'Name cannot be empty',
  '名字太长（上限 100 字）': 'Name is too long (100 chars max)',
  '提示词太长（上限 64000 字）': 'System prompt is too long (64000 chars max)',
  '这个群还没有可编辑的角色': 'No agents to edit yet',
  '选一个角色开始编辑': 'Pick an agent to start editing',
  '本群成员': 'In this group',
  '其他角色': 'Other agents',
  '留空则用默认提示词': 'Leave blank to use the default prompt',

  // 会话面板
  '电脑端正在看': 'On the computer now',
  '正在看': 'Viewing',
  '还没有任何会话': 'No sessions yet',
  '条': 'msgs',

  // 发送区：私讯与回复
  '私讯给…': 'Private message…',
  '私讯给': 'PM to',
  '取消私讯': 'Cancel private message',
  '发给全群': 'Everyone in the group',
  '回复': 'Reply',
  '取消回复': 'Cancel reply',
  '长按消息可以引用回复': 'Long-press a message to quote it',
  '消息为空或太长（上限 20000 字）': 'Message is empty or too long (20000 chars max)',
};

export function makeViewerT(locale: ViewerLocale): (key: string) => string {
  return (key: string) => (locale === 'zh' ? key : en[key] ?? key);
}

export { en as viewerEn };
