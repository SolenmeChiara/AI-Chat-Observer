// 手机观众端的网络层：token 管理、REST 调用、SSE 订阅、消息窗口合并。
// 接口契约见 PHONE_VIEWER_PLAN.md §3；本文件不碰任何 DOM 渲染，方便单独跑协议级验证。

// 纯类型引用：这样整个模块编译后不留任何运行时 import，
// 合并逻辑可以脱离浏览器单独跑测试（mofalajidui/testMerge.mjs）。
import type { AgentRole, Message } from '../types';

export const TOKEN_STORAGE_KEY = 'aco-viewer-token';

/** 进入会话时一次拉多少条 */
export const TAIL_SIZE = 200;
/** 「加载更早」一次往前翻多少条 */
export const PAGE_SIZE = 200;
/** 增量同步时往回重叠多少条：最后几条的 text 会被流式改写，只拉新增会漏掉 */
export const SYNC_OVERLAP = 8;

// ---------------------------------------------------------------------------
// 契约类型（§3.2 / §3.3）
// ---------------------------------------------------------------------------

/** bootstrap 只吐渲染要用的字段，systemPrompt / providerId 等永远不出电脑 */
export interface ViewAgent {
  id: string;
  name: string;
  avatar: string;
  role: AgentRole;
}

export interface ViewGroup {
  id: string;
  name: string;
  memberIds: string[];
  adminIds?: string[];
}

export interface ViewSessionIndex {
  id: string;
  groupId: string;
  name: string;
  lastUpdated: number;
  messageCount: number;
}

export interface ViewUserProfile {
  id: string;
  name: string;
  avatar: string;
}

export interface ViewSettings {
  userProfiles: ViewUserProfile[];
  userName: string;
  userAvatar: string;
  expandAllReasoning: boolean;
  language: 'zh' | 'en';
  darkMode: boolean;
}

export interface PresenceReport {
  activeGroupId: string;
  activeSessionId: string;
  isAutoPlay: boolean;
  processingAgentIds: string[];
}

export interface PresenceState extends PresenceReport {
  desktopOnline: boolean;
  updatedAt: number;
}

export interface BootstrapData {
  agents: ViewAgent[];
  groups: ViewGroup[];
  sessions: ViewSessionIndex[];
  settings: ViewSettings;
  presence: PresenceState;
}

export interface SessionPage {
  id: string;
  groupId: string;
  name: string;
  lastUpdated: number;
  total: number;
  from: number;
  messages: Message[];
}

export interface SessionEventData {
  id: string;
  groupId: string;
  name: string;
  total: number;
  lastUpdated: number;
  deleted?: boolean;
}

export interface HelloEventData {
  role: string;
  presence: PresenceState;
  serverStartedAt: number;
}

// ---------------------------------------------------------------------------
// token
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;
let tokenInitialized = false;

/**
 * 首次进入时把 URL 上的 ?token= 收进 localStorage，然后 replaceState 把 query 抹掉——
 * 免得用户截图/分享地址栏时把令牌一起漏出去，也免得刷新时 URL 一直挂着它。
 */
export function initToken(): string | null {
  tokenInitialized = true;
  try {
    const url = new URL(window.location.href);
    const fromQuery = url.searchParams.get('token');
    if (fromQuery) {
      cachedToken = fromQuery;
      try {
        window.localStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
      } catch {
        // 隐私模式下 localStorage 会抛，内存里留一份照样能用（刷新后失效）
      }
      url.searchParams.delete('token');
      const rest = url.searchParams.toString();
      window.history.replaceState(null, '', url.pathname + (rest ? `?${rest}` : '') + url.hash);
      return cachedToken;
    }
  } catch {
    // URL 解析失败就退回读存储
  }
  try {
    cachedToken = window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function getToken(): string | null {
  if (!tokenInitialized) return initToken();
  return cachedToken;
}

export function clearToken(): void {
  cachedToken = null;
  tokenInitialized = true;
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------------------
// 主题偏好（手机本地，独立于电脑端）
// ---------------------------------------------------------------------------

export const THEME_STORAGE_KEY = 'aco-viewer-theme';

export type ViewerTheme = 'light' | 'dark';

/**
 * 手机自己的深浅色偏好。null = 还没选过，跟随电脑端 settings.darkMode。
 * 电脑端夜里开深色、手机白天要浅色，这两件事没有理由绑在一起。
 */
export function readThemePreference(): ViewerTheme | null {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    // 隐私模式下 localStorage 会抛；当作没选过，本次会话仍可在内存里切
    return null;
  }
}

export function writeThemePreference(theme: ViewerTheme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* 存不下就只在本次会话生效，不影响使用 */
  }
}

// ---------------------------------------------------------------------------
// fetch 封装
// ---------------------------------------------------------------------------

/** 带 HTTP 状态码和服务端 error 字段的错误，调用方靠这两个分支出提示文案 */
export class ViewerHttpError extends Error {
  status: number;
  code?: string;

  constructor(status: number, code?: string, message?: string) {
    super(message || code || `HTTP ${status}`);
    this.name = 'ViewerHttpError';
    this.status = status;
    this.code = code;
    // ES2020 target 下 extends Error 的原型链是对的，这行只是给打包降级留个保险
    Object.setPrototypeOf(this, ViewerHttpError.prototype);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init?.body) headers.set('Content-Type', 'application/json');

  const res = await fetch(path, {
    ...init,
    headers,
    cache: 'no-store',
    credentials: 'same-origin',
  });

  if (!res.ok) {
    let code: string | undefined;
    let message: string | undefined;
    try {
      const body = await res.json();
      if (body && typeof body === 'object') {
        code = typeof body.error === 'string' ? body.error : undefined;
        message = typeof body.message === 'string' ? body.message : undefined;
      }
    } catch {
      // 非 JSON 响应（比如 Vite 兜底的 HTML）就只留状态码
    }
    throw new ViewerHttpError(res.status, code, message);
  }
  return (await res.json()) as T;
}

export function fetchBootstrap(): Promise<BootstrapData> {
  return apiFetch<BootstrapData>('/api/view/bootstrap');
}

/**
 * 契约（§3.2）让图片附件的 content 变成 /api/view/sessions/…/attachments/… 直接喂给 <img src>，
 * 但 <img> 发不出 Authorization 头——浏览器加载图片时不会带我们那份 Bearer，服务端只能看到裸 GET。
 * 所以这里给附件 URL 补一个 ?token=，和 SSE 用 query 带 token 是同一个口子（§3.1 步骤 3）。
 * token 拿不到时原样返回，让服务端自己决定放不放行。
 */
function decorateAttachmentUrls(page: SessionPage): SessionPage {
  const token = getToken();
  if (!token) return page;
  let touched = false;
  const messages = page.messages.map(m => {
    if (!m.attachments || m.attachments.length === 0) return m;
    let localTouched = false;
    const attachments = m.attachments.map(att => {
      // 服务端对 lan 角色已经把 ?token= 拼进去了（W1 偏离点），只给没带的补。
      if (!att.content || !att.content.startsWith('/api/view/') || att.content.includes('token=')) return att;
      localTouched = true;
      const sep = att.content.includes('?') ? '&' : '?';
      return { ...att, content: `${att.content}${sep}token=${encodeURIComponent(token)}` };
    });
    if (!localTouched) return m;
    touched = true;
    return { ...m, attachments };
  });
  return touched ? { ...page, messages } : page;
}

export async function fetchSessionTail(sessionId: string, tail: number = TAIL_SIZE): Promise<SessionPage> {
  const page = await apiFetch<SessionPage>(`/api/view/sessions/${encodeURIComponent(sessionId)}?tail=${tail}`);
  return decorateAttachmentUrls(page);
}

export async function fetchSessionRange(sessionId: string, from: number, to?: number): Promise<SessionPage> {
  const q = typeof to === 'number' ? `?from=${from}&to=${to}` : `?from=${from}`;
  const page = await apiFetch<SessionPage>(`/api/view/sessions/${encodeURIComponent(sessionId)}${q}`);
  return decorateAttachmentUrls(page);
}

/** 202 → { id }；409/503/429/400 走 ViewerHttpError，调用方看 status/code 出文案 */
export function sendInbox(sessionId: string, text: string, clientId?: string): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/api/live/inbox', {
    method: 'POST',
    body: JSON.stringify({ sessionId, text, clientId }),
  });
}

/**
 * 遥控电脑端的自动播放开关。202 → { id }，错误码与 inbox 同一套（400/409/429/503）。
 * 202 只代表「指令已转给电脑端」，真正生效要等 presence 事件里的 isAutoPlay 翻转。
 */
export function sendControl(sessionId: string, enabled: boolean): Promise<{ id: string }> {
  return apiFetch<{ id: string }>('/api/live/control', {
    method: 'POST',
    body: JSON.stringify({ action: 'autoplay', enabled, sessionId }),
  });
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

export interface LiveHandlers {
  onHello?: (data: HelloEventData) => void;
  onSession?: (data: SessionEventData) => void;
  onPresence?: (data: PresenceState) => void;
  /** open 且不是首次 = 断线后重连上了，调用方该重拉 bootstrap + 当前会话尾部 */
  onReconnect?: () => void;
  onStatusChange?: (connected: boolean) => void;
}

/**
 * EventSource 不能带自定义 header，所以 token 只能走 query（契约 §3.2 就是这么定的）。
 * 返回值是取消订阅函数。EventSource 自带指数退避重连，这里不再手写重试。
 */
export function connectLiveEvents(handlers: LiveHandlers): () => void {
  const token = getToken();
  const url = `/api/live/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
  const es = new EventSource(url);
  let everOpened = false;

  es.addEventListener('open', () => {
    const isFirst = !everOpened;
    everOpened = true;
    handlers.onStatusChange?.(true);
    if (!isFirst) handlers.onReconnect?.();
  });

  es.addEventListener('error', () => {
    // EventSource 拿不到状态码，401/403 和「电脑关机了」在这里长得一模一样，
    // 所以鉴权失败的判定统一交给 bootstrap 的 fetch，这里只报连接状态。
    handlers.onStatusChange?.(false);
  });

  const bind = (name: string, cb?: (data: any) => void) => {
    if (!cb) return;
    es.addEventListener(name, (evt: Event) => {
      try {
        cb(JSON.parse((evt as MessageEvent).data));
      } catch (err) {
        console.warn(`[viewer] SSE 事件 ${name} 解析失败`, err);
      }
    });
  };

  bind('hello', handlers.onHello);
  bind('session', handlers.onSession);
  bind('presence', handlers.onPresence);

  return () => {
    try {
      es.close();
    } catch {
      /* 忽略 */
    }
  };
}

// ---------------------------------------------------------------------------
// 消息窗口合并
// ---------------------------------------------------------------------------

/** 本地持有的是完整会话的一个连续窗口，from 是窗口首条在完整会话里的绝对下标 */
export interface MessageWindow {
  from: number;
  total: number;
  messages: Message[];
}

export const EMPTY_WINDOW: MessageWindow = { from: 0, total: 0, messages: [] };

export interface MergeResult {
  window: MessageWindow;
  /** 真为「局部增量拼不出自洽窗口」，调用方应当整体重拉尾部 */
  needsRefetch: boolean;
  /** 假表示 window 就是传进来的那个对象，可以直接跳过 setState */
  changed: boolean;
}

/** 只比渲染看得见的字段：这几项都没变就说明 ChatBubble 渲染结果不会变 */
function sameRendered(a: Message, b: Message): boolean {
  return (
    a.id === b.id &&
    a.text === b.text &&
    !!a.isStreaming === !!b.isStreaming &&
    (a.reasoningText || '') === (b.reasoningText || '') &&
    !!a.isError === !!b.isError
  );
}

/**
 * 把服务端返回的一段消息并进本地窗口。
 *
 * 保留旧对象引用是硬要求：ChatBubble 的 React.memo 比较器是引用比较
 * （components/ChatBubble.tsx 结尾），每次流式增量如果整窗口换对象，
 * 200 条气泡会连带把 marked + DOMPurify 全跑一遍。
 *
 * 重拉判定（PHONE_VIEWER_PLAN §5）：
 *  - total 比本地已知的小 → 电脑端删过消息，下标全乱；
 *  - 响应首条 id 和本地对应位置对不上 → 中间插过/删过；
 *  - 两段既不相交也不相邻 → 中间有窟窿，拼出来的窗口不连续。
 */
export function mergeMessages(
  local: MessageWindow,
  incoming: Message[],
  from: number,
  total?: number
): MergeResult {
  const nextTotal = typeof total === 'number' ? total : local.total;

  if (typeof total === 'number' && total < local.total) {
    return { window: local, needsRefetch: true, changed: false };
  }

  if (local.messages.length === 0) {
    const window: MessageWindow = { from, total: nextTotal, messages: incoming };
    return { window, needsRefetch: false, changed: true };
  }

  if (incoming.length === 0) {
    if (nextTotal === local.total) return { window: local, needsRefetch: false, changed: false };
    return { window: { ...local, total: nextTotal }, needsRefetch: false, changed: true };
  }

  const localEnd = local.from + local.messages.length;
  const incomingEnd = from + incoming.length;

  if (from > localEnd || incomingEnd < local.from) {
    return { window: local, needsRefetch: true, changed: false };
  }

  const headIdx = from - local.from;
  if (headIdx >= 0 && headIdx < local.messages.length && local.messages[headIdx].id !== incoming[0].id) {
    return { window: local, needsRefetch: true, changed: false };
  }

  const base = Math.min(local.from, from);
  const end = Math.max(localEnd, incomingEnd);
  const merged: Message[] = [];
  // 窗口范围变了（往前翻或者尾部长出来）本身就算变化
  let changed = base !== local.from || end - base !== local.messages.length;

  for (let abs = base; abs < end; abs++) {
    const inc = abs >= from && abs < incomingEnd ? incoming[abs - from] : undefined;
    const old = abs >= local.from && abs < localEnd ? local.messages[abs - local.from] : undefined;
    if (inc && old) {
      if (sameRendered(old, inc)) {
        merged.push(old);
      } else {
        merged.push(inc);
        changed = true;
      }
    } else {
      merged.push((inc || old) as Message);
    }
  }

  if (!changed && nextTotal === local.total) {
    return { window: local, needsRefetch: false, changed: false };
  }
  return { window: { from: base, total: nextTotal, messages: merged }, needsRefetch: false, changed: true };
}

/** 增量同步该从哪条开始拉：尾部往回重叠 overlap 条，把被流式改写的最后几条一起捞回来 */
export function nextSyncFrom(win: MessageWindow, overlap: number = SYNC_OVERLAP): number {
  return Math.max(win.from, win.from + win.messages.length - overlap);
}
