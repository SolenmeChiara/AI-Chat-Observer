// 手机观众端主界面（PHONE_VIEWER_PLAN.md §5）。
//
// 和 App.tsx 的关系：只复用 ChatBubble 和 types，不 import 任何 service、不碰 db、
// 不做任何写盘。会话文件唯一的写者永远是电脑端，手机只读 + 往 inbox 投一条纯文本。
//
// 移动优先：h-screen（src/index.css 已经把它覆盖成 100dvh）、输入区 pb-safe、
// 不做 hover-only 交互、不做 Enter 发送（手机软键盘的 Enter 是换行）。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Agent, Message } from '../types';
import { USER_ID } from '../constants';
import { I18nProvider } from '../i18n';
import ChatBubble from '../components/ChatBubble';
import {
  AlertCircle,
  ArrowDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  Send,
  Smartphone,
  Users,
} from 'lucide-react';
import { makeViewerT } from './strings';
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
  clearToken,
  connectLiveEvents,
  fetchBootstrap,
  fetchSessionRange,
  fetchSessionTail,
  getToken,
  initToken,
  mergeMessages,
  nextSyncFrom,
  sendInbox,
} from './viewerClient';

type Phase = 'loading' | 'no-token' | 'denied' | 'error' | 'ready';

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

  const [inputText, setInputText] = useState('');
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);

  const [isNearBottom, setIsNearBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // SSE 回调是「渲染之外」触发的，闭包会锁死旧 state（App.tsx:2908-2915 记过同样的坑），
  // 所以凡是回调要读的 state 都在渲染期同步进 ref。
  const winRef = useRef(win);
  winRef.current = win;
  const viewingRef = useRef(viewingSessionId);
  viewingRef.current = viewingSessionId;
  const followRef = useRef(followDesktop);
  followRef.current = followDesktop;

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

  /** 按 group 分组的会话列表，喂给头部下拉 */
  const groupedSessions = useMemo(() => {
    if (!boot) return [];
    return boot.groups
      .map(g => ({ group: g, items: boot.sessions.filter(s => s.groupId === g.id) }))
      .filter(entry => entry.items.length > 0);
  }, [boot]);

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

  const describeSendError = useCallback(
    (err: unknown): string => {
      if (err instanceof ViewerHttpError) {
        if (err.status === 503 || err.code === 'desktop-offline') return t('电脑端已离线，消息没发出去');
        if (err.status === 409 || err.code === 'not-active-session') return t('电脑端已经切到别的会话了，消息没发出去');
        if (err.status === 429) return t('发得太快了，缓一缓再发');
        if (err.status === 400) return t('消息为空或太长（上限 4000 字）');
        if (err.status === 401 || err.status === 403) return t('访问令牌无效，请重新扫码');
        return `${t('发送失败')}（HTTP ${err.status}）`;
      }
      return `${t('发送失败')}（${t('网络不通')}）`;
    },
    [t]
  );

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

  const applyPresence = useCallback((p: PresenceState) => {
    if (!p) return;
    setPresence(p);
    // 「跟随电脑」开着时，电脑切会话手机就跟着切
    if (followRef.current && p.activeSessionId && p.activeSessionId !== viewingRef.current) {
      setViewingSessionId(p.activeSessionId);
    }
  }, []);

  const blocked = phase === 'no-token' || phase === 'denied';

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
        if (data.id !== viewingRef.current) return;
        if (data.deleted) {
          void loadBootstrap(true);
          return;
        }
        void runSync();
      },
      onReconnect: () => {
        // 断线期间可能错过若干 session 事件，索引和窗口都当作脏的重来一遍
        void loadBootstrap(true);
        void runSync();
      },
    });
    return close;
  }, [token, blocked, applyPresence, loadBootstrap, runSync]);

  // --- pending 清理：真消息进窗口后就撤掉乐观占位 ---

  useEffect(() => {
    if (pending.length === 0) return;
    const ids = new Set(win.messages.map(m => m.id));
    const rest = pending.filter(p => !ids.has(p.id));
    if (rest.length !== pending.length) setPending(rest);
  }, [win, pending]);

  // --- 主题：跟随电脑端 settings.darkMode ---

  useEffect(() => {
    const dark = !!boot?.settings.darkMode;
    document.documentElement.classList.toggle('dark', dark);
  }, [boot?.settings.darkMode]);

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

  const handleSend = useCallback(async () => {
    const text = inputText.trim();
    const sid = viewingRef.current;
    if (!text || !sid || !canSend || sending) return;

    setSending(true);
    setSendError('');
    setShowMentionPopup(false);
    // 先乐观显示，服务端 202 回来后把占位的 id 换成服务端给的 inbox-… id，
    // 之后电脑端落盘、session 事件把真消息带回来，pending 清理 effect 就撤掉占位。
    const localId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimistic: Message = { id: localId, senderId: USER_ID, text, timestamp: Date.now() };
    setPending(prev => [...prev, optimistic]);
    setInputText('');
    if (inputRef.current) inputRef.current.style.height = 'auto';

    try {
      const { id } = await sendInbox(sid, text);
      setPending(prev => prev.map(m => (m.id === localId ? { ...m, id } : m)));
    } catch (err) {
      setPending(prev => prev.filter(m => m.id !== localId));
      setInputText(text); // 失败不吞文本
      setSendError(describeSendError(err));
      if (err instanceof ViewerHttpError && (err.status === 401 || err.status === 403)) setPhase('denied');
    } finally {
      setSending(false);
    }
  }, [inputText, canSend, sending, describeSendError]);

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

  return (
    <I18nProvider locale={lang}>
      <div className="h-screen flex flex-col bg-gray-50 dark:bg-black overflow-hidden relative">
        {/* 头部 */}
        <header className="shrink-0 bg-white dark:bg-zinc-900 border-b border-gray-200 dark:border-zinc-800 px-3 pt-2 pb-1.5">
          <div className="flex items-center gap-2">
            <select
              value={viewingSessionId || ''}
              onChange={e => {
                // 手动选会话就默认不再跟随电脑，否则下一个 presence 事件立刻把人拽回去
                setFollowDesktop(false);
                setViewingSessionId(e.target.value);
              }}
              aria-label={t('选择会话')}
              className="flex-1 min-w-0 bg-transparent text-[15px] font-semibold text-gray-900 dark:text-gray-100 border-0 focus:outline-none truncate py-1"
            >
              {groupedSessions.map(({ group, items }) => (
                <optgroup key={group.id} label={group.name}>
                  {items.map(s => (
                    <option key={s.id} value={s.id}>
                      {s.name || t('未命名会话')}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>

            <button
              onClick={() => {
                const next = !followDesktop;
                setFollowDesktop(next);
                if (next && presence?.activeSessionId) setViewingSessionId(presence.activeSessionId);
              }}
              className={`shrink-0 px-2.5 py-1 rounded-full text-[11px] font-medium border transition-colors ${
                followDesktop
                  ? 'bg-zinc-900 dark:bg-white text-white dark:text-zinc-900 border-transparent'
                  : 'bg-transparent text-gray-500 dark:text-gray-400 border-gray-300 dark:border-zinc-700'
              }`}
            >
              {t('跟随电脑')}
            </button>
          </div>

          {/* 状态条 */}
          <div className="flex items-center gap-2 text-[11px] text-gray-500 dark:text-gray-400 flex-wrap">
            {/* SSE 断了就等于不知道电脑那边什么情况，别再报「在线」；
                还没握上手的那一小会儿也别急着报「离线」，用中性的「正在连接」占位 */}
            <span className="flex items-center gap-1">
              <span className={`w-1.5 h-1.5 rounded-full ${desktopReachable ? 'bg-emerald-500' : 'bg-gray-400'}`} />
              {desktopReachable ? t('在线') : link === 'connecting' ? t('正在连接...') : t('离线')}
            </span>
            <span className="text-gray-300 dark:text-zinc-700">·</span>
            <span>{presence?.isAutoPlay ? t('自动播放') : t('已暂停')}</span>
            {generatingNames.length > 0 && (
              <>
                <span className="text-gray-300 dark:text-zinc-700">·</span>
                <span className="text-blue-500 truncate max-w-[45%]">
                  {t('正在生成')}：{generatingNames.join(', ')}
                </span>
              </>
            )}
            {linkLost && (
              <span className="ml-auto text-amber-500 flex items-center gap-1">
                <Loader2 size={10} className="animate-spin" />
                {t('连接已断开，正在重连...')}
              </span>
            )}
          </div>
        </header>

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

            {win.messages.map(msg => (
              <ChatBubble
                key={msg.id}
                message={msg}
                readOnly
                sender={boot.agents.find(a => a.id === msg.senderId) as Agent | undefined}
                allAgents={bubbleAgents}
                userProfile={bubbleUserProfile}
                replyToMessage={msg.replyToId ? win.messages.find(m => m.id === msg.replyToId) : undefined}
                isStreaming={!!msg.isStreaming}
              />
            ))}

            {/* 乐观显示的待发消息 */}
            {pending.map(msg => (
              <div key={msg.id} className="opacity-50">
                <ChatBubble message={msg} readOnly userProfile={bubbleUserProfile} allAgents={bubbleAgents} />
                <div className="text-[10px] text-gray-400 text-right -mt-4 mb-4 pr-14">{t('发送中')}…</div>
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

            <form
              onSubmit={e => {
                e.preventDefault();
                void handleSend();
              }}
              className="relative flex items-end"
            >
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
                disabled={!canSend || !inputText.trim() || sending}
                aria-label={t('发送')}
                className="absolute right-2 bottom-2 p-2 bg-zinc-900 dark:bg-white rounded-lg text-white dark:text-zinc-900 disabled:opacity-30 shadow-sm"
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </form>
          </div>
        </div>
      </div>
    </I18nProvider>
  );
};

export default ViewerApp;
