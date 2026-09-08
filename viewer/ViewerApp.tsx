// 手机观众端主界面（PHONE_VIEWER_PLAN.md §5）。
//
// 和 App.tsx 的关系：只复用 ChatBubble 和 types，不 import 任何 service、不碰 db、
// 不做任何写盘。会话文件唯一的写者永远是电脑端，手机只读 + 往 inbox 投一条纯文本。
//
// 移动优先：h-screen（src/index.css 已经把它覆盖成 100dvh）、输入区 pb-safe、
// 不做 hover-only 交互、不做 Enter 发送（手机软键盘的 Enter 是换行）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agent, Attachment, Message, MuteInfo } from '../types';
import { USER_ID } from '../constants';
import { I18nProvider } from '../i18n';
import ChatBubble from '../components/ChatBubble';
import {
  AlertCircle,
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CornerUpLeft,
  ImagePlus,
  Loader2,
  Menu,
  Monitor,
  Moon,
  Plus,
  RefreshCw,
  Send,
  Smartphone,
  Sun,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { ACTION_LIMITS, ACTION_RESULT_TIMEOUT_MS, type ActionResult, type ActionType } from '../server/actionContract';
import { makeViewerT } from './strings';
import { ImagePrepError, compressImageForUpload, type DraftAttachment } from './imageUpload';
import MembersPanel from './panels/MembersPanel';
import AgentEditPanel from './panels/AgentEditPanel';
import AgentCreatePanel from './panels/AgentCreatePanel';
import SessionsPanel from './panels/SessionsPanel';
import { SidebarRow, SidebarSection, SidebarSwitch, type RunActionOptions } from './panels/shared';
import {
  BootstrapData,
  EMPTY_WINDOW,
  MessageWindow,
  PAGE_SIZE,
  PresenceState,
  SessionEventData,
  SessionPage,
  TAIL_SIZE,
  ViewAgent,
  ViewSessionIndex,
  ViewerHttpError,
  ViewerTheme,
  clearThemePreference,
  clearToken,
  connectLiveEvents,
  fetchBootstrap,
  fetchSessionRange,
  fetchSessionTail,
  getToken,
  initToken,
  mergeMessages,
  nextSyncFrom,
  readThemePreference,
  sendAction,
  sendControl,
  writeThemePreference,
} from './viewerClient';

type Phase = 'loading' | 'no-token' | 'denied' | 'error' | 'ready';

/** 同发送者、间隔不超过这个数的消息算一组，只画一次头像和名字 */
const GROUP_WINDOW_MS = 5 * 60 * 1000;

/** 遥控发出后最多等多久 presence 回流；超时就把转圈收掉，免得一直卡着 */
const CONTROL_PENDING_TIMEOUT_MS = 4000;

/** 收到 catalog 事件后隔多久重拉 bootstrap（§2.6）。连着改几个字段只该拉一次。 */
const CATALOG_DEBOUNCE_MS = 300;

/** 长按气泡多久算「引用这条」 */
const LONG_PRESS_MS = 500;

/** 长按期间手指移动超过这个距离就当成滚动，不算长按 */
const LONG_PRESS_SLOP_PX = 10;

/** 从屏幕左边多少像素以内起手才算「边缘右滑开侧边栏」 */
const EDGE_OPEN_PX = 24;

/** 侧边栏开合手势的判定距离：横向走够这么多才算数 */
const SWIPE_TRIGGER_PX = 56;

/** 侧边栏滑入 / 收起的时长，和 duration-200 对齐 */
const SIDEBAR_ANIM_MS = 200;

/** 一条动作的等待记录。key 是按钮维度的标识，id（Map 的键）是服务端给的动作 id。 */
interface PendingAction {
  type: ActionType;
  key: string;
  label: string;
  at: number;
  /** message.send 专用：失败时要撤掉的乐观占位与要还回输入框的原文 */
  draftMessageId?: string;
  draftText?: string;
  /** message.send 专用：失败时要还回缩略图条的那几张图（已经压好了，不用重选重压） */
  draftAttachments?: DraftAttachment[];
  /** session.switch 专用：成功后手机自己也要跟过去的那个会话 */
  targetSessionId?: string;
}

interface Toast {
  id: number;
  kind: 'ok' | 'err';
  text: string;
}

/**
 * 侧边栏当前页。'home' 是主页（会话 / 控制 / 管理三段），其余三个是推进去的子页。
 * 用「推入子页」而不是三期那种顶部 tab 栏：tab 栏一行挤四个，每个只有 ~80×44，
 * 而子页的返回栏是整条 44px 的行，指头点哪儿都算。
 */
type SidebarPage = 'home' | 'members' | 'edit' | 'create';

/** 系统 / 搜索结果消息自成一段，不参与分组（它们走 ChatBubble 的另一条渲染分支） */
function isStandaloneMessage(m: Message): boolean {
  return !!m.isSystem || m.senderId === 'SYSTEM' || !!m.isSearchResult;
}

/**
 * 引用条压成一行之后要的预览：取正文第一段有字的，把 Markdown 记号剥掉。
 * 不剥的话一行里全是 `**` `##` `- ` 这种噪声，本来就只剩几十个字符的位置更看不出引的是哪句。
 * 只做行内那几种常见记号，不引 markdown 解析器——这是一行提示，不是渲染。
 */
function previewLine(text: string): string {
  const line = text.split('\n').map(s => s.trim()).find(s => s.length > 0) || '';
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接
    .replace(/^#{1,6}\s+/, '') // 标题
    .replace(/^>\s?/, '') // 引用
    .replace(/^([-*+]|\d+\.)\s+/, '') // 列表
    .replace(/(\*\*|__|~~|`)/g, '') // 粗体 / 删除线 / 行内代码
    .replace(/(^|\s)[*_](\S)/g, '$1$2') // 斜体起
    .replace(/(\S)[*_](\s|$)/g, '$1$2') // 斜体收
    .replace(/\s+/g, ' ')
    .trim();
}

/** 本条是不是上一条的延续：同一个人、同一个私讯目标、5 分钟以内 */
function isContinuedMessage(prev: Message | undefined, msg: Message): boolean {
  if (!prev) return false;
  if (isStandaloneMessage(prev) || isStandaloneMessage(msg)) return false;
  if (prev.senderId !== msg.senderId) return false;
  if ((prev.pmTargetId || '') !== (msg.pmTargetId || '')) return false;
  return msg.timestamp - prev.timestamp <= GROUP_WINDOW_MS;
}

/**
 * SSE 的三态，比一个 boolean 多出来的就是「还没连上过」这一档。
 * 首次加载时 bootstrap（一次 fetch）可能比 SSE 的 open 事件先到，此时 UI 已经渲染而
 * connected 还是 false；只用 boolean 的话开局会闪一下「离线 + 输入框禁用」再跳回可用。
 * 'connecting' 只活到第一次 open 或第一次 error 为止——正常握手不会先发 error，
 * 所以真连不上（403 / 电脑关机）时会立刻落到 'offline'，不会赖在中性态里。
 */
type LinkState = 'connecting' | 'online' | 'offline';

/** 把会话事件并回索引；内容没变就原样返回旧数组，免得白刷一轮渲染 */
function applySessionEvent(list: ViewSessionIndex[], evt: SessionEventData): ViewSessionIndex[] {
  if (evt.deleted) {
    const next = list.filter(s => s.id !== evt.id);
    return next.length === list.length ? list : next;
  }
  const row: ViewSessionIndex = {
    id: evt.id,
    groupId: evt.groupId,
    name: evt.name,
    lastUpdated: evt.lastUpdated,
    messageCount: evt.total,
  };
  const idx = list.findIndex(s => s.id === evt.id);
  if (idx < 0) return [...list, row];
  const old = list[idx];
  if (old.name === row.name && old.lastUpdated === row.lastUpdated && old.messageCount === row.messageCount) {
    return list;
  }
  const next = list.slice();
  next[idx] = row;
  return next;
}

/** 无 token / 401 / 403 / 连不上时的引导页 */
const Gate: React.FC<{ title: string; body: string; children?: React.ReactNode }> = ({ title, body, children }) => (
  <div className="h-screen flex flex-col items-center justify-center px-8 text-center bg-gray-50 dark:bg-black">
    <div className="w-16 h-16 rounded-2xl bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 flex items-center justify-center mb-5 shadow-sm">
      <Smartphone size={30} className="text-gray-400" />
    </div>
    <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-2">{title}</h1>
    <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed max-w-xs break-words">{body}</p>
    {children && <div className="mt-6 flex flex-col gap-2 items-center">{children}</div>}
  </div>
);

const ViewerApp: React.FC = () => {
  // token 只在挂载时解析一次：initToken 会顺手把 URL 上的 ?token= 抹掉。
  // 没 token 不代表进不去：回环来源 + 回环 Host 在服务端就是全权的 loopback 角色
  // （server/http.ts:216，不校验 token），Sol 在电脑上开 localhost/viewer 预览手机版
  // 不该被要求手工粘 token。所以一律先试一次 bootstrap + SSE，只有真被 401/403 拒了
  // 才落引导页——局域网来源没 token 必然被拒，那条路径的观感和以前一样。
  const [token, setToken] = useState<string | null>(() => initToken());
  const [phase, setPhase] = useState<Phase>('loading');
  const [fatalMessage, setFatalMessage] = useState<string>('');

  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const [link, setLink] = useState<LinkState>('connecting');

  const [followDesktop, setFollowDesktop] = useState(true);
  const [viewingSessionId, setViewingSessionId] = useState<string | null>(null);
  const [win, setWin] = useState<MessageWindow>(EMPTY_WINDOW);
  const [pending, setPending] = useState<Message[]>([]);

  const [loadingSession, setLoadingSession] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>('');

  // 遥控自动播放：202 只说明指令送到了，真正生效看 presence 里的 isAutoPlay 翻转。
  // 这中间的空窗期显示转圈并禁点，否则手指会连点好几下。
  const [controlPending, setControlPending] = useState(false);
  const controlTargetRef = useRef<boolean | null>(null);
  const controlTimerRef = useRef<number | null>(null);

  // 手机自己的深浅色偏好（null = 没选过，跟随电脑端）。挂载时读一次 localStorage。
  const [themeOverride, setThemeOverride] = useState<ViewerTheme | null>(() => readThemePreference());

  const [inputText, setInputText] = useState('');
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);

  // --- 三期：远程动作 ---

  // 在飞的动作，键是服务端给的动作 id（POST 还没回来时先用一个本地临时键占位）。
  // 通用表而不是每个按钮一个 boolean：动作有九种，按钮有几十个。
  const [pendingActions, setPendingActions] = useState<Map<string, PendingAction>>(() => new Map());
  const [toasts, setToasts] = useState<Toast[]>([]);
  // 侧边栏分两个 state：sidebarOpen 管挂载，sidebarShown 管那条 translateX 过渡。
  // 合成一个的话，元素挂上去的同一帧就已经在终点位置，滑入动画根本不会发生。
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarShown, setSidebarShown] = useState(false);
  const [sidebarPage, setSidebarPage] = useState<SidebarPage>('home');
  const [editAgentId, setEditAgentId] = useState<string | null>(null);
  /** 电脑端当前会话的禁言表（成员面板要显示剩余时间） */
  const [activeMuted, setActiveMuted] = useState<MuteInfo[]>([]);
  const [muteTick, setMuteTick] = useState(0);
  const [pmTargetId, setPmTargetId] = useState<string | null>(null);
  const [showPmPicker, setShowPmPicker] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; name: string; text: string } | null>(null);
  /** 待发的图片（已压好），最多 ACTION_LIMITS.attachmentsPerMessage 张 */
  const [drafts, setDrafts] = useState<DraftAttachment[]>([]);
  /** 正在压缩选中的图片：这期间图片键转圈并禁用（大图在手机上要一两秒） */
  const [preparingImages, setPreparingImages] = useState(false);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // SSE 回调是「渲染之外」触发的，闭包会锁死旧 state（App.tsx:2908-2915 记过同样的坑），
  // 所以凡是回调要读的 state 都在渲染期同步进 ref。
  const winRef = useRef(win);
  winRef.current = win;
  const viewingRef = useRef(viewingSessionId);
  viewingRef.current = viewingSessionId;
  const followRef = useRef(followDesktop);
  followRef.current = followDesktop;
  const pendingActionsRef = useRef(pendingActions);
  pendingActionsRef.current = pendingActions;

  // --- 侧边栏的开合 ---

  const sidebarCloseTimerRef = useRef<number | null>(null);
  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  const sidebarBackdropRef = useRef<HTMLDivElement>(null);

  const openSidebar = useCallback(() => {
    if (sidebarCloseTimerRef.current !== null) {
      window.clearTimeout(sidebarCloseTimerRef.current);
      sidebarCloseTimerRef.current = null;
    }
    setSidebarOpen(true);
    // 挂载和「推到终点」必须隔一帧，否则没有过渡可看。
    // 收起动画中途又被点开时元素还挂着，这一句同样把它推回去。
    requestAnimationFrame(() => setSidebarShown(true));
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarShown(false);
    if (sidebarCloseTimerRef.current !== null) window.clearTimeout(sidebarCloseTimerRef.current);
    sidebarCloseTimerRef.current = window.setTimeout(() => {
      sidebarCloseTimerRef.current = null;
      setSidebarOpen(false);
      // 下次打开一律从主页开始：子页停在半路上，再进来会不知道自己在哪一层
      setSidebarPage('home');
    }, SIDEBAR_ANIM_MS);
  }, []);

  useEffect(
    () => () => {
      if (sidebarCloseTimerRef.current !== null) window.clearTimeout(sidebarCloseTimerRef.current);
    },
    []
  );

  const lang = boot?.settings.language === 'en' ? 'en' : 'zh';
  const t = useMemo(() => makeViewerT(lang), [lang]);

  // --- 派生数据 ---

  const sessions = boot?.sessions ?? [];
  const currentSession = useMemo(
    () => sessions.find(s => s.id === viewingSessionId) || null,
    [sessions, viewingSessionId]
  );
  const currentGroup = useMemo(
    () => boot?.groups.find(g => g.id === currentSession?.groupId) || null,
    [boot, currentSession]
  );

  /** 会话成员 = 该会话所属 group 的 memberIds 对应 agents（不是全量 agents） */
  const sessionMembers = useMemo<ViewAgent[]>(() => {
    if (!boot || !currentGroup) return [];
    return currentGroup.memberIds
      .map(id => boot.agents.find(a => a.id === id))
      .filter((a): a is ViewAgent => !!a);
  }, [boot, currentGroup]);

  // ChatBubble 要的是完整 Agent / GlobalSettings，观众端只有裁剪版。
  // Agent 可赋值给 ViewAgent，所以这个向下 cast 是合法的；ChatBubble 只读 name/avatar/role/id。
  const bubbleAgents = sessionMembers as Agent[];

  /**
   * 抽屉里所有会话级动作的作用域：**电脑端当前会话**，不是手机正在看的这个（§2.1）。
   * 手机在看别的会话时也让操作可用，只是作用在电脑那边——否则「跟随电脑」一关就什么都点不了。
   */
  const activeSessionId = presence?.activeSessionId || null;
  const activeSession = useMemo(
    () => sessions.find(s => s.id === activeSessionId) || null,
    [sessions, activeSessionId]
  );
  const activeGroup = useMemo(
    () => boot?.groups.find(g => g.id === activeSession?.groupId) || null,
    [boot, activeSession]
  );
  /** 老服务端（一期投影）不给 providers，读的地方一律兜底成空数组 */
  const providers = boot?.providers ?? [];

  const pendingKeys = useMemo(
    () => new Set([...pendingActions.values()].map(p => p.key)),
    [pendingActions]
  );
  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys]);

  const displayMessages = useMemo(() => {
    if (pending.length === 0) return win.messages;
    return [...win.messages, ...pending];
  }, [win.messages, pending]);

  // --- 错误处理 ---

  const handleNetworkError = useCallback((err: unknown) => {
    if (err instanceof ViewerHttpError && (err.status === 401 || err.status === 403)) {
      setPhase('denied');
      return;
    }
    console.warn('[viewer] 请求失败', err);
  }, []);

  /**
   * 遥控失败的文案。走输入区上方那条横幅（sendError）。
   * 三期之后发消息改走动作通道，失败统一出 toast（见 runAction），这条横幅只剩遥控在用。
   */
  const describeControlError = useCallback(
    (err: unknown): string => {
      if (err instanceof ViewerHttpError) {
        if (err.status === 503 || err.code === 'desktop-offline') return t('电脑端已离线，遥控没生效');
        if (err.status === 409 || err.code === 'not-active-session') return t('电脑端当前不在这个会话，开启「跟随电脑」再试');
        if (err.status === 429) return t('操作太频繁，缓一缓再试');
        if (err.status === 401 || err.status === 403) return t('访问令牌无效，请重新扫码');
        return `${t('遥控失败')}（HTTP ${err.status}）`;
      }
      return `${t('遥控失败')}（${t('网络不通')}）`;
    },
    [t]
  );

  // --- 动作通道（§2.2 / §2.5）---

  /**
   * toast 文案拼接。中英标点不一样：中文「点名发言失败：TA 正在禁言中」不加空格、用全角冒号，
   * 英文得是「Ask to speak failed: they are muted right now」。
   * 直接拼会拼出「Ask to speakfailed：…」。
   */
  const joinToast = useCallback(
    (label: string, verdict: string, detail?: string): string =>
      lang === 'zh'
        ? `${label}${verdict}${detail ? `：${detail}` : ''}`
        : `${label} ${verdict}${detail ? `: ${detail}` : ''}`,
    [lang]
  );

  /** 电脑端回的 error 是机器可读短码，这里翻成人话；没见过的码原样带出来，方便截图报 bug */
  const describeActionCode = useCallback(
    (code?: string): string => {
      switch (code) {
        // --- 电脑端语义校验回的短码（App.tsx handleActionEvent，14 个，与它一一对表）---
        case 'not-active-session':
          return t('电脑端已经切到别的会话了');
        case 'agent-not-found':
          return t('找不到这个角色');
        case 'invalid-model':
          return t('这个模型不在该供应商下');
        case 'provider-not-found':
        case 'invalid-provider': // 契约注释里的旧写法，留着当别名
          return t('找不到这个供应商');
        case 'session-not-found':
          return t('找不到这个会话');
        case 'group-not-found':
          return t('找不到这个群组');
        case 'message-not-found':
          return t('要引用的那条消息不在了');
        case 'not-a-member':
          return t('TA 不在当前群里');
        case 'already-member':
          return t('TA 已经在群里了');
        case 'agent-muted':
          return t('TA 正在禁言中');
        case 'agent-inactive':
          return t('TA 在电脑端被停用了');
        case 'busy':
          return t('TA 正在生成，稍后再试');
        case 'append-failed':
          return t('电脑端没能写进这条消息');
        case 'internal-error':
          return t('电脑端执行时出错了');
        case 'unknown-action':
          return t('电脑端不认识这个操作，可能版本太旧');
        // --- 手机端与 HTTP 层自己的短码 ---
        case 'timeout':
          return t('电脑端没有回应');
        case 'desktop-offline':
          return t('电脑端已离线');
        case 'rate-limited':
          return t('操作太快了，缓一缓');
        case undefined:
        case '':
        case 'bad-request':
          return t('请求被拒绝');
        default:
          return `${t('请求被拒绝')}（${code}）`;
      }
    },
    [t]
  );

  /** POST 本身就被拒了（还没进电脑端）。状态码与 error 字段走同一张表。 */
  const describeActionHttpError = useCallback(
    (err: unknown): string => {
      if (err instanceof ViewerHttpError) {
        if (err.status === 401 || err.status === 403) return t('访问令牌无效，请重新扫码');
        if (err.code) return describeActionCode(err.code);
        if (err.status === 503) return describeActionCode('desktop-offline');
        if (err.status === 409) return describeActionCode('not-active-session');
        if (err.status === 429) return describeActionCode('rate-limited');
        if (err.status === 400) return describeActionCode('bad-request');
        return `HTTP ${err.status}`;
      }
      return t('网络不通');
    },
    [t, describeActionCode]
  );

  const toastSeqRef = useRef(0);
  const toastTimersRef = useRef<Set<number>>(new Set());

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastSeqRef.current;
    setToasts(prev => [...prev.slice(-2), { id, kind, text }]);
    // 成功 2 秒（§2.9），失败留久一点：错误文案比「✓ 成功」长，2 秒读不完
    const timer = window.setTimeout(() => {
      toastTimersRef.current.delete(timer);
      setToasts(prev => prev.filter(x => x.id !== id));
    }, kind === 'ok' ? 2000 : 4500);
    toastTimersRef.current.add(timer);
  }, []);

  useEffect(
    () => () => {
      toastTimersRef.current.forEach(window.clearTimeout);
      toastTimersRef.current.clear();
    },
    []
  );

  /**
   * 结果比 POST 的 202 先到是可能的（SSE 是另一条连接，服务端转发只隔一个 tick）。
   * 那一刻等待表里还没有这个 id，结果不能直接丢，先存这里，登记 id 时立刻兑现。
   */
  const earlyResultsRef = useRef<Map<string, { result: ActionResult; at: number }>>(new Map());

  /**
   * 已结算过的动作 id。`pendingActionsRef` 要等下一次渲染才刷新，同一拍里
   * （超时扫描 + 回执同时到）会看到同一条还在表里，没有这个集合就会弹两次 toast。
   */
  const settledRef = useRef<Set<string>>(new Set());

  /** 一条动作有结果了（成功 / 失败 / 超时都走这里）：撤等待态、出 toast、做各自的收尾 */
  const settleAction = useCallback(
    (id: string, result: ActionResult) => {
      const entry = pendingActionsRef.current.get(id);
      if (!entry || settledRef.current.has(id)) return false;
      settledRef.current.add(id);
      if (settledRef.current.size > 200) {
        // 只是防无限增长；一次会话里几百个动作已经很夸张了
        settledRef.current = new Set([...settledRef.current].slice(-100));
      }
      setPendingActions(prev => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });

      if (result.ok) {
        pushToast('ok', joinToast(entry.label, t('成功')));
        // 禁言 / 解禁 / 加人都会改电脑端那份会话，顺手让成员面板重新拉一次禁言表
        setMuteTick(x => x + 1);
        if (entry.type === 'message.send' && entry.draftMessageId && result.data?.messageId) {
          // 乐观占位换成真 id，之后 pending 清理 effect 会在真消息进窗口时撤掉它
          const realId = result.data.messageId;
          setPending(prev => prev.map(m => (m.id === entry.draftMessageId ? { ...m, id: realId } : m)));
        }
        if (entry.type === 'session.switch') {
          // 远程切会话成功 = 用户明确想跟着电脑走，把「跟随电脑」打开（§2.9）；
          // 顺手收起侧边栏——切会话的目的就是去看那个会话，没理由还挡着。
          setFollowDesktop(true);
          // 手机的视图也要自己挪过去：presence 事件多半比这条回执先到，
          // 那一刻 followDesktop 还是 false（用户刚点过某一行本地看别的会话），
          // applyPresence 就把它放过去了。只靠 follow 会停在旧会话上等下一个 presence。
          if (entry.targetSessionId) setViewingSessionId(entry.targetSessionId);
          closeSidebar();
        }
        if (entry.type === 'agent.create' && result.data?.agentId) {
          setEditAgentId(result.data.agentId);
        }
        if (entry.type === 'session.create' || entry.type === 'group.create') {
          // 电脑端建完就自己切过去了（handleCreateSession / handleCreateGroup 都会 setActive*），
          // 手机跟着走：开「跟随电脑」+ 直接把视图挪到回执里的新会话 id，别等下一个 presence。
          // 新群 / 新会话本身靠 catalog（groups）与 session 事件回流进列表，这里不用管。
          setFollowDesktop(true);
          if (result.data?.sessionId) setViewingSessionId(result.data.sessionId);
          closeSidebar();
        }
      } else {
        pushToast('err', joinToast(entry.label, t('失败'), describeActionCode(result.error)));
        if (entry.type === 'message.send' && entry.draftMessageId) {
          setPending(prev => prev.filter(m => m.id !== entry.draftMessageId));
          // 文本还回输入框，但别覆盖用户在这几秒里新打的字
          if (entry.draftText) setInputText(prev => (prev.trim() ? prev : entry.draftText || ''));
          // 图也还回缩略图条。同理别覆盖用户这几秒里新选的图；
          // 真要合并的话还得处理「加起来超过 4 张」，得不偿失。
          const back = entry.draftAttachments;
          if (back && back.length > 0) setDrafts(prev => (prev.length > 0 ? prev : back));
        }
      }
      return true;
    },
    [pushToast, t, describeActionCode, joinToast, closeSidebar]
  );

  const handleActionResult = useCallback(
    (result: ActionResult) => {
      if (settleAction(result.id, result)) return;
      const buf = earlyResultsRef.current;
      const now = Date.now();
      // 顺手清掉过期的孤儿结果（对应的动作根本没登记成功，比如 POST 抛了）
      for (const [k, v] of buf) if (now - v.at > 30_000) buf.delete(k);
      buf.set(result.id, { result, at: now });
    },
    [settleAction]
  );

  const actionSeqRef = useRef(0);

  /**
   * 发一个动作。返回值只表示服务端 202 收下了；成败要等 `action-result`（8 秒超时）。
   * 同一个 key 有动作在飞时直接拒绝，避免手指连点发出两份。
   */
  const runAction = useCallback(
    async <T extends ActionType>(
      opts: RunActionOptions<T> & { draftMessageId?: string; draftText?: string; draftAttachments?: DraftAttachment[] }
    ): Promise<boolean> => {
      for (const p of pendingActionsRef.current.values()) {
        if (p.key === opts.key) return false;
      }
      const localKey = `local-${++actionSeqRef.current}`;
      const entry: PendingAction = {
        type: opts.type,
        key: opts.key,
        label: opts.label,
        at: Date.now(),
        draftMessageId: opts.draftMessageId,
        draftText: opts.draftText,
        draftAttachments: opts.draftAttachments,
        // session.switch 的 sessionId 就是「要切去的那个」（不是「当前那个」），
        // 收尾时手机自己也得挪过去，所以在这儿留一份
        targetSessionId: opts.type === 'session.switch' ? opts.sessionId : undefined,
      };
      setPendingActions(prev => new Map(prev).set(localKey, entry));

      try {
        const { id } = await sendAction(opts.type, opts.payload, opts.sessionId);
        setPendingActions(prev => {
          const next = new Map(prev);
          if (!next.delete(localKey)) return prev; // 已经被超时清扫掉了
          next.set(id, { ...entry, at: Date.now() });
          return next;
        });
        // 结果可能已经先到了
        const early = earlyResultsRef.current.get(id);
        if (early) {
          earlyResultsRef.current.delete(id);
          // 等 setPendingActions 落地后再结算，否则 settleAction 从 ref 里读不到这条
          window.setTimeout(() => settleAction(id, early.result), 0);
        }
        return true;
      } catch (err) {
        setPendingActions(prev => {
          const next = new Map(prev);
          next.delete(localKey);
          return next;
        });
        pushToast('err', joinToast(opts.label, t('失败'), describeActionHttpError(err)));
        if (err instanceof ViewerHttpError && (err.status === 401 || err.status === 403)) setPhase('denied');
        return false;
      }
    },
    [pushToast, t, describeActionHttpError, settleAction, joinToast]
  );

  /**
   * 超时清扫。一个动作八秒没回执就当失败——电脑端标签页可能被系统冻结了，
   * 没人会来回这条，按钮不能一直转圈。用一个定时器扫全表，不给每条动作各挂一个。
   */
  useEffect(() => {
    if (pendingActions.size === 0) return;
    const timer = window.setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of pendingActionsRef.current) {
        if (now - entry.at > ACTION_RESULT_TIMEOUT_MS) {
          settleAction(id, { id, ok: false, error: 'timeout' });
        }
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [pendingActions.size, settleAction]);

  // --- bootstrap ---

  const loadBootstrap = useCallback(async (silent = false) => {
    try {
      const data = await fetchBootstrap();
      setBoot(data);
      setPresence(data.presence);
      setPhase('ready');
      setFatalMessage('');
      setViewingSessionId(prev => {
        if (prev && data.sessions.some(s => s.id === prev)) return prev;
        const active = data.sessions.find(s => s.id === data.presence?.activeSessionId);
        return active?.id ?? data.sessions[0]?.id ?? null;
      });
    } catch (err) {
      if (err instanceof ViewerHttpError && (err.status === 401 || err.status === 403)) {
        // 手上有 token 却被拒 = 令牌坏了；压根没 token = 还没扫码。两种文案不一样。
        // 读 getToken() 而不是 token state：这里在 useCallback([]) 里，闭包会锁死旧值。
        setPhase(getToken() ? 'denied' : 'no-token');
        return;
      }
      console.warn('[viewer] bootstrap 失败', err);
      if (!silent) {
        setFatalMessage(err instanceof Error ? err.message : String(err));
        setPhase('error');
      }
    }
  }, []);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  // --- 增量同步 ---

  const syncBusyRef = useRef(false);
  const syncAgainRef = useRef(false);

  /**
   * 拉当前会话的增量并合并。串行执行：同步期间又来 session 事件就置标志，
   * 本轮跑完再补一轮，避免几十毫秒里发出一串重叠请求。
   */
  const runSync = useCallback(async () => {
    if (syncBusyRef.current) {
      syncAgainRef.current = true;
      return;
    }
    if (!viewingRef.current) return;
    syncBusyRef.current = true;
    try {
      do {
        syncAgainRef.current = false;
        const targetId: string | null = viewingRef.current;
        if (!targetId) break;

        const current = winRef.current;
        const page: SessionPage = current.messages.length === 0
          ? await fetchSessionTail(targetId, TAIL_SIZE)
          : await fetchSessionRange(targetId, nextSyncFrom(current));
        if (viewingRef.current !== targetId) break; // 期间切了会话，这份响应作废

        const res = mergeMessages(winRef.current, page.messages, page.from, page.total);
        if (res.needsRefetch) {
          const tail = await fetchSessionTail(targetId, TAIL_SIZE);
          if (viewingRef.current !== targetId) break;
          const w: MessageWindow = { from: tail.from, total: tail.total, messages: tail.messages };
          winRef.current = w;
          setWin(w);
        } else if (res.changed) {
          winRef.current = res.window;
          setWin(res.window);
        }
      } while (syncAgainRef.current);
    } catch (err) {
      handleNetworkError(err);
    } finally {
      syncBusyRef.current = false;
    }
  }, [handleNetworkError]);

  // 切会话：清空窗口重新拉尾部
  useEffect(() => {
    if (phase !== 'ready' || !viewingSessionId) return;
    let cancelled = false;
    setLoadingSession(true);
    winRef.current = EMPTY_WINDOW;
    setWin(EMPTY_WINDOW);
    setPending([]);
    setSendError('');
    setIsNearBottom(true);
    // 私讯目标和引用都是「这个会话里的这条消息」，换了会话就不成立了
    setReplyTo(null);
    setPmTargetId(null);
    setShowPmPicker(false);
    fetchSessionTail(viewingSessionId, TAIL_SIZE)
      .then(page => {
        if (cancelled || viewingRef.current !== viewingSessionId) return;
        const w: MessageWindow = { from: page.from, total: page.total, messages: page.messages };
        winRef.current = w;
        setWin(w);
      })
      .catch(handleNetworkError)
      .finally(() => {
        if (!cancelled) setLoadingSession(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, viewingSessionId, handleNetworkError]);

  // --- SSE ---

  /** 撤掉遥控的等待态（成功回流 / 失败 / 超时都走这里） */
  const clearControlPending = useCallback(() => {
    controlTargetRef.current = null;
    if (controlTimerRef.current !== null) {
      window.clearTimeout(controlTimerRef.current);
      controlTimerRef.current = null;
    }
    setControlPending(false);
  }, []);

  const applyPresence = useCallback(
    (p: PresenceState) => {
      if (!p) return;
      setPresence(p);
      // 电脑端已经按遥控翻好了：等待态到此为止
      if (controlTargetRef.current !== null && p.isAutoPlay === controlTargetRef.current) {
        clearControlPending();
      }
      // 「跟随电脑」开着时，电脑切会话手机就跟着切
      if (followRef.current && p.activeSessionId && p.activeSessionId !== viewingRef.current) {
        setViewingSessionId(p.activeSessionId);
      }
    },
    [clearControlPending]
  );

  // 卸载时把还挂着的超时清掉
  useEffect(() => () => {
    if (controlTimerRef.current !== null) window.clearTimeout(controlTimerRef.current);
  }, []);

  const blocked = phase === 'no-token' || phase === 'denied';

  // catalog 事件的防抖器：改一个 agent 会连着写好几张表，300ms 内只重拉一次 bootstrap
  const catalogTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (catalogTimerRef.current !== null) window.clearTimeout(catalogTimerRef.current);
  }, []);

  // token 在依赖里是有意义的：清掉令牌后要用「没有凭证」重新握一次手，不是继续用旧连接。
  useEffect(() => {
    if (blocked) return;
    setLink('connecting');
    const close = connectLiveEvents({
      onStatusChange: up => setLink(up ? 'online' : 'offline'),
      onHello: data => applyPresence(data.presence),
      onPresence: applyPresence,
      onSession: data => {
        setBoot(prev => {
          if (!prev) return prev;
          const next = applySessionEvent(prev.sessions, data);
          return next === prev.sessions ? prev : { ...prev, sessions: next };
        });
        // 禁言写在会话文件里，电脑端那边一动就会发这条事件；成员面板据此重拉禁言表
        setMuteTick(x => x + 1);
        if (data.id !== viewingRef.current) return;
        if (data.deleted) {
          void loadBootstrap(true);
          return;
        }
        void runSync();
      },
      onActionResult: handleActionResult,
      onCatalog: () => {
        if (catalogTimerRef.current !== null) window.clearTimeout(catalogTimerRef.current);
        catalogTimerRef.current = window.setTimeout(() => {
          catalogTimerRef.current = null;
          void loadBootstrap(true);
        }, CATALOG_DEBOUNCE_MS);
      },
      onReconnect: () => {
        // 断线期间可能错过若干 session 事件，索引和窗口都当作脏的重来一遍
        void loadBootstrap(true);
        void runSync();
      },
    });
    return close;
  }, [token, blocked, applyPresence, loadBootstrap, runSync, handleActionResult]);

  /**
   * 电脑端当前会话的禁言表。侧边栏开着时才拉，`tail=1` 只为把 `mutedAgents` 捎回来
   * （会话正文这里一个字都不用）。会话事件、动作回执、切会话都会把 muteTick 顶一下。
   * 绑在「侧边栏开」而不是「正在看成员页」上：成员页只隔一次点击，等进去再拉会先闪一下空表。
   */
  useEffect(() => {
    if (!sidebarOpen || !activeSessionId || blocked) return;
    let cancelled = false;
    fetchSessionTail(activeSessionId, 1)
      .then(page => {
        if (!cancelled) setActiveMuted(page.mutedAgents ?? []);
      })
      .catch(err => {
        // 拉不到就当没有禁言：面板照样能用，只是不显示剩余时间
        console.warn('[viewer] 禁言表拉取失败', err);
      });
    return () => {
      cancelled = true;
    };
  }, [sidebarOpen, activeSessionId, muteTick, blocked]);

  // --- pending 清理：真消息进窗口后就撤掉乐观占位 ---

  useEffect(() => {
    if (pending.length === 0) return;
    const ids = new Set(win.messages.map(m => m.id));
    const rest = pending.filter(p => {
      if (ids.has(p.id)) return false;
      // 走 inbox 的时代，服务端给的 id 就是落盘后的消息 id，比对 id 足够。
      // 改走 message.send 之后落盘 id 由电脑端自己生成，回执里的 data.messageId 是可选的，
      // 不一定拿得到。所以再兜一层：同一个人、同样的正文、同一个私讯目标、时间对得上，就算它到了。
      return !win.messages.some(
        m =>
          m.senderId === USER_ID &&
          m.text === p.text &&
          (m.pmTargetId || '') === (p.pmTargetId || '') &&
          m.timestamp >= p.timestamp - 120_000
      );
    });
    if (rest.length !== pending.length) setPending(rest);
  }, [win, pending]);

  // --- 视口高度：软键盘弹起时把界面压到可见区里 ---
  //
  // 100dvh 只扣浏览器 UI，不扣键盘：iOS 上键盘一起来，输入区就被顶到屏幕外面去了。
  // visualViewport 才是「现在能看见的那块」。整个界面的高度改跟这个 CSS 变量走。
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      // 捏合放大时 vv.height 会跟着缩水，乘回 scale 才是布局视口那么高，
      // 免得两指一放大整个界面就被压扁（本项目 meta viewport 禁了缩放，这是给别的入口兜底）
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height * vv.scale)}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--vvh');
    };
  }, []);

  // --- 主题：本地偏好优先，没选过才跟随电脑端 settings.darkMode ---
  // 电脑晚上开深色、手机白天要浅色，这两件事本来就不该绑在一起。
  // 手机上点过一次深浅色按钮就写进 localStorage，从此不再跟随电脑。

  const isDark = themeOverride ? themeOverride === 'dark' : !!boot?.settings.darkMode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark);
  }, [isDark]);

  /** 三选一：'light' / 'dark' / null（回到跟随电脑端） */
  const handlePickTheme = useCallback((next: ViewerTheme | null) => {
    if (next) writeThemePreference(next);
    else clearThemePreference();
    setThemeOverride(next);
  }, []);

  // --- 滚动 ---

  // 手机上一律瞬时滚动，不用 smooth：流式每 2 秒改一次文本，平滑动画会被反复打断，
  // 动画途中触发的 scroll 事件还会把 isNearBottom 误判成 false，从此再也不自动跟到底。
  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const near = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
    setIsNearBottom(near);
    setShowScrollButton(!near && displayMessages.length > 0);
  }, [displayMessages.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  // 流式增量不改条数只改最后一条的长度，所以这里要把「最后一条的长度」也算进依赖
  const lastMessage = displayMessages[displayMessages.length - 1];
  const tailStamp = lastMessage ? `${lastMessage.id}:${lastMessage.text.length}` : '';
  useEffect(() => {
    if (!isNearBottom) return;
    scrollToBottom();
    // 图片附件是异步加载的，落地后会把内容再撑高一截，但那时不会有任何 state 变化把这个
    // effect 唤醒。补两拍：下一帧一次、250ms 后再一次，够把迟到的图片高度吃掉。
    const raf = requestAnimationFrame(scrollToBottom);
    const timer = window.setTimeout(scrollToBottom, 250);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [displayMessages.length, tailStamp, isNearBottom, scrollToBottom]);

  // --- 加载更早 ---

  const handleLoadEarlier = useCallback(async () => {
    const sid = viewingRef.current;
    const current = winRef.current;
    if (!sid || loadingEarlier || current.from <= 0) return;
    setLoadingEarlier(true);
    const container = scrollContainerRef.current;
    const prevHeight = container?.scrollHeight ?? 0;
    const prevTop = container?.scrollTop ?? 0;
    try {
      const from = Math.max(0, current.from - PAGE_SIZE);
      const page = await fetchSessionRange(sid, from, current.from);
      if (viewingRef.current !== sid) return;
      const res = mergeMessages(winRef.current, page.messages, page.from, page.total);
      if (res.needsRefetch) {
        await runSync();
      } else if (res.changed) {
        winRef.current = res.window;
        setWin(res.window);
        // 往前插内容会把视口整体推下去，补回滚动位置，否则手指下一秒就在别的地方
        requestAnimationFrame(() => {
          const el = scrollContainerRef.current;
          if (el) el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
        });
      }
    } catch (err) {
      handleNetworkError(err);
    } finally {
      setLoadingEarlier(false);
    }
  }, [loadingEarlier, runSync, handleNetworkError]);

  // --- 发送 ---

  // SSE 断了 = presence 是一份不知道多旧的快照，desktopOnline / activeSessionId 都不能再信，
  // 所以连接掉了就一并禁掉发送（否则顶部写着「离线」输入框却照样能敲，提示语还是空的）。
  // 只拦 'offline' 不拦 'connecting'：后者是首次握手那几百毫秒，presence 刚从 bootstrap
  // 拿到、是新鲜的，拦了只会让开局闪一下禁用态。
  const linkLost = link === 'offline';
  /** 状态点：得是 SSE 通着 **且** 电脑端在线才算「在线」 */
  const desktopReachable = link === 'online' && !!presence?.desktopOnline;
  const canSend =
    !linkLost && !!presence?.desktopOnline && !!viewingSessionId && viewingSessionId === presence?.activeSessionId;
  const sendBlockedReason = useMemo(() => {
    if (link === 'offline') return t('连接已断开，正在重连...');
    if (!presence) return t('正在连接...');
    if (!presence.desktopOnline) return t('电脑端已离线，暂时发不出消息');
    if (viewingSessionId !== presence.activeSessionId) return t('只能给电脑端当前打开的会话发消息');
    // 有 presence 但 SSE 还没握上手：能发，只是先说一声，别让人以为界面卡住了
    if (link === 'connecting') return t('正在连接...');
    return '';
  }, [link, presence, viewingSessionId, t]);

  /** 私讯目标必须是当前群成员；成员被移出去了就把它清掉，免得发出去必被拒 */
  useEffect(() => {
    if (pmTargetId && !sessionMembers.some(a => a.id === pmTargetId)) setPmTargetId(null);
  }, [pmTargetId, sessionMembers]);

  const nameOfSender = useCallback(
    (m: Message): string => {
      if (m.senderId === USER_ID) return boot?.settings.userName || 'User';
      return boot?.agents.find(a => a.id === m.senderId)?.name || m.senderId;
    },
    [boot]
  );

  /** 压缩失败的短码 → 人话 */
  const describeImageError = useCallback(
    (code: string): string => {
      switch (code) {
        case 'not-an-image':
          return t('只能发图片');
        case 'too-large':
          return t('图片太大了（单张上限 4 MB）');
        default:
          return t('这张图读不出来');
      }
    },
    [t]
  );

  /**
   * 选完图：一张张压（webp/jpeg，长边 ≤ 1600，目标 ≤ 1 MB；GIF 原样），压好一张显示一张。
   * 超过 4 张的部分直接丢掉并出 toast——不静默截断，不然用户以为都选上了。
   */
  const handlePickImages = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const room = ACTION_LIMITS.attachmentsPerMessage - drafts.length;
      const chosen = Array.from(files);
      if (room <= 0) {
        pushToast('err', t('最多只能发 4 张图'));
        return;
      }
      if (chosen.length > room) pushToast('err', t('最多只能发 4 张图'));
      setPreparingImages(true);
      try {
        for (const file of chosen.slice(0, room)) {
          try {
            const att = await compressImageForUpload(file);
            setDrafts(prev =>
              prev.length >= ACTION_LIMITS.attachmentsPerMessage ? prev : [...prev, att]
            );
          } catch (err) {
            const code = err instanceof ImagePrepError ? err.code : 'decode-failed';
            pushToast('err', joinToast(file.name || t('图片'), describeImageError(code)));
          }
        }
      } finally {
        setPreparingImages(false);
      }
    },
    [drafts.length, pushToast, t, joinToast, describeImageError]
  );

  const removeDraft = useCallback((id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
  }, []);

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const sid = viewingRef.current;
    // 只发图不说话是允许的（服务端同样放行），一个字没有又一张图没有才拦
    if ((!text && drafts.length === 0) || !sid || !canSend || sending || preparingImages) return;

    setSending(true);
    setSendError('');
    setShowMentionPopup(false);
    setShowPmPicker(false);
    const outgoing = drafts;
    // 先乐观显示。走 message.send 之后落盘 id 由电脑端生成，回执里不一定带得回来，
    // 所以占位的撤销条件比 inbox 时代宽一点（见 pending 清理 effect）。
    // 占位气泡里的图用本地 data URL；真消息回来时附件已经被服务端投影成 URL 了。
    const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticAtts: Attachment[] = outgoing.map(d => ({
      type: 'image' as const,
      content: d.dataUrl,
      mimeType: d.mimeType,
      ...(d.fileName ? { fileName: d.fileName } : {}),
    }));
    const optimistic: Message = {
      id: localId,
      senderId: USER_ID,
      text,
      timestamp: Date.now(),
      ...(pmTargetId ? { pmTargetId } : {}),
      ...(replyTo ? { replyToId: replyTo.id } : {}),
      ...(optimisticAtts.length > 0 ? { attachments: optimisticAtts } : {}),
    };
    setPending(prev => [...prev, optimistic]);
    setInputText('');
    setDrafts([]);
    if (inputRef.current) inputRef.current.style.height = 'auto';

    const accepted = await runAction({
      type: 'message.send',
      payload: {
        text,
        ...(pmTargetId ? { pmTargetId } : {}),
        ...(replyTo ? { replyToId: replyTo.id } : {}),
        ...(outgoing.length > 0
          ? {
              attachments: outgoing.map(d => ({
                mimeType: d.mimeType,
                data: d.data,
                ...(d.fileName ? { fileName: d.fileName } : {}),
              })),
            }
          : {}),
        // §4：手机端一律不解析 {{ROLL}} 之类的指令，与原来的 inbox 行为一致
        parseCommands: false,
      },
      sessionId: sid,
      key: 'message-send',
      label: t('发送消息'),
      draftMessageId: localId,
      draftText: text,
      draftAttachments: outgoing,
    });

    if (accepted) {
      // 引用是一次性的；私讯目标留着，连着对同一个人说好几句是常态
      setReplyTo(null);
    } else {
      setPending(prev => prev.filter(m => m.id !== localId));
      setInputText(prev => (prev.trim() ? prev : text)); // 失败不吞文本
      if (outgoing.length > 0) setDrafts(prev => (prev.length > 0 ? prev : outgoing)); // 也不吞图
    }
    setSending(false);
  }, [inputText, drafts, canSend, sending, preparingImages, pmTargetId, replyTo, runAction, t]);

  // --- 长按气泡 = 引用回复 ---

  const longPressRef = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);

  const cancelLongPress = useCallback(() => {
    const lp = longPressRef.current;
    if (!lp) return;
    window.clearTimeout(lp.timer);
    longPressRef.current = null;
  }, []);

  useEffect(() => cancelLongPress, [cancelLongPress]);

  /**
   * 事件委托挂在列表容器上，不给每条气泡包一层 div：
   * compact 布局的组间距靠气泡自己的 margin-top，首条靠父级的 `[&>*:first-child]:mt-0` 掐掉，
   * 中间插一层 wrapper 这两条都会失效（首条会白白多出一截顶部空白）。
   */
  const handleListPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      cancelLongPress();
      const list = messageListRef.current;
      if (!list || !canSend) return;
      let node = e.target as HTMLElement | null;
      while (node && node.parentElement !== list) node = node.parentElement;
      if (!node) return;
      const idx = Array.prototype.indexOf.call(list.children, node);
      const msg = winRef.current.messages[idx];
      // 系统消息与搜索结果没法回复，长按它们不该有反应
      if (!msg || msg.isSystem || msg.senderId === 'SYSTEM' || msg.isSearchResult) return;

      const { clientX: x, clientY: y } = e;
      const timer = window.setTimeout(() => {
        if (longPressRef.current) longPressRef.current.fired = true;
        setReplyTo({ id: msg.id, name: nameOfSender(msg), text: previewLine(msg.text).slice(0, 200) });
        // 有振动马达的机器给一下，手指才知道「按到了」
        try {
          navigator.vibrate?.(12);
        } catch {
          /* 不支持就算了 */
        }
      }, LONG_PRESS_MS);
      longPressRef.current = { timer, x, y, fired: false };
    },
    [cancelLongPress, canSend, nameOfSender]
  );

  const handleListPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const lp = longPressRef.current;
      if (!lp) return;
      // 手指开始滑了就是在滚列表，不是长按
      if (Math.abs(e.clientX - lp.x) > LONG_PRESS_SLOP_PX || Math.abs(e.clientY - lp.y) > LONG_PRESS_SLOP_PX) {
        cancelLongPress();
      }
    },
    [cancelLongPress]
  );

  // --- 遥控自动播放 ---

  const handleToggleAutoPlay = useCallback(async () => {
    const sid = viewingRef.current;
    if (!sid || controlPending || !desktopReachable) return;
    const target = !presence?.isAutoPlay;

    setSendError('');
    controlTargetRef.current = target;
    setControlPending(true);
    if (controlTimerRef.current !== null) window.clearTimeout(controlTimerRef.current);
    // presence 回流的兜底：电脑端崩了 / 事件丢了也不能让按钮永远转圈
    controlTimerRef.current = window.setTimeout(() => {
      controlTimerRef.current = null;
      controlTargetRef.current = null;
      setControlPending(false);
    }, CONTROL_PENDING_TIMEOUT_MS);

    try {
      await sendControl(sid, target);
    } catch (err) {
      clearControlPending();
      setSendError(describeControlError(err));
      if (err instanceof ViewerHttpError && (err.status === 401 || err.status === 403)) setPhase('denied');
    }
  }, [controlPending, desktopReachable, presence?.isAutoPlay, clearControlPending, describeControlError]);

  // --- 侧边栏手势 ---
  //
  // 开：从屏幕左边缘 24px 内起手、横向走够 56px。这一档不做跟手动画，只在 touchend 判一次——
  // iOS Safari 的「侧滑返回」抢的正是同一块边缘，跟手做到一半被系统接管的话，
  // 面板会僵在半路，判一次反而稳。有历史记录时这个手势本来就打不过 Safari，
  // 所以 44px 的菜单键才是主入口，这条只是顺手。
  // 关：面板已经挂着，可以真跟手——直接改 DOM 的 transform，不走 setState，
  // 免得每个 touchmove 都把整棵消息树重渲一遍。

  const openSwipeRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const handleRootTouchStart = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      if (sidebarOpen || e.touches.length !== 1) {
        openSwipeRef.current = null;
        return;
      }
      const p = e.touches[0];
      openSwipeRef.current = p.clientX <= EDGE_OPEN_PX ? { x: p.clientX, y: p.clientY, at: Date.now() } : null;
    },
    [sidebarOpen]
  );

  const handleRootTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const start = openSwipeRef.current;
      openSwipeRef.current = null;
      if (!start) return;
      const p = e.changedTouches[0];
      if (!p) return;
      const dx = p.clientX - start.x;
      const dy = p.clientY - start.y;
      // 慢吞吞挪过去的不算：那多半是在选文字
      if (dx >= SWIPE_TRIGGER_PX && Math.abs(dy) < Math.abs(dx) && Date.now() - start.at < 800) openSidebar();
    },
    [openSidebar]
  );

  const closeSwipeRef = useRef<{ x: number; y: number; width: number; axis: 'none' | 'x' } | null>(null);

  /** 跟手期间直接写 style，收尾时清掉，交还给 className 上的过渡 */
  const paintSidebarDrag = useCallback((dx: number | null) => {
    const panel = sidebarPanelRef.current;
    const backdrop = sidebarBackdropRef.current;
    if (!panel) return;
    if (dx === null) {
      panel.style.transition = '';
      panel.style.transform = '';
      if (backdrop) {
        backdrop.style.transition = '';
        backdrop.style.opacity = '';
      }
      return;
    }
    panel.style.transition = 'none';
    panel.style.transform = `translateX(${dx}px)`;
    if (backdrop) {
      backdrop.style.transition = 'none';
      backdrop.style.opacity = String(Math.max(0, 1 + dx / (panel.offsetWidth || 1)));
    }
  }, []);

  const handleSidebarTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) {
      closeSwipeRef.current = null;
      return;
    }
    const p = e.touches[0];
    closeSwipeRef.current = {
      x: p.clientX,
      y: p.clientY,
      width: sidebarPanelRef.current?.offsetWidth || 1,
      axis: 'none',
    };
  }, []);

  const handleSidebarTouchMove = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const s = closeSwipeRef.current;
      const p = e.touches[0];
      if (!s || !p) return;
      const dx = p.clientX - s.x;
      const dy = p.clientY - s.y;
      if (s.axis === 'none') {
        // 先锁轴：竖着走就是在滚面板内容，这一整轮都别再管
        if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
          closeSwipeRef.current = null;
          return;
        }
        if (Math.abs(dx) > 12) s.axis = 'x';
        else return;
      }
      paintSidebarDrag(Math.min(0, dx));
    },
    [paintSidebarDrag]
  );

  const handleSidebarTouchEnd = useCallback(
    (e: React.TouchEvent<HTMLDivElement>) => {
      const s = closeSwipeRef.current;
      closeSwipeRef.current = null;
      if (!s || s.axis !== 'x') return;
      const p = e.changedTouches[0];
      const dx = p ? p.clientX - s.x : 0;
      paintSidebarDrag(null);
      if (dx <= -SWIPE_TRIGGER_PX) closeSidebar();
    },
    [paintSidebarDrag, closeSidebar]
  );

  /**
   * 点会话行：手机自己去看这个会话，不惊动电脑（二期头部下拉的语义）。
   * 「跟随电脑」必须关掉——不关的话电脑那边下一个 presence 事件就把人拽回去了。
   * 电脑在线离线走同一条路：翻历史不需要电脑配合。
   */
  const handlePickSession = useCallback(
    (sessionId: string) => {
      setFollowDesktop(false);
      setViewingSessionId(sessionId);
      closeSidebar();
    },
    [closeSidebar]
  );

  /**
   * 点行尾的显示器键：让**电脑端**也切过去。这一步会停掉电脑的自动播放
   * （与在电脑上手点一致），成功后 settleAction 负责打开「跟随电脑」并收起侧边栏。
   */
  const handleSwitchDesktopSession = useCallback(
    (sessionId: string) => {
      void runAction({
        type: 'session.switch',
        payload: {},
        sessionId,
        key: `switch:${sessionId}`,
        label: t('切换会话'),
      });
    },
    [runAction, t]
  );

  // --- @提及 ---

  const mentionFilteredAgents = useMemo(() => {
    if (!showMentionPopup) return [];
    return sessionMembers.filter(a => a.name.toLowerCase().includes(mentionQuery));
  }, [showMentionPopup, sessionMembers, mentionQuery]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;

    const match = val.match(/@(\S*)$/);
    if (match) {
      setMentionQuery(match[1].toLowerCase());
      setShowMentionPopup(true);
      setSelectedMentionIndex(0);
    } else {
      setShowMentionPopup(false);
    }
  };

  const handleSelectMention = (name: string) => {
    setInputText(prev => prev.replace(/@(\S*)$/, `@${name} `));
    setShowMentionPopup(false);
    inputRef.current?.focus();
  };

  // 手机上 Enter 是换行，不做 Enter 发送、也不让提及弹窗抢 Enter；
  // 只保留方向键 / Tab / Esc 给外接键盘用，选人主要靠点。
  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showMentionPopup || mentionFilteredAgents.length === 0) return;
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedMentionIndex(prev => Math.max(0, prev - 1));
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedMentionIndex(prev => Math.min(mentionFilteredAgents.length - 1, prev + 1));
    } else if (e.key === 'Tab') {
      e.preventDefault();
      handleSelectMention(mentionFilteredAgents[selectedMentionIndex].name);
    } else if (e.key === 'Escape') {
      setShowMentionPopup(false);
    }
  };

  // ------------------------------------------------------------------
  // 引导页 / 错误页
  // ------------------------------------------------------------------

  if (phase === 'no-token') {
    return (
      <Gate
        title={t('需要访问令牌')}
        body={t('请在电脑端点开「📱 手机观看」，用手机扫那个二维码进来。')}
      />
    );
  }

  if (phase === 'denied') {
    return (
      <Gate
        title={t('令牌无效或已过期')}
        body={t('电脑端换过令牌，或者链接是旧的。请重新扫一次码。')}
      >
        <button
          onClick={() => {
            clearToken();
            setToken(null);
            setPhase('no-token');
          }}
          className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-sm font-medium"
        >
          {t('清除本机令牌')}
        </button>
      </Gate>
    );
  }

  if (phase === 'error') {
    return (
      <Gate title={t('连不上电脑端')} body={fatalMessage}>
        <button
          onClick={() => {
            setPhase('loading');
            void loadBootstrap();
          }}
          className="px-4 py-2 rounded-xl bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 text-sm font-medium flex items-center gap-2"
        >
          <RefreshCw size={14} /> {t('重试')}
        </button>
      </Gate>
    );
  }

  if (phase === 'loading' || !boot) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50 dark:bg-black text-gray-400 gap-2">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">{t('加载中...')}</span>
      </div>
    );
  }

  // ------------------------------------------------------------------
  // 主界面
  // ------------------------------------------------------------------

  const generatingNames = (presence?.processingAgentIds || [])
    .map(id => boot.agents.find(a => a.id === id)?.name)
    .filter(Boolean) as string[];

  const bubbleUserProfile = {
    userProfiles: boot.settings.userProfiles,
    userName: boot.settings.userName,
    userAvatar: boot.settings.userAvatar,
    expandAllReasoning: boot.settings.expandAllReasoning,
  };

  const pmTarget = pmTargetId ? sessionMembers.find(a => a.id === pmTargetId) || null : null;

  /** 头部右端那句只读状态 */
  const linkText = desktopReachable ? t('在线') : link === 'connecting' ? t('正在连接...') : t('离线');

  const sidebarTitle =
    sidebarPage === 'members'
      ? t('成员')
      : sidebarPage === 'edit'
        ? t('编辑角色')
        : sidebarPage === 'create'
          ? t('新建角色')
          : t('菜单');

  const themeOptions: Array<{ value: ViewerTheme | null; label: string; Icon: typeof Sun }> = [
    { value: 'light', label: t('浅色'), Icon: Sun },
    { value: 'dark', label: t('深色'), Icon: Moon },
    { value: null, label: t('跟随'), Icon: Monitor },
  ];

  return (
    <I18nProvider locale={lang}>
      {/* 高度走 --vvh（visualViewport 实测值）而不是 .h-screen：
          src/index.css 里 .h-screen 是 `100dvh !important`，dvh 不扣软键盘，
          键盘一弹起来输入区就跑到屏幕外面去了。没有 visualViewport 的浏览器落回 100dvh。 */}
      <div
        className="flex flex-col bg-gray-50 dark:bg-black overflow-hidden relative"
        style={{ height: 'var(--vvh, 100dvh)' }}
        onTouchStart={handleRootTouchStart}
        onTouchEnd={handleRootTouchEnd}
        onTouchCancel={() => {
          openSwipeRef.current = null;
        }}
      >
        {/* 头部只剩三样：44×44 的菜单键、会话标题、只读的在线状态。
            三期这里塞了会话下拉 + 两颗 32px 圆钮 + 两颗 20px 胶囊，Sol 在真机上够不着——
            所有能点的东西都搬进侧边栏，那边每行 ≥52px。 */}
        <header className="shrink-0 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 pl-0.5 pr-3">
          <div className="flex items-center gap-1">
            <button
              onClick={openSidebar}
              aria-label={t('打开菜单')}
              title={t('菜单')}
              className="shrink-0 w-11 h-11 flex items-center justify-center rounded-xl text-gray-600 dark:text-gray-300 active:bg-gray-100 dark:active:bg-zinc-800"
            >
              <Menu size={22} />
            </button>

            <h1 className="flex-1 min-w-0 truncate text-[15px] font-semibold text-gray-900 dark:text-gray-100">
              {currentSession?.name || t('未命名会话')}
            </h1>

            {/* SSE 断了就等于不知道电脑那边什么情况，别再报「在线」；
                还没握上手的那一小会儿也别急着报「离线」，用中性的「正在连接」占位 */}
            <span className="shrink-0 flex items-center gap-1.5 text-[12px] text-gray-500 dark:text-gray-400">
              {link === 'offline' ? (
                <Loader2 size={11} className="animate-spin text-amber-500 shrink-0" />
              ) : (
                <span className={`w-2 h-2 rounded-full shrink-0 ${desktopReachable ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              )}
              {linkText}
            </span>
          </div>
        </header>

        {/* 「正在生成：xxx」。浮在消息列表上方而不是占头部一行：它来了又走，
            占位的话每次有人开口整个列表都要跳一下。只读，不拦触摸。 */}
        {generatingNames.length > 0 && (
          <div className="pointer-events-none absolute top-14 inset-x-0 z-20 flex justify-center px-4">
            <div className="max-w-full rounded-full bg-blue-500/90 text-white text-[11px] px-3 py-1 shadow-md flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin shrink-0" />
              <span className="truncate">
                {t('正在生成')}
                {lang === 'zh' ? '：' : ': '}
                {generatingNames.join(', ')}
              </span>
            </div>
          </div>
        )}


        {/* 消息列表 */}
        <div className="flex-1 overflow-y-auto px-3 py-4 bg-gray-50/50 dark:bg-black/50" ref={scrollContainerRef}>
          <div className="max-w-2xl mx-auto w-full">
            {win.from > 0 && (
              <div className="flex justify-center mb-4">
                <button
                  onClick={handleLoadEarlier}
                  disabled={loadingEarlier}
                  className="px-3 py-1.5 rounded-full text-xs bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-gray-400 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {loadingEarlier ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
                  {loadingEarlier ? t('正在加载...') : t('加载更早')}
                </button>
              </div>
            )}
            {win.from === 0 && win.messages.length > 0 && (
              <div className="text-center text-[10px] text-gray-400 dark:text-gray-600 mb-4">
                {t('已经是最早的消息')}
              </div>
            )}

            {loadingSession && win.messages.length === 0 && (
              <div className="flex items-center justify-center py-16 text-gray-400 gap-2">
                <Loader2 size={16} className="animate-spin" />
                <span className="text-sm">{t('加载中...')}</span>
              </div>
            )}

            {!loadingSession && displayMessages.length === 0 && (
              <div className="text-center text-sm text-gray-400 py-16">{t('这个会话还没有消息')}</div>
            )}

            {/* [&>*:first-child]:mt-0 —— compact 下气泡的组间距挂在 margin-top 上，
                列表第一条不该跟着多出一截顶部空白。包一层 div 才让 :first-child 指的是
                真正的第一条消息（外面还有「加载更早」按钮之类的兄弟节点）。 */}
            <div
              ref={messageListRef}
              className="[&>*:first-child]:mt-0"
              onPointerDown={handleListPointerDown}
              onPointerMove={handleListPointerMove}
              onPointerUp={cancelLongPress}
              onPointerCancel={cancelLongPress}
              onPointerLeave={cancelLongPress}
              onContextMenu={e => {
                // 长按已经把引用条摆出来了，再让系统弹一次「复制/搜索」菜单是打架
                if (longPressRef.current?.fired) e.preventDefault();
              }}
            >
              {win.messages.map((msg, i) => (
                <ChatBubble
                  key={msg.id}
                  message={msg}
                  readOnly
                  compact
                  continued={isContinuedMessage(win.messages[i - 1], msg)}
                  sender={boot.agents.find(a => a.id === msg.senderId) as Agent | undefined}
                  allAgents={bubbleAgents}
                  userProfile={bubbleUserProfile}
                  replyToMessage={msg.replyToId ? win.messages.find(m => m.id === msg.replyToId) : undefined}
                  isStreaming={!!msg.isStreaming}
                />
              ))}
            </div>

            {/* 乐观显示的待发消息 */}
            {pending.map(msg => (
              <div key={msg.id} className="opacity-50">
                <ChatBubble message={msg} readOnly compact userProfile={bubbleUserProfile} allAgents={bubbleAgents} />
                {/* pr 对齐右侧头像列（w-10 + ml-3 = 52px），compact 下气泡底下已经没有时间戳行了 */}
                <div className="text-[10px] text-gray-400 text-right mt-1 pr-[52px]">{t('发送中')}…</div>
              </div>
            ))}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {showScrollButton && (
          <button
            onClick={() => {
              scrollToBottom();
              setShowScrollButton(false);
              setIsNearBottom(true);
            }}
            className="absolute bottom-28 right-4 bg-zinc-900 dark:bg-zinc-800 text-white p-3 rounded-full shadow-lg z-30"
            aria-label={t('回到底部')}
          >
            <ArrowDown size={18} />
          </button>
        )}

        {/* 输入区 */}
        <div className="shrink-0 bg-white dark:bg-zinc-900 border-t border-gray-200 dark:border-zinc-800 px-3 pt-2 pb-2 pb-safe">
          <div className="max-w-2xl mx-auto w-full relative">
            {sendError && (
              <div className="mb-2 text-[11px] text-red-500 flex items-start gap-1.5">
                <AlertCircle size={12} className="mt-0.5 shrink-0" />
                <span>{sendError}</span>
              </div>
            )}
            {!sendError && sendBlockedReason && (
              <div className="mb-2 text-[11px] text-gray-400">{sendBlockedReason}</div>
            )}

            {/* @提及弹窗 */}
            {showMentionPopup && mentionFilteredAgents.length > 0 && (
              <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 shadow-xl rounded-xl w-64 max-h-48 overflow-y-auto z-50">
                <div className="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase border-b border-gray-50 dark:border-zinc-700">
                  {t('提及成员 (@)')}
                </div>
                {mentionFilteredAgents.map((agent, index) => (
                  <button
                    key={agent.id}
                    onClick={() => handleSelectMention(agent.name)}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm ${
                      index === selectedMentionIndex
                        ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-white'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    <img src={agent.avatar} alt="" className="w-5 h-5 rounded-full object-contain" />
                    <span className="truncate">{agent.name}</span>
                  </button>
                ))}
              </div>
            )}
            {showMentionPopup && mentionFilteredAgents.length === 0 && sessionMembers.length > 0 && (
              <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 shadow-xl rounded-xl px-3 py-2 text-[11px] text-gray-400 z-50 flex items-center gap-1.5">
                <Users size={12} /> {t('提及成员 (@)')}
              </div>
            )}

            {/* 私讯目标选择器。列表和 @提及弹窗同一套样式，位置也一样（贴着输入区上沿弹）。 */}
            {showPmPicker && (
              <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-zinc-900 border border-gray-200 dark:border-zinc-700 shadow-xl rounded-xl w-64 max-h-56 overflow-y-auto overscroll-contain z-50">
                <div className="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase border-b border-gray-50 dark:border-zinc-700">
                  {t('私讯给…')}
                </div>
                <button
                  onClick={() => {
                    setPmTargetId(null);
                    setShowPmPicker(false);
                  }}
                  className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                >
                  <Users size={16} className="text-gray-400 shrink-0" />
                  <span className="truncate">{t('发给全群')}</span>
                  {!pmTargetId && <Check size={14} className="ml-auto shrink-0 text-emerald-500" />}
                </button>
                {sessionMembers.map(agent => (
                  <button
                    key={agent.id}
                    onClick={() => {
                      setPmTargetId(agent.id);
                      setShowPmPicker(false);
                    }}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
                  >
                    <img src={agent.avatar} alt="" className="w-5 h-5 rounded-full object-contain shrink-0" />
                    <span className="truncate">{agent.name}</span>
                    {pmTargetId === agent.id && <Check size={14} className="ml-auto shrink-0 text-emerald-500" />}
                  </button>
                ))}
              </div>
            )}

            {/* 引用条：长按气泡设上的，发出去后自动清掉。
                压成一行（整条正好 44px = 关闭键那么高）：这里挨着输入框，
                两行的版本会把本来就被软键盘压扁的可视区再吃掉一截。 */}
            {replyTo && (
              <div className="mb-2 flex items-center h-11 rounded-xl bg-gray-100 dark:bg-zinc-800 border-l-2 border-zinc-400 dark:border-zinc-500 pl-2.5">
                <CornerUpLeft size={14} className="shrink-0 text-gray-400" />
                <div className="min-w-0 flex-1 ml-2 text-[12px] text-gray-400 dark:text-gray-500 truncate">
                  <span className="font-medium text-gray-600 dark:text-gray-300">
                    {t('回复')} {replyTo.name}
                  </span>
                  {lang === 'zh' ? '：' : ': '}
                  {replyTo.text}
                </div>
                <button
                  onClick={() => setReplyTo(null)}
                  aria-label={t('取消回复')}
                  className="shrink-0 w-11 h-11 flex items-center justify-center text-gray-400"
                >
                  <X size={16} />
                </button>
              </div>
            )}

            {/* 私讯目标的常驻提示：私讯是「只有 TA 看得见」，发出去之前得让人一眼看到 */}
            {pmTarget && (
              <div className="mb-2 flex items-center gap-1 w-fit max-w-full rounded-full bg-violet-50 dark:bg-violet-900/25 text-violet-700 dark:text-violet-300 pl-2.5 pr-0.5 text-[11px]">
                <span className="truncate py-1">
                  {t('私讯给')} {pmTarget.name}
                </span>
                <button
                  onClick={() => setPmTargetId(null)}
                  aria-label={t('取消私讯')}
                  className="shrink-0 w-10 h-10 min-w-0 min-h-0 flex items-center justify-center"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            {/* 待发图片的缩略图条。缩略图 64×64，删除键的**命中区**是 44×44（压在图右上角那一块，
                不越出边界——外面就是 overflow-x-auto 的裁剪线），可见的圆点只有 24px。
                四张 64px 在 360 宽下其实还排得开，overflow-x-auto 是给更窄的屏 / 更大字号兜底的。 */}
            {drafts.length > 0 && (
              <div className="mb-2 flex gap-2 overflow-x-auto">
                {drafts.map(d => (
                  <div key={d.id} className="relative shrink-0 w-16 h-16">
                    <img
                      src={d.dataUrl}
                      alt={d.fileName || ''}
                      className="w-16 h-16 rounded-lg object-cover border border-gray-200 dark:border-zinc-700 bg-gray-100 dark:bg-zinc-800"
                    />
                    <button
                      type="button"
                      onClick={() => removeDraft(d.id)}
                      disabled={sending}
                      aria-label={t('移除图片')}
                      className="absolute top-0 right-0 w-11 h-11 flex items-start justify-end p-0.5 disabled:opacity-40"
                    >
                      <span className="w-6 h-6 rounded-full bg-zinc-900/85 dark:bg-white/90 text-white dark:text-zinc-900 flex items-center justify-center shadow">
                        <X size={14} />
                      </span>
                    </button>
                  </div>
                ))}
              </div>
            )}

            <form
              onSubmit={e => {
                e.preventDefault();
                void handleSend();
              }}
              className="relative flex items-end gap-1.5"
            >
              {/* 图片键。accept="image/*" + multiple：iOS 上点它会给「拍照 / 照片图库 / 浏览」三选一。
                  input 本身藏起来，因为它自己的样式在各家浏览器上长得都不一样，也不可能做到 44px。 */}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={e => {
                  void handlePickImages(e.target.files);
                  e.target.value = ''; // 同一张图连选两次也要触发 change
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={
                  !canSend || sending || preparingImages || drafts.length >= ACTION_LIMITS.attachmentsPerMessage
                }
                aria-label={t('添加图片')}
                title={t('添加图片')}
                className="shrink-0 w-11 h-11 rounded-xl border flex items-center justify-center transition-colors disabled:opacity-40 bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-gray-400"
              >
                {preparingImages ? <Loader2 size={18} className="animate-spin" /> : <ImagePlus size={18} />}
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowPmPicker(v => !v);
                  setShowMentionPopup(false);
                }}
                disabled={!canSend || sessionMembers.length === 0}
                aria-label={t('私讯给…')}
                title={t('私讯给…')}
                className={`shrink-0 w-11 h-11 rounded-xl border flex items-center justify-center transition-colors disabled:opacity-40 ${
                  pmTargetId
                    ? 'bg-violet-100 dark:bg-violet-900/40 border-violet-300 dark:border-violet-800 text-violet-700 dark:text-violet-300'
                    : 'bg-gray-100 dark:bg-zinc-800 border-gray-200 dark:border-zinc-700 text-gray-500 dark:text-gray-400'
                }`}
              >
                <UserCog size={18} />
              </button>

              <div className="relative flex-1 min-w-0">
                <textarea
                  ref={inputRef}
                  value={inputText}
                  onChange={handleInputChange}
                  onKeyDown={handleInputKeyDown}
                  disabled={!canSend}
                  rows={1}
                  placeholder={canSend ? t('说点什么...') : sendBlockedReason}
                  className="w-full bg-gray-100 dark:bg-zinc-800 border border-gray-200 dark:border-zinc-700 rounded-xl pl-4 pr-14 py-3 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-zinc-300 dark:focus:ring-zinc-600 resize-none overflow-y-auto disabled:opacity-60"
                  style={{ minHeight: '52px', maxHeight: '140px' }}
                />
                <button
                  type="submit"
                  disabled={
                    !canSend || (!inputText.trim() && drafts.length === 0) || sending || preparingImages
                  }
                  aria-label={t('发送')}
                  className="absolute right-2 bottom-2 p-2 bg-zinc-900 dark:bg-white rounded-lg text-white dark:text-zinc-900 disabled:opacity-30 shadow-sm"
                >
                  {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
                </button>
              </div>
            </form>
          </div>
        </div>

        {/* 动作结果 toast。侧边栏之上（z-60），不然在侧边栏里点的按钮看不到回执。
            底部偏移分两档：侧边栏关着时要让开输入区（92px），开着时输入区被盖住了，贴着屏幕底更不挡内容。 */}
        {toasts.length > 0 && (
          <div
            className="pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-1.5 px-4"
            style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${sidebarOpen ? 16 : 92}px)` }}
          >
            {toasts.map(item => (
              <div
                key={item.id}
                className={`max-w-full rounded-full px-3.5 py-2 text-[12px] shadow-lg flex items-center gap-1.5 ${
                  item.kind === 'ok'
                    ? 'bg-zinc-900/95 dark:bg-white/95 text-white dark:text-zinc-900'
                    : 'bg-red-600/95 text-white'
                }`}
              >
                {item.kind === 'ok' ? (
                  <Check size={13} className="shrink-0" />
                ) : (
                  <AlertCircle size={13} className="shrink-0" />
                )}
                <span className="min-w-0 line-clamp-2 break-words leading-snug">{item.text}</span>
              </div>
            ))}
          </div>
        )}

        {/* 侧边栏（四期）。从左侧滑出，宽 min(85vw, 360px)，高度跟 --vvh 走（软键盘弹起时
            也不会有一截跑到屏幕外）。外层 flex：面板占左边，剩下的宽度整块是遮罩，点它关闭。
            内容区自己滚，overscroll-contain 掐断滚动链，否则滑到底会把身后的消息列表一起带着走。 */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-50 flex" style={{ height: 'var(--vvh, 100dvh)' }}>
            <div
              ref={sidebarPanelRef}
              role="dialog"
              aria-modal="true"
              aria-label={t('菜单')}
              onTouchStart={handleSidebarTouchStart}
              onTouchMove={handleSidebarTouchMove}
              onTouchEnd={handleSidebarTouchEnd}
              onTouchCancel={() => {
                closeSwipeRef.current = null;
                paintSidebarDrag(null);
              }}
              className={`relative z-10 flex flex-col h-full bg-white dark:bg-zinc-900 shadow-2xl transition-transform duration-200 ease-out ${
                sidebarShown ? 'translate-x-0' : '-translate-x-full'
              }`}
              style={{ width: 'min(85vw, 360px)' }}
            >
              {/* 顶栏。主页是标题 + 关闭；子页把标题换成整条 44px 的返回栏（‹ 成员）。 */}
              <div className="shrink-0 flex items-center gap-1 h-12 px-0.5 border-b border-gray-200 dark:border-zinc-800">
                {sidebarPage === 'home' ? (
                  <span className="flex-1 min-w-0 truncate pl-3.5 text-[15px] font-semibold text-gray-900 dark:text-gray-100">
                    {sidebarTitle}
                  </span>
                ) : (
                  <button
                    onClick={() => setSidebarPage('home')}
                    aria-label={t('返回')}
                    className="flex-1 min-w-0 h-11 flex items-center gap-0.5 pl-1 pr-2 rounded-xl text-left active:bg-gray-100 dark:active:bg-zinc-800"
                  >
                    <ChevronLeft size={20} className="shrink-0 text-gray-400" />
                    <span className="truncate text-[15px] font-semibold text-gray-900 dark:text-gray-100">
                      {sidebarTitle}
                    </span>
                  </button>
                )}
                <button
                  onClick={closeSidebar}
                  aria-label={t('关闭菜单')}
                  className="shrink-0 w-11 h-11 flex items-center justify-center rounded-xl text-gray-400 active:bg-gray-100 dark:active:bg-zinc-800"
                >
                  <X size={20} />
                </button>
              </div>

              {!desktopReachable && (
                <div className="shrink-0 px-4 py-2 text-[11px] leading-snug break-words text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-b border-amber-100 dark:border-amber-900/40">
                  {t('电脑端已离线，暂时不能操作')}
                </div>
              )}

              <div className="flex-1 overflow-y-auto overscroll-contain pb-safe">
                {sidebarPage === 'home' && (
                  <>
                    <SidebarSection>{t('会话')}</SidebarSection>
                    <SessionsPanel
                      t={t}
                      groups={boot.groups}
                      sessions={sessions}
                      activeSessionId={activeSessionId}
                      viewingSessionId={viewingSessionId}
                      disabled={!desktopReachable}
                      isPending={isPending}
                      runAction={runAction}
                      onPick={handlePickSession}
                      onSwitchDesktop={handleSwitchDesktopSession}
                    />

                    <SidebarSection>{t('控制')}</SidebarSection>
                    <SidebarSwitch
                      label={t('自动播放')}
                      hint={presence?.isAutoPlay ? t('电脑端正在播放') : t('电脑端已暂停')}
                      checked={!!presence?.isAutoPlay}
                      pending={controlPending}
                      disabled={!desktopReachable}
                      onToggle={() => void handleToggleAutoPlay()}
                    />
                    <SidebarSwitch
                      label={t('跟随电脑')}
                      hint={followDesktop ? t('会话跟着电脑端走') : t('手机自己选会话')}
                      checked={followDesktop}
                      onToggle={() => {
                        const next = !followDesktop;
                        setFollowDesktop(next);
                        if (next && presence?.activeSessionId) setViewingSessionId(presence.activeSessionId);
                      }}
                    />
                    {/* 主题三选一。段是 44px 高的按钮；英文 "Follow computer" 塞不进三分之一宽，
                        段上只写「跟随 / Auto」，选中这档时下面补一句完整说明。 */}
                    <div className="px-4 pt-2.5 pb-3">
                      <div className="text-[15px] leading-snug text-gray-900 dark:text-gray-100 mb-1.5">{t('主题')}</div>
                      <div className="flex rounded-xl border border-gray-200 dark:border-zinc-700 overflow-hidden">
                        {themeOptions.map(({ value, label, Icon }, i) => {
                          const on = themeOverride === value;
                          return (
                            <button
                              key={label}
                              onClick={() => handlePickTheme(value)}
                              aria-pressed={on}
                              className={`flex-1 min-w-0 min-h-[44px] px-1 py-1 flex flex-col items-center justify-center gap-0.5 text-[11px] leading-tight transition-colors ${
                                i > 0 ? 'border-l border-gray-200 dark:border-zinc-700' : ''
                              } ${
                                on
                                  ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900'
                                  : 'text-gray-500 dark:text-gray-400'
                              }`}
                            >
                              <Icon size={14} className="shrink-0" />
                              <span className="max-w-full break-words text-center">{label}</span>
                            </button>
                          );
                        })}
                      </div>
                      {themeOverride === null && (
                        <div className="text-[11px] leading-snug break-words text-gray-400 dark:text-gray-500 mt-1.5">
                          {t('深浅色跟随电脑端')}
                        </div>
                      )}
                    </div>

                    <SidebarSection>{t('管理')}</SidebarSection>
                    <SidebarRow
                      icon={<Users size={16} />}
                      title={t('成员')}
                      subtitle={activeGroup?.name}
                      disabled={!desktopReachable}
                      trailing={<ChevronRight size={16} />}
                      onClick={() => setSidebarPage('members')}
                    />
                    <SidebarRow
                      icon={<UserCog size={16} />}
                      title={t('编辑角色')}
                      disabled={!desktopReachable}
                      trailing={<ChevronRight size={16} />}
                      onClick={() => setSidebarPage('edit')}
                    />
                    <SidebarRow
                      icon={<Plus size={16} />}
                      title={t('新建角色')}
                      disabled={!desktopReachable}
                      trailing={<ChevronRight size={16} />}
                      onClick={() => setSidebarPage('create')}
                    />

                    {/* 侧边栏开着时头部被盖住了，状态在这儿再说一遍 */}
                    <div className="mt-3 px-4 py-4 border-t border-gray-100 dark:border-zinc-800 text-[11px] leading-snug break-words text-gray-400 dark:text-gray-500">
                      {t('电脑端')}
                      {lang === 'zh' ? '：' : ': '}
                      {linkText}
                    </div>
                  </>
                )}

                {sidebarPage === 'members' && (
                  <MembersPanel
                    t={t}
                    lang={lang}
                    runAction={runAction}
                    isPending={isPending}
                    disabled={!desktopReachable}
                    agents={boot.agents}
                    group={activeGroup}
                    sessionId={activeSessionId}
                    mutedAgents={activeMuted}
                    processingAgentIds={presence?.processingAgentIds || []}
                    onEditAgent={id => {
                      setEditAgentId(id);
                      setSidebarPage('edit');
                    }}
                    scopeHint={
                      activeSessionId && activeSessionId !== viewingSessionId
                        ? {
                            sessionName: activeSession?.name || t('未命名会话'),
                            onJump: () => {
                              setFollowDesktop(true);
                              setViewingSessionId(activeSessionId);
                              closeSidebar();
                            },
                          }
                        : null
                    }
                  />
                )}
                {sidebarPage === 'edit' && (
                  <AgentEditPanel
                    t={t}
                    lang={lang}
                    runAction={runAction}
                    isPending={isPending}
                    disabled={!desktopReachable}
                    agents={boot.agents}
                    providers={providers}
                    group={activeGroup}
                    selectedId={editAgentId}
                    onSelect={setEditAgentId}
                  />
                )}
                {sidebarPage === 'create' && (
                  <AgentCreatePanel
                    t={t}
                    lang={lang}
                    runAction={runAction}
                    isPending={isPending}
                    disabled={!desktopReachable}
                    providers={providers}
                    sessionId={activeSessionId}
                    onCreated={() => setSidebarPage('members')}
                  />
                )}
              </div>
            </div>

            <div
              ref={sidebarBackdropRef}
              onClick={closeSidebar}
              aria-hidden="true"
              className={`flex-1 bg-black/40 transition-opacity duration-200 ${
                sidebarShown ? 'opacity-100' : 'opacity-0'
              }`}
            />
          </div>
        )}
      </div>
    </I18nProvider>
  );
};

export default ViewerApp;
