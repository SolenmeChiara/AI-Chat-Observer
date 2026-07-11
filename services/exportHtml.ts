// 导出会话为自包含单文件 HTML:图片(base64 dataURL)内嵌、引用/思考过程/私讯标记保留,
// 手机浏览器直接打开即可阅读。不依赖任何外部资源,断网可看。
import { ChatSession, Agent, Message } from '../types';
import { t } from '../i18n';

const USER_ID = 'user';

// 头像圆牌配色:按 senderId 稳定取色,不依赖外链头像(离线可看)
const BADGE_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ef4444', '#14b8a6', '#f97316', '#84cc16'];

function badgeColor(senderId: string): string {
  let h = 0;
  for (let i = 0; i < senderId.length; i++) h = (h * 31 + senderId.charCodeAt(i)) >>> 0;
  return BADGE_COLORS[h % BADGE_COLORS.length];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function senderName(msg: Message, agents: Agent[], userName: string): string {
  if (msg.isSystem) return `[${t('系统')}]`;
  if (msg.senderId === USER_ID) return userName || t('用户');
  const agent = agents.find(a => a.id === msg.senderId);
  return agent ? agent.name : msg.senderId;
}

function renderMessage(msg: Message, session: ChatSession, agents: Agent[], userName: string): string {
  if (msg.isStreaming) return '';

  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour12: false });

  if (msg.isSystem) {
    return `<div class="sys">${escapeHtml(msg.text)} <span class="t">${time}</span></div>`;
  }

  const name = senderName(msg, agents, userName);
  const isUser = msg.senderId === USER_ID;
  const initial = escapeHtml([...name][0] || '?');
  const color = isUser ? '#71717a' : badgeColor(msg.senderId);

  let pmTag = '';
  if (msg.pmTargetId) {
    const target = msg.pmTargetId === USER_ID
      ? (userName || t('用户'))
      : (agents.find(a => a.id === msg.pmTargetId)?.name || msg.pmTargetId);
    pmTag = `<span class="pm">${t('私讯')} → ${escapeHtml(target)}</span>`;
  }

  let quoteHtml = '';
  if (msg.replyToId) {
    const target = session.messages.find(m => m.id === msg.replyToId);
    if (target) {
      const qName = senderName(target, agents, userName);
      const qText = target.text.length > 120 ? target.text.slice(0, 120) + '…' : target.text;
      quoteHtml = `<div class="quote"><b>${escapeHtml(qName)}</b><br>${escapeHtml(qText)}</div>`;
    }
  }

  let reasoningHtml = '';
  if (msg.reasoningText) {
    const dur = msg.reasoningDuration ? ` (${(msg.reasoningDuration / 1000).toFixed(1)}s)` : '';
    reasoningHtml = `<details class="think"><summary>${t('思考过程')}${dur}</summary><div>${escapeHtml(msg.reasoningText)}</div></details>`;
  }

  const imagesHtml = (msg.attachments || [])
    .map(att => att.type === 'image'
      ? `<img src="${att.content}" alt="${escapeHtml(att.fileName || 'image')}" loading="lazy">`
      : `<div class="doc">📄 ${escapeHtml(att.fileName || 'document')}</div>`)
    .join('');

  const bubbleClasses = ['bubble'];
  if (msg.isError) bubbleClasses.push('err');
  if (msg.isSearchResult) bubbleClasses.push('search');

  const textHtml = msg.text ? `<div class="txt">${escapeHtml(msg.text)}</div>` : '';

  return `<div class="msg${isUser ? ' user' : ''}">
  <div class="badge" style="background:${color}">${initial}</div>
  <div class="body">
    <div class="meta"><b>${escapeHtml(name)}</b> ${pmTag} <span class="t">${time}</span></div>
    <div class="${bubbleClasses.join(' ')}">${quoteHtml}${reasoningHtml}${textHtml}${imagesHtml}</div>
  </div>
</div>`;
}

export function formatSessionAsHtml(session: ChatSession, agents: Agent[], userName: string): string {
  const date = new Date(session.lastUpdated).toLocaleDateString('zh-CN');
  const messagesHtml = session.messages.map(m => renderMessage(m, session, agents, userName)).filter(Boolean).join('\n');

  const summaryHtml = session.summary
    ? `<details class="summary"><summary>${t('记忆摘要')}</summary><div>${escapeHtml(session.summary)}</div></details>`
    : '';

  const exportedAt = new Date().toLocaleString('zh-CN', { hour12: false });
  const msgCount = session.messages.filter(m => !m.isStreaming).length;

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(session.name)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #101014; color: #e4e4e7; font: 15px/1.6 -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; padding: 16px 12px 48px; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 18px; padding: 8px 0 2px; }
  .sub { color: #71717a; font-size: 12px; margin-bottom: 16px; }
  .summary { background: #18181d; border: 1px solid #27272a; border-radius: 10px; padding: 10px 12px; margin-bottom: 16px; font-size: 13px; color: #a1a1aa; }
  .summary summary { cursor: pointer; color: #d4d4d8; font-weight: 600; }
  .summary div { margin-top: 8px; white-space: pre-wrap; }
  .msg { display: flex; gap: 10px; margin: 14px 0; }
  .msg.user { flex-direction: row-reverse; }
  .msg.user .meta { text-align: right; }
  .msg.user .bubble { background: #1e2a3a; }
  .badge { flex: 0 0 34px; width: 34px; height: 34px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 15px; color: #fff; }
  .body { max-width: 85%; min-width: 0; }
  .meta { font-size: 12px; color: #a1a1aa; margin-bottom: 3px; }
  .meta b { color: #d4d4d8; }
  .t { color: #52525b; font-size: 11px; }
  .pm { color: #c084fc; font-size: 11px; border: 1px solid #c084fc44; border-radius: 4px; padding: 0 4px; }
  .bubble { background: #1c1c22; border-radius: 12px; padding: 9px 12px; overflow-wrap: break-word; }
  .bubble.err { background: #2a1a1a; border: 1px solid #7f1d1d; }
  .bubble.search { background: #16211c; border: 1px solid #14532d66; }
  .txt { white-space: pre-wrap; }
  .quote { border-left: 3px solid #52525b; background: #26262c; border-radius: 6px; padding: 6px 9px; margin-bottom: 7px; font-size: 12.5px; color: #a1a1aa; }
  .think { font-size: 12.5px; color: #8b8b93; margin-bottom: 7px; }
  .think summary { cursor: pointer; color: #71717a; }
  .think div { margin-top: 6px; white-space: pre-wrap; border-left: 2px solid #3f3f46; padding-left: 8px; }
  .bubble img { max-width: 100%; border-radius: 8px; margin-top: 8px; display: block; }
  .doc { color: #a1a1aa; font-size: 13px; margin-top: 6px; }
  .sys { text-align: center; color: #71717a; font-size: 12px; margin: 12px 0; }
  footer { text-align: center; color: #3f3f46; font-size: 11px; margin-top: 32px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${escapeHtml(session.name)}</h1>
  <div class="sub">${date} · ${msgCount} ${t('条')}</div>
  ${summaryHtml}
  ${messagesHtml}
  <footer>${escapeHtml(session.name)} · ${exportedAt} · AI Chat Observer</footer>
</div>
</body>
</html>`;
}
