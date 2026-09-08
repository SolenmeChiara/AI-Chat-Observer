// 手机观众模式：电脑端 ↔ 服务端的实时桥
//
// 职责只有两件：
//   1. 把「电脑现在在看哪个会话 / 自动播放开没开 / 谁在生成」上报给服务端（presence），
//      手机端据此决定能不能发消息、显示什么状态条。
//   2. 收服务端转发过来的手机消息（inbox），交给上层的 appendUserMessage 入流。
//
// 铁律：这里绝不触发任何 agent。SSE 回调拿的是「事件到达那一刻」的闭包，
// 在里面调 triggerAgentReply 会读到旧的 messages 快照（App.tsx:2908-2915 记过同样的坑）。
// 手机消息只是把一条 Message 塞进 state，之后由 autoplay effect 用新渲染的闭包自然接话。
//
// 任何网络失败都只 console.warn，绝不往上抛——服务端没升级 / 没开局域网时
// 这些接口全是 404，主界面必须照常能用。
import { useEffect, useRef } from 'react';
import { type ActionEvent, type ActionResult, type ActionType } from '../server/actionContract';

export type { ActionEvent, ActionResult, ActionType };

/** POST /api/live/presence 的 body（契约见 PHONE_VIEWER_PLAN §3.2） */
export interface PresenceReport {
  activeGroupId: string;
  activeSessionId: string;
  isAutoPlay: boolean;
  processingAgentIds: string[];
}

/** SSE `inbox` 事件的 data（只推给 role=desktop 的连接） */
export interface InboxEvent {
  id: string;
  sessionId: string;
  text: string;
  receivedAt: number;
}

/**
 * SSE `control` 事件的 data（只推给 role=desktop 的连接）。
 * 手机端遥控自动播放开关；服务端只转发，真正的状态翻转由电脑端执行后经 presence 回流确认。
 */
export interface ControlEvent {
  id: string;
  action: 'autoplay';
  enabled: boolean;
  sessionId: string;
  receivedAt: number;
}

const ACTION_RESULT_URL = '/api/live/action-result';

/**
 * 回传一次动作执行结果。**永不抛**：服务端没升级 / 断网时只 warn，
 * 手机那头会在 8s 超时后自己显示失败，比让 App 的分发表炸掉强。
 */
export async function postActionResult(result: ActionResult): Promise<void> {
  try {
    const res = await fetch(ACTION_RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    });
    if (!res.ok) console.warn('[live] action-result 被拒绝', res.status, result.id);
  } catch (err) {
    console.warn('[live] action-result 回传失败', err);
  }
}

export interface UseLiveBridgeOptions {
  /** 只有本地文件存储模式才有服务端可言；legacy(IndexedDB) 下整个桥不启动 */
  enabled: boolean;
  /** 当前 presence 快照，变化后 200ms 防抖上报 */
  report: PresenceReport;
  /** 收到手机消息时回调（内部会用 ref 存最新的一份，不怕旧闭包） */
  onInbox: (msg: InboxEvent) => void;
  /** 收到手机遥控指令时回调（同样走 ref，不怕旧闭包） */
  onControl?: (cmd: ControlEvent) => void;
  /**
   * 收到手机远程动作时回调（同样走 ref）。回调**必须自己**用 postActionResult 回一次结果，
   * 成功失败都要回——手机那头在等，不回就只能等 8s 超时。
   */
  onAction?: (evt: ActionEvent) => void;
}

const EVENTS_URL = '/api/live/events?role=desktop';
const PRESENCE_URL = '/api/live/presence';
const PRESENCE_DEBOUNCE_MS = 200;
// 服务端没升级时 EventSource 会每隔几秒重连一次，warn 会刷屏。
// 同一类失败最多 30s 报一次，够看见问题又不至于淹掉控制台。
const WARN_THROTTLE_MS = 30_000;
// EventSource 收到非 200 响应会永久放弃（不像网络中断那样自动重连），
// 得自己兜一层慢速重试，否则服务端晚一步就绪就再也连不上了。
const RECONNECT_DELAY_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 10;

/** 上报用的指纹：只有内容真变了才值得发一次 POST */
const reportKey = (r: PresenceReport): string =>
  JSON.stringify([r.activeGroupId, r.activeSessionId, r.isAutoPlay, [...r.processingAgentIds].sort()]);

export function useLiveBridge({ enabled, report, onInbox, onControl, onAction }: UseLiveBridgeOptions): void {
  const reportRef = useRef(report);
  const onInboxRef = useRef(onInbox);
  const onControlRef = useRef(onControl);
  const onActionRef = useRef(onAction);
  // 已经上报过的指纹：SSE open 时会立刻发一次，防抖 effect 拿它去重
  const sentKeyRef = useRef<string | null>(null);
  // 各类 warn 上次打印的时间戳，用于节流
  const warnedAtRef = useRef<Record<string, number>>({});

  reportRef.current = report;
  onInboxRef.current = onInbox;
  onControlRef.current = onControl;
  onActionRef.current = onAction;

  // 节流版 console.warn：同一个 tag 30s 内只出一次
  const warn = useRef((tag: string, ...args: unknown[]) => {
    const now = Date.now();
    if (now - (warnedAtRef.current[tag] || 0) < WARN_THROTTLE_MS) return;
    warnedAtRef.current[tag] = now;
    console.warn(`[live] ${tag}`, ...args);
  }).current;

  const postPresence = useRef(async (payload: PresenceReport) => {
    try {
      const res = await fetch(PRESENCE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        warn('presence 上报被拒绝', res.status);
        return;
      }
      sentKeyRef.current = reportKey(payload);
    } catch (err) {
      warn('presence 上报失败（服务端可能未升级）', err);
    }
  }).current;

  // --- SSE 连接：只在 enabled 切换时开合，report 变化不重连 ---
  useEffect(() => {
    if (!enabled) return;
    if (typeof EventSource === 'undefined') {
      console.warn('[live] 当前环境没有 EventSource，手机观众模式不可用');
      return;
    }

    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer = 0;
    let attempts = 0;

    const connect = () => {
      if (disposed) return;
      try {
        es = new EventSource(EVENTS_URL);
      } catch (err) {
        console.warn('[live] 无法建立 SSE 连接', err);
        return;
      }

      es.addEventListener('open', () => {
        attempts = 0; // 连上了，重连预算归零
        // 断线重连后服务端那份 presence 可能已经过期，每次连上都补一发
        void postPresence(reportRef.current);
      });

      es.addEventListener('inbox', ((ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as Partial<InboxEvent>;
          if (!data || typeof data.id !== 'string' || typeof data.sessionId !== 'string' || typeof data.text !== 'string') {
            warn('inbox 事件字段不完整，已忽略', ev.data);
            return;
          }
          onInboxRef.current({
            id: data.id,
            sessionId: data.sessionId,
            text: data.text,
            receivedAt: typeof data.receivedAt === 'number' ? data.receivedAt : Date.now(),
          });
        } catch (err) {
          warn('inbox 事件解析失败', err);
        }
      }) as EventListener);

      es.addEventListener('control', ((ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as Partial<ControlEvent>;
          if (
            !data ||
            typeof data.id !== 'string' ||
            data.action !== 'autoplay' ||
            typeof data.enabled !== 'boolean' ||
            typeof data.sessionId !== 'string'
          ) {
            warn('control 事件字段不完整，已忽略', ev.data);
            return;
          }
          onControlRef.current?.({
            id: data.id,
            action: 'autoplay',
            enabled: data.enabled,
            sessionId: data.sessionId,
            receivedAt: typeof data.receivedAt === 'number' ? data.receivedAt : Date.now(),
          });
        } catch (err) {
          warn('control 事件解析失败', err);
        }
      }) as EventListener);

      es.addEventListener('action', ((ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as Partial<ActionEvent>;
          // 逐字段校验：SSE 那头是服务端，但解析出来的仍然是一段外来 JSON，
          // 形状不对就丢掉，绝不让它带着 undefined 走进 App 的分发表。
          //
          // **刻意不查 ACTION_TYPES**：这里丢掉的事件是不回执的，手机只能干等 8 秒
          // 超时。电脑页比服务端旧（浏览器缓存了老 bundle）时，服务端认得的新 type
          // 在这张表里查不到，一整类动作就变成「电脑端没有回应」，看不出是版本不齐。
          // 认不认识这个 type 交给 App.tsx 的 handleActionEvent，它的 default 分支
          // 会回 `unknown-action`，手机上直接显示「电脑端不认识这个动作，可能是旧版本」。
          if (
            !data ||
            typeof data.id !== 'string' ||
            !data.id ||
            typeof data.type !== 'string' ||
            !data.type ||
            !data.payload ||
            typeof data.payload !== 'object' ||
            Array.isArray(data.payload) ||
            (data.sessionId !== undefined && typeof data.sessionId !== 'string')
          ) {
            warn('action 事件字段不完整，已忽略', ev.data);
            return;
          }
          onActionRef.current?.({
            id: data.id,
            type: data.type as ActionType,
            sessionId: data.sessionId,
            payload: data.payload as ActionEvent['payload'],
            receivedAt: typeof data.receivedAt === 'number' ? data.receivedAt : Date.now(),
          });
        } catch (err) {
          warn('action 事件解析失败', err);
        }
      }) as EventListener);

      es.addEventListener('error', () => {
        if (disposed || !es) return;
        // readyState=CONNECTING：浏览器自己会重连，交给它就行。
        // CLOSED：收到了非 200 响应（比如服务端还没升级，/api/live/events 是 404），
        // 按规范 EventSource 就此永久放弃——不自己补一手的话，之后服务端起来了
        // 手机消息也永远进不来。所以有限次数地慢速重试。
        if (es.readyState !== EventSource.CLOSED) {
          warn('SSE 连接中断，等待自动重连');
          return;
        }
        es.close();
        es = null;
        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
          warn(`SSE 连接已关闭，重试 ${MAX_RECONNECT_ATTEMPTS} 次仍失败，放弃（刷新页面可重来）`);
          return;
        }
        attempts += 1;
        warn('SSE 连接已关闭，稍后重试');
        retryTimer = window.setTimeout(connect, RECONNECT_DELAY_MS);
      });
    };

    connect();

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      es?.close();
      es = null;
      sentKeyRef.current = null;
    };
  }, [enabled, postPresence, warn]);

  // --- presence 防抖上报：切会话/开关自动播放/生成中名单变化都会走这里 ---
  const key = enabled ? reportKey(report) : '';
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => {
      if (sentKeyRef.current === key) return; // open 那一发已经覆盖了，别重复
      void postPresence(reportRef.current);
    }, PRESENCE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, key, postPresence]);
}
