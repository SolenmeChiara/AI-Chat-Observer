// 手机观众模式的服务端：/api/live/*（SSE 实时通道、presence、inbox、入口二维码）
// 与 /api/view/*（剥掉敏感字段的只读视图）。契约见 PHONE_VIEWER_PLAN.md §3.2 / §3.3。
//
// 设计要点：
// - **会话文件唯一写者是电脑端**。本模块一个字节都不往 data/ 里写（lan-token.txt 由 http.ts
//   在启动时落盘，不在请求路径上）。手机的消息经 SSE 转给电脑端，由电脑端走正常保存路径。
// - 敏感数据靠白名单而不是黑名单出门：agents 只出 id/name/avatar/role，providers 根本没有
//   任何 /api/view 路径能碰到。加字段时**必须**手工加进白名单，漏加只会少显示，不会泄漏。
// - 会话索引首次请求时建一次（解析 data/sessions/*.json），之后由 PUT/DELETE 钩子增量更新。
// - 完整会话只缓存 3 个（内联 base64 附件让单个会话可以有几十 MB）。
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SESSION_ID_RE,
  SMALL_BODY_BYTES,
  getDataDir,
  getLanToken,
  isJsonRequest,
  isLanEnabled,
  isLoopbackHostname,
  isTailscaleIPv4,
  localIPv4Addresses,
  portFromHostHeader,
  readBody,
  readJson,
  sendJson,
  type Role,
} from './http';
import {
  ACTION_ATTACHMENT_MIME_TYPES,
  ACTION_BODY_BYTES_WITH_ATTACHMENTS,
  ACTION_LIMITS,
  ACTION_MAX_PER_WINDOW,
  ACTION_RATE_WINDOW_MS,
  ACTION_TYPES,
  AGENT_PATCH_CONFIG_KEYS,
  AGENT_PATCH_KEYS,
  SESSION_SCOPED_ACTIONS,
  type ActionType,
} from './actionContract';

// --- 常量 ---

/** 单次视图请求最多返回多少条消息。 */
const MAX_VIEW_MESSAGES = 500;
/** 不带 tail/from 时的默认尾部条数。 */
const DEFAULT_TAIL = 200;
/** 完整会话缓存条数。 */
const SESSION_CACHE_SIZE = 3;
/** SSE 保活注释间隔。 */
const SSE_PING_MS = 25_000;
/** desktop 断开后延迟多久才广播 offline（给 EventSource 自动重连留窗口）。 */
const DESKTOP_OFFLINE_GRACE_MS = 5_000;
/** inbox / control 的限速窗口与配额（按连接来源地址，两个端点各自一个桶）。 */
const INBOX_WINDOW_MS = 60_000;
const INBOX_MAX_PER_WINDOW = 20;
/** inbox 文本长度上限。 */
const INBOX_MAX_TEXT = 4000;
/** 淘汰扫描用的窗口：取所有限速窗口里最长的那个，短窗口的桶多留一会儿不影响判定。 */
const RATE_SWEEP_WINDOW_MS = Math.max(INBOX_WINDOW_MS, ACTION_RATE_WINDOW_MS);
/** action-result 里 error 短码的长度上限（机器可读短码，不是给人看的文案）。 */
const ACTION_ERROR_MAX = 200;
/** action-result 的 data 只允许这几个 id 类字段，别的一律 400。 */
const ACTION_RESULT_DATA_KEYS = ['agentId', 'messageId', 'sessionId', 'groupId'];

const serverStartedAt = Date.now();

// --- 类型 ---
//
// 下面这几个形状是 ../types.ts 里 Attachment / Message / ChatSession / Agent / ChatGroup 的
// **结构子集**，故意手抄而不是 `import type`：types.ts 会顺着 services/capabilities 把整个前端
// 模块图拖进 tsconfig.node.json 的编译单元（composite 工程要求所有文件都在 include 里）。
// 服务端只碰这几个字段，其余原样透传，所以用索引签名兜底。改前端字段名时这里要跟着改。

/** ../types.ts 的 Attachment（磁盘上的完整形态，含 base64 与解析出的文本）。 */
interface StoredAttachment {
  type: 'image' | 'document';
  content: string;
  mimeType: string;
  fileName?: string;
  textContent?: string;
  visionDescription?: string;
}

/** 出门给手机的附件形态：图片的 base64 换成 URL，文档只留壳。 */
interface ViewAttachment {
  type: 'image' | 'document';
  content: string;
  mimeType: string;
  fileName?: string;
}

/** ../types.ts 的 Message。除下面几个字段外原样透传（isStreaming / reasoningText / …）。 */
interface StoredMessage {
  id: string;
  reasoningSignature?: string;
  attachments?: StoredAttachment[];
  [key: string]: unknown;
}

/** ../types.ts 的 ChatSession（只列服务端用得上的字段）。 */
interface StoredSession {
  id?: string;
  groupId?: string;
  name?: string;
  lastUpdated?: number;
  messages: StoredMessage[];
  /** ../types.ts 的 MuteInfo[]：{ agentId, muteUntil, mutedBy }。没有敏感字段，原样出门。 */
  mutedAgents?: unknown[];
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

interface SessionIndexEntry {
  id: string;
  groupId: string;
  name: string;
  lastUpdated: number;
  messageCount: number;
}

interface SseClient {
  id: number;
  res: ServerResponse;
  role: Role;
  isDesktop: boolean;
  ping: ReturnType<typeof setInterval>;
}

type LanEntryKind = 'tailscale' | 'tailscale-serve' | 'lan';

interface LanEntry {
  kind: LanEntryKind;
  url: string;
  qrSvg: string;
  note?: string;
}

// --- 模块级状态 ---

let presenceReport: PresenceReport = {
  activeGroupId: '',
  activeSessionId: '',
  isAutoPlay: false,
  processingAgentIds: [],
};
let presenceUpdatedAt = 0;

const clients = new Set<SseClient>();
let nextClientId = 1;
/** 已经广播出去的 desktopOnline 值（带 5s 宽限，不等于实时连接数）。 */
let desktopAnnounced = false;
let desktopOfflineTimer: ReturnType<typeof setTimeout> | null = null;

/** id → 索引条目。null = 还没建过。 */
let sessionIndex: Map<string, SessionIndexEntry> | null = null;
/** 建索引的单飞句柄：并发的首个请求只扫一遍磁盘。 */
let sessionIndexPromise: Promise<Map<string, SessionIndexEntry>> | null = null;

/** 完整会话 LRU（Map 的插入序即访问序，取的时候 delete+set 移到队尾）。 */
const sessionCache = new Map<string, StoredSession>();

/** 限速桶：`<端点>:<来源地址>` → 最近一分钟内的命中时间戳。inbox 与 control 用不同前缀，各限各的。 */
const rateHits = new Map<string, number[]>();

/** 实际监听端口。Host 头里没带端口时用它兜底（拼入口 URL 用）。 */
let serverPort = 5173;

export function setServerPort(port: number): void {
  if (Number.isFinite(port) && port > 0) serverPort = port;
}

/**
 * 实际监听的绑定地址（`httpServer.address().address`）。空串 = 还没拿到，按「不是只绑回环」处理。
 * `npm run dev:tsserve` 会绑 `127.0.0.1`，这时候只有 `tailscale serve` 反代能进来，
 * 直连类入口（tailscale 100.x / 局域网 IP）扫了也打不开，得从 lan-info 里摘掉。
 */
let serverBindAddress = '';

export function setServerBindAddress(addr: string): void {
  if (typeof addr === 'string') serverBindAddress = addr;
}

/** 监听地址是不是回环（只有本机 + 反代能进）。拿不到地址时按 false 处理，行为与改动前一致。 */
export function isBindLoopbackOnly(): boolean {
  return !!serverBindAddress && isLoopbackHostname(serverBindAddress);
}

// --- SSE ---

function writeEvent(client: SseClient, event: string, data: unknown): void {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    // 对端已经断了但 close 还没触发，忽略；close 回调会把它清掉
  }
}

function broadcast(event: string, data: unknown, only?: (c: SseClient) => boolean): void {
  // 用 forEach 而不是 for...of：tsconfig.node.json 没设 target，默认 ES5 下 Set 的迭代
  // 要 downlevelIteration 才让过。运行时是 Node 22，两种写法等价。
  clients.forEach((client) => {
    if (only && !only(client)) return;
    writeEvent(client, event, data);
  });
}

function presenceState(): PresenceState {
  return { ...presenceReport, desktopOnline: desktopAnnounced, updatedAt: presenceUpdatedAt };
}

function countDesktop(): number {
  let n = 0;
  clients.forEach((c) => {
    if (c.isDesktop) n++;
  });
  return n;
}

function onDesktopConnected(): void {
  if (desktopOfflineTimer) {
    clearTimeout(desktopOfflineTimer);
    desktopOfflineTimer = null;
  }
  if (desktopAnnounced) return;
  desktopAnnounced = true;
  broadcast('presence', presenceState());
}

function onDesktopDisconnected(): void {
  if (countDesktop() > 0 || !desktopAnnounced) return;
  if (desktopOfflineTimer) clearTimeout(desktopOfflineTimer);
  // 延迟 5s：EventSource 断线后自己会重连，页面刷新那一两秒不该让手机看到「电脑离线」闪一下
  desktopOfflineTimer = setTimeout(() => {
    desktopOfflineTimer = null;
    if (countDesktop() > 0) return;
    desktopAnnounced = false;
    broadcast('presence', presenceState());
  }, DESKTOP_OFFLINE_GRACE_MS);
  desktopOfflineTimer.unref?.();
}

function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL, role: Role): void {
  // 只有本机页面能自称电脑端；手机传 role=desktop 会被忽略（仍然当普通观众接进来）
  const isDesktop = role === 'loopback' && url.searchParams.get('role') === 'desktop';

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // nginx / 某些代理会缓冲 SSE，这一行让它们别缓冲（本机直连时是空操作）
    'x-accel-buffering': 'no',
  });
  // 立刻把响应头推出去：EventSource 在收到头之前一直是 CONNECTING，前端的 open 回调不会跑
  res.flushHeaders?.();
  res.write(': connected\n\n');

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* close 回调会清理 */
    }
  }, SSE_PING_MS);
  ping.unref?.();

  const client: SseClient = { id: nextClientId++, res, role, isDesktop, ping };
  clients.add(client);

  writeEvent(client, 'hello', { role, presence: presenceState(), serverStartedAt });
  if (isDesktop) onDesktopConnected();

  const cleanup = () => {
    if (!clients.delete(client)) return;
    clearInterval(ping);
    if (isDesktop) onDesktopDisconnected();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  // 长连接活得久，手机走出 WiFi 覆盖这类断法会让 res 异步 emit('error')；
  // stream 的 'error' 没人听就是未捕获异常，会把整个 dev server 带走。收掉即可，close 负责清理。
  res.on('error', cleanup);
  req.on('error', cleanup);
}

// --- presence ---

async function handlePresence(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isJsonRequest(req)) {
    sendJson(res, 400, { error: 'expected content-type: application/json' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, SMALL_BODY_BYTES);
  } catch (err: any) {
    sendJson(res, err?.statusCode === 413 ? 413 : 400, { error: err?.message || 'failed to read request body' });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 400, { error: 'presence body must be an object' });
    return;
  }
  presenceReport = {
    activeGroupId: typeof parsed.activeGroupId === 'string' ? parsed.activeGroupId : '',
    activeSessionId: typeof parsed.activeSessionId === 'string' ? parsed.activeSessionId : '',
    isAutoPlay: !!parsed.isAutoPlay,
    processingAgentIds: Array.isArray(parsed.processingAgentIds)
      ? parsed.processingAgentIds.filter((x: unknown) => typeof x === 'string')
      : [],
  };
  presenceUpdatedAt = Date.now();
  broadcast('presence', presenceState());
  sendJson(res, 200, { ok: true });
}

// --- inbox ---

function rateLimitOk(
  source: string,
  maxPerWindow: number = INBOX_MAX_PER_WINDOW,
  windowMs: number = INBOX_WINDOW_MS
): boolean {
  const now = Date.now();
  // 顺手淘汰：桶只在自己被访问时才清理的话，来过一次就再没回来的地址会永久占着一个 key。
  // 桶数 = 见过的来源地址数（个位数），整表扫一遍的代价可以忽略。
  rateHits.forEach((times, key) => {
    const kept = times.filter((t) => now - t < RATE_SWEEP_WINDOW_MS);
    if (kept.length === 0) rateHits.delete(key);
    else if (kept.length !== times.length) rateHits.set(key, kept);
  });
  const hits = (rateHits.get(source) || []).filter((t) => now - t < windowMs);
  if (hits.length >= maxPerWindow) {
    rateHits.set(source, hits);
    return false;
  }
  hits.push(now);
  rateHits.set(source, hits);
  return true;
}

async function handleInbox(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 只收 application/json：跨源表单 POST 发不出这个 content-type（会触发预检并被 Origin 校验挡下）
  if (!isJsonRequest(req)) {
    sendJson(res, 400, { error: 'expected content-type: application/json' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, SMALL_BODY_BYTES);
  } catch (err: any) {
    sendJson(res, err?.statusCode === 413 ? 413 : 400, { error: err?.message || 'failed to read request body' });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
    return;
  }

  // 校验顺序钉死：400 → 503 → 409 → 429 → 202（手机端按状态码分别提示）
  const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
  const text = typeof parsed?.text === 'string' ? parsed.text : '';
  if (!sessionId || !text.trim() || text.length > INBOX_MAX_TEXT) {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  if (countDesktop() === 0) {
    sendJson(res, 503, { error: 'desktop-offline' });
    return;
  }
  if (sessionId !== presenceReport.activeSessionId) {
    sendJson(res, 409, { error: 'not-active-session' });
    return;
  }
  const source = req.socket?.remoteAddress || 'unknown';
  if (!rateLimitOk(source)) {
    sendJson(res, 429, { error: 'rate-limited' });
    return;
  }

  const id = `inbox-${Date.now()}-${crypto.randomBytes(4).toString('base64url').slice(0, 6)}`;
  const payload = { id, sessionId, text, receivedAt: Date.now() };
  // 不落盘：会话文件只有电脑端一个写者，手机的消息由电脑端吸收后走正常保存路径
  broadcast('inbox', payload, (c) => c.isDesktop);
  sendJson(res, 202, { id });
}

// --- control ---

/**
 * 手机遥控电脑端的自动播放开关。
 *
 * 和 inbox 同一套形状：只做转发，不落盘、**不改 presenceReport**。生效与否由电脑端说了算——
 * 它收到 `control` 事件后自己 setIsAutoPlay / handleStopAll，随后照常上报 presence，
 * 手机端看到 presence 里的 isAutoPlay 翻转才认为遥控成功。这样服务端不会凭空造出一个
 * 和电脑端真实状态不一致的 presence。
 */
async function handleControl(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isJsonRequest(req)) {
    sendJson(res, 400, { error: 'expected content-type: application/json' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, SMALL_BODY_BYTES);
  } catch (err: any) {
    sendJson(res, err?.statusCode === 413 ? 413 : 400, { error: err?.message || 'failed to read request body' });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
    return;
  }

  // 校验顺序钉死，与 inbox 一致：400 → 503 → 409 → 429 → 202
  const action = parsed?.action;
  const enabled = parsed?.enabled;
  const sessionId = typeof parsed?.sessionId === 'string' ? parsed.sessionId : '';
  if (action !== 'autoplay' || typeof enabled !== 'boolean' || !sessionId) {
    sendJson(res, 400, { error: 'bad-request' });
    return;
  }
  if (countDesktop() === 0) {
    sendJson(res, 503, { error: 'desktop-offline' });
    return;
  }
  // 手机看的不是电脑当前会话时不许遥控：否则会在一个人根本没在看的会话上开起自动播放
  if (sessionId !== presenceReport.activeSessionId) {
    sendJson(res, 409, { error: 'not-active-session' });
    return;
  }
  // 和 inbox 分桶：连着发几条消息不该把「暂停」按钮一起堵死
  const source = `control:${req.socket?.remoteAddress || 'unknown'}`;
  if (!rateLimitOk(source)) {
    sendJson(res, 429, { error: 'rate-limited' });
    return;
  }

  const id = `ctl-${Date.now()}-${crypto.randomBytes(4).toString('base64url').slice(0, 6)}`;
  broadcast('control', { id, action: 'autoplay', enabled, sessionId, receivedAt: Date.now() }, (c) => c.isDesktop);
  sendJson(res, 202, { id });
}

// --- action（手机远程动作通道，PHONE_ACTIONS_PLAN §2.2-2.5）---

/**
 * 需要 sessionId 但**不**要求它等于电脑当前会话的动作。
 * `session.switch` 的 sessionId 是「要切到哪」，拿它跟当前会话比会让切换永远 409；
 * 契约里的 SESSION_SCOPED_ACTIONS 只表达「这个 type 必须带 sessionId」，
 * 「必须等于当前会话」那条是 PHONE_ACTIONS_PLAN §2.1 里带例外的规则。
 */
const SESSION_TARGET_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>(['session.switch']);

/** 每个 type 允许出现的 payload 键。白名单之外一律 400，键名进响应体的 field。 */
const ACTION_PAYLOAD_KEYS: Record<ActionType, string[]> = {
  'message.send': ['text', 'pmTargetId', 'replyToId', 'parseCommands', 'attachments'],
  'session.switch': [],
  'group.member.add': ['agentId'],
  'group.member.remove': ['agentId'],
  'agent.mute': ['agentId', 'durationMinutes'],
  'agent.unmute': ['agentId'],
  'agent.trigger': ['agentId'],
  'agent.update': ['agentId', 'patch'],
  'agent.create': ['providerId', 'modelId', 'name', 'systemPrompt', 'joinActiveGroup'],
  'group.create': ['name'],
  'session.create': ['groupId', 'name'],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 必填 id：非空字符串且不超长。空串按缺失处理。 */
function badId(v: unknown): boolean {
  return typeof v !== 'string' || v.length === 0 || v.length > ACTION_LIMITS.id;
}

function badOptionalId(v: unknown): boolean {
  return v !== undefined && badId(v);
}

function badOptionalString(v: unknown, max: number): boolean {
  return v !== undefined && (typeof v !== 'string' || v.length > max);
}

function badOptionalBool(v: unknown): boolean {
  return v !== undefined && typeof v !== 'boolean';
}

function badOptionalInt(v: unknown, min: number, max: number): boolean {
  return v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max);
}

// --- 图片附件（message.send）---

/** 标准 base64（不是 base64url，也不接受换行/空格）：只有这些字符 + 末尾至多两个 `=`，且总长是 4 的倍数。 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** 从 base64 长度反推解码后字节数，不用真的把几 MB 解出来。调用前先确认它是合法 base64。 */
function base64DecodedBytes(data: string): number {
  let pad = 0;
  if (data.endsWith('==')) pad = 2;
  else if (data.endsWith('=')) pad = 1;
  return (data.length / 4) * 3 - pad;
}

/**
 * 魔数与 mimeType 是否对得上。只解前 12 字节（16 个 base64 字符）就够：
 * WEBP 要看到第 8–11 字节的 'WEBP'，是四种里最长的一条。
 *
 * 为什么要验：手机端是可信的，但 lan 角色不只有我们自己的手机页——
 * 谁拿到 token 都能 POST。mimeType 与内容不符的图会一路存进会话文件，
 * 再被当成 `image/png` 喂给上游视觉模型，是一条不该开的口子。
 */
function magicMatches(mimeType: string, data: string): boolean {
  let head: Buffer;
  try {
    head = Buffer.from(data.slice(0, 16), 'base64');
  } catch {
    return false;
  }
  if (head.length < 12) return false;
  switch (mimeType) {
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'image/png':
      return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
    case 'image/webp':
      return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
    case 'image/gif':
      return head.toString('latin1', 0, 4) === 'GIF8';
    default:
      return false;
  }
}

/**
 * 校验 message.send 的 attachments。返回出错字段名（`attachments` 或 `attachments[i].xxx`），全对返回 null。
 * 与别的校验一样**只做形状**：图片能不能解码、宽高多少，服务端一概不管。
 */
function validateAttachments(value: unknown): string | null {
  if (!Array.isArray(value)) return 'attachments';
  if (value.length > ACTION_LIMITS.attachmentsPerMessage) return 'attachments';
  const allowedMimes = ACTION_ATTACHMENT_MIME_TYPES as ReadonlyArray<string>;
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    const at = (field: string) => `attachments[${i}].${field}`;
    if (!isPlainObject(item)) return `attachments[${i}]`;
    for (const key of Object.keys(item)) {
      if (key !== 'mimeType' && key !== 'data' && key !== 'fileName') return at(key);
    }
    if (typeof item.mimeType !== 'string' || allowedMimes.indexOf(item.mimeType) < 0) return at('mimeType');
    const data = item.data;
    if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !BASE64_RE.test(data)) {
      return at('data');
    }
    if (base64DecodedBytes(data) > ACTION_LIMITS.attachmentBytes) return at('data');
    if (!magicMatches(item.mimeType, data)) return at('data');
    if (badOptionalString(item.fileName, ACTION_LIMITS.fileName)) return at('fileName');
  }
  return null;
}

/**
 * 校验 AgentPatch。白名单之外的键直接判错（尤其 searchConfig / voiceId 这类凭据或私有配置），
 * 返回出错的字段名（`patch.xxx`），全对返回 null。空 patch 合法：是一次没有改动的提交，
 * 电脑端应用后回 ok，不当错误。
 */
function validateAgentPatch(patch: unknown): string | null {
  if (!isPlainObject(patch)) return 'patch';
  const allowed = AGENT_PATCH_KEYS as ReadonlyArray<string>;
  for (const key of Object.keys(patch)) {
    if (allowed.indexOf(key) < 0) return `patch.${key}`;
  }
  if (badOptionalString(patch.name, ACTION_LIMITS.name)) return 'patch.name';
  if (badOptionalString(patch.systemPrompt, ACTION_LIMITS.systemPrompt)) return 'patch.systemPrompt';
  if (badOptionalId(patch.providerId)) return 'patch.providerId';
  if (badOptionalId(patch.modelId)) return 'patch.modelId';
  if (badOptionalString(patch.color, ACTION_LIMITS.color)) return 'patch.color';
  if (badOptionalString(patch.avatar, ACTION_LIMITS.avatar)) return 'patch.avatar';
  if (patch.role !== undefined && patch.role !== 'MEMBER' && patch.role !== 'ADMIN') return 'patch.role';
  if (badOptionalBool(patch.mentionOnly)) return 'patch.mentionOnly';
  if (badOptionalBool(patch.enablePM)) return 'patch.enablePM';
  if (patch.commandMode !== undefined && patch.commandMode !== 'native' && patch.commandMode !== 'text') {
    return 'patch.commandMode';
  }
  if (patch.config !== undefined) {
    const config = patch.config;
    if (!isPlainObject(config)) return 'patch.config';
    const allowedConfig = AGENT_PATCH_CONFIG_KEYS as ReadonlyArray<string>;
    for (const key of Object.keys(config)) {
      if (allowedConfig.indexOf(key) < 0) return `patch.config.${key}`;
    }
    // temperature / topP 允许显式 null：types.ts 里 null = 用供应商默认值
    if (config.temperature !== undefined && config.temperature !== null && typeof config.temperature !== 'number') {
      return 'patch.config.temperature';
    }
    if (config.topP !== undefined && config.topP !== null && typeof config.topP !== 'number') {
      return 'patch.config.topP';
    }
    if (badOptionalInt(config.maxTokens, 1, ACTION_LIMITS.maxTokensMax)) return 'patch.config.maxTokens';
    if (badOptionalBool(config.enableReasoning)) return 'patch.config.enableReasoning';
    if (badOptionalInt(config.reasoningBudget, 0, ACTION_LIMITS.reasoningBudgetMax)) {
      return 'patch.config.reasoningBudget';
    }
  }
  return null;
}

/**
 * 按 type 校验 payload 的形状与长度。**只做形状**：id 存不存在、是不是群成员这类语义
 * 服务端一概不知道（它不读 agents/groups 的内存状态），交给电脑端在执行时判，失败经 action-result 回来。
 */
function validateActionPayload(type: ActionType, payload: Record<string, unknown>): string | null {
  const allowed = ACTION_PAYLOAD_KEYS[type];
  for (const key of Object.keys(payload)) {
    if (allowed.indexOf(key) < 0) return `payload.${key}`;
  }
  switch (type) {
    case 'message.send': {
      // 附件先验：下面「正文能不能是空」要看有没有图
      let attachmentCount = 0;
      if (payload.attachments !== undefined) {
        const bad = validateAttachments(payload.attachments);
        if (bad) return bad;
        attachmentCount = (payload.attachments as unknown[]).length;
      }
      const text = payload.text;
      if (typeof text !== 'string' || text.length > ACTION_LIMITS.text) return 'text';
      // 只发图不说话是合法的；一个字没有又一张图没有才是空消息
      if (!text.trim() && attachmentCount === 0) return 'text';
      if (badOptionalId(payload.pmTargetId)) return 'pmTargetId';
      if (badOptionalId(payload.replyToId)) return 'replyToId';
      if (badOptionalBool(payload.parseCommands)) return 'parseCommands';
      return null;
    }
    case 'session.switch':
      return null;
    case 'group.member.add':
    case 'group.member.remove':
    case 'agent.unmute':
    case 'agent.trigger':
      return badId(payload.agentId) ? 'agentId' : null;
    case 'agent.mute': {
      if (badId(payload.agentId)) return 'agentId';
      const minutes = payload.durationMinutes;
      if (
        typeof minutes !== 'number' ||
        !Number.isInteger(minutes) ||
        minutes < 0 ||
        minutes > ACTION_LIMITS.muteMaxMinutes
      ) {
        return 'durationMinutes';
      }
      return null;
    }
    case 'agent.update': {
      if (badId(payload.agentId)) return 'agentId';
      return validateAgentPatch(payload.patch);
    }
    case 'agent.create': {
      if (badId(payload.providerId)) return 'providerId';
      if (badId(payload.modelId)) return 'modelId';
      if (badOptionalString(payload.name, ACTION_LIMITS.name)) return 'name';
      if (badOptionalString(payload.systemPrompt, ACTION_LIMITS.systemPrompt)) return 'systemPrompt';
      if (badOptionalBool(payload.joinActiveGroup)) return 'joinActiveGroup';
      return null;
    }
    case 'group.create':
      // name 可选。给了空串或全空白不算错：电脑端 trim 完发现是空的就用自己的默认名「群组 N」，
      // 和压根不给这个键是同一条路径。这里只管长度。
      return badOptionalString(payload.name, ACTION_LIMITS.name) ? 'name' : null;
    case 'session.create': {
      // 不是会话级动作：groupId 在 payload 里显式给，服务端只判形状，群存不存在交给电脑端
      if (badId(payload.groupId)) return 'groupId';
      if (badOptionalString(payload.name, ACTION_LIMITS.name)) return 'name';
      return null;
    }
    default:
      return 'type';
  }
}

/**
 * 手机发起的动作。和 inbox / control 同一套形状：**只做转发**，不落盘、不改 presenceReport、
 * 不读 agents/groups。服务端负责白名单 type、payload 形状与长度、作用域（当前会话）与限流；
 * 语义（agent 存不存在、是不是群成员、模型合不合法）全在电脑端，失败经 action-result 回来。
 */
async function handleAction(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isJsonRequest(req)) {
    sendJson(res, 400, { error: 'expected content-type: application/json' });
    return;
  }
  // 带图片的 message.send 可以有二十几 MB（4 张 × 4 MB 解码后，base64 再膨胀 4/3），
  // 所以这里按大上限读；解析出 type / payload 之后再收窄——**放宽只对带附件的
  // message.send 生效**，别的 type、或没有附件的 message.send 超过 64 KB 仍旧 400 body。
  let raw: string;
  try {
    raw = await readBody(req, ACTION_BODY_BYTES_WITH_ATTACHMENTS);
  } catch (err: any) {
    sendJson(res, err?.statusCode === 413 ? 413 : 400, { error: err?.message || 'failed to read request body' });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
    return;
  }

  // 校验顺序钉死，与 inbox / control 一致：400 -> 503 -> 409 -> 429 -> 202
  if (!isPlainObject(parsed)) {
    sendJson(res, 400, { error: 'bad-request', field: 'body' });
    return;
  }
  const type = parsed.type as ActionType;
  if (typeof type !== 'string' || (ACTION_TYPES as ReadonlyArray<string>).indexOf(type) < 0) {
    sendJson(res, 400, { error: 'bad-request', field: 'type' });
    return;
  }
  // payload 缺省当 {}：只有 session.switch 用得上，别的 type 下面的必填校验会自己报错
  const payload = parsed.payload === undefined ? {} : parsed.payload;
  if (!isPlainObject(payload)) {
    sendJson(res, 400, { error: 'bad-request', field: 'payload' });
    return;
  }
  // 收窄：只有真的带了图的 message.send 才允许超过 SMALL_BODY_BYTES。
  // 这里只看「是不是非空数组」，每一项合不合法交给下面的 validateActionPayload
  // （它报的 field 更具体，比笼统的 body 好排查）。
  if (Buffer.byteLength(raw) > SMALL_BODY_BYTES) {
    const atts = payload.attachments;
    if (type !== 'message.send' || !Array.isArray(atts) || atts.length === 0) {
      sendJson(res, 400, { error: 'bad-request', field: 'body' });
      return;
    }
  }
  const scoped = SESSION_SCOPED_ACTIONS.has(type);
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
  if (scoped && (badId(sessionId) || !SESSION_ID_RE.test(sessionId))) {
    sendJson(res, 400, { error: 'bad-request', field: 'sessionId' });
    return;
  }
  const badField = validateActionPayload(type, payload);
  if (badField) {
    sendJson(res, 400, { error: 'bad-request', field: badField });
    return;
  }
  if (countDesktop() === 0) {
    sendJson(res, 503, { error: 'desktop-offline' });
    return;
  }
  // session.switch 的 sessionId 是目标会话，不参与「必须是电脑当前会话」的比对
  if (scoped && !SESSION_TARGET_ACTIONS.has(type) && sessionId !== presenceReport.activeSessionId) {
    sendJson(res, 409, { error: 'not-active-session' });
    return;
  }
  // 独立桶：连发几条消息不该把「让 TA 发言」一起堵死，也不该被 inbox / control 的配额牵连
  const source = `action:${req.socket?.remoteAddress || 'unknown'}`;
  if (!rateLimitOk(source, ACTION_MAX_PER_WINDOW, ACTION_RATE_WINDOW_MS)) {
    sendJson(res, 429, { error: 'rate-limited' });
    return;
  }

  const id = `act-${Date.now()}-${crypto.randomBytes(4).toString('base64url').slice(0, 6)}`;
  const event: Record<string, unknown> = { id, type, payload, receivedAt: Date.now() };
  if (scoped) event.sessionId = sessionId;
  broadcast('action', event, (c) => c.isDesktop);
  sendJson(res, 202, { id });
}

/**
 * 电脑端回传动作执行结果（**只收 loopback**，见 isLoopbackOnlyLivePath）。
 * 局域网角色能发这个的话就能伪造任意动作的「成功」，手机会以为改动生效了。
 * 服务端不解释内容，校验形状后广播给非 desktop 的连接，手机按 id 认领。
 */
async function handleActionResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isJsonRequest(req)) {
    sendJson(res, 400, { error: 'expected content-type: application/json' });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, SMALL_BODY_BYTES);
  } catch (err: any) {
    sendJson(res, err?.statusCode === 413 ? 413 : 400, { error: err?.message || 'failed to read request body' });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
    return;
  }
  if (!isPlainObject(parsed)) {
    sendJson(res, 400, { error: 'bad-request', field: 'body' });
    return;
  }
  if (badId(parsed.id)) {
    sendJson(res, 400, { error: 'bad-request', field: 'id' });
    return;
  }
  if (typeof parsed.ok !== 'boolean') {
    sendJson(res, 400, { error: 'bad-request', field: 'ok' });
    return;
  }
  if (badOptionalString(parsed.error, ACTION_ERROR_MAX)) {
    sendJson(res, 400, { error: 'bad-request', field: 'error' });
    return;
  }
  const out: Record<string, unknown> = { id: parsed.id, ok: parsed.ok };
  if (typeof parsed.error === 'string' && parsed.error) out.error = parsed.error;
  if (parsed.data !== undefined) {
    const data = parsed.data;
    if (!isPlainObject(data)) {
      sendJson(res, 400, { error: 'bad-request', field: 'data' });
      return;
    }
    const projected: Record<string, string> = {};
    for (const key of Object.keys(data)) {
      // 白名单：data 只放 id 类信息，绝不当成一条「什么都能塞」的旁路
      if (ACTION_RESULT_DATA_KEYS.indexOf(key) < 0 || badId(data[key])) {
        sendJson(res, 400, { error: 'bad-request', field: `data.${key}` });
        return;
      }
      projected[key] = data[key] as string;
    }
    if (Object.keys(projected).length > 0) out.data = projected;
  }
  broadcast('action-result', out, (c) => !c.isDesktop);
  sendJson(res, 202, { ok: true });
}

// --- lan-info ---

/** `tailscale status --json` 里我们只关心这一小块。 */
interface TailscaleStatus {
  Self?: { DNSName?: string };
}

const TAILSCALE_CANDIDATES = ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];

/**
 * 取本机的 MagicDNS 名。取不到（没装 / 没登录 / 超时）一律静默返回 null——
 * 这只是一条锦上添花的入口，绝不能让 lan-info 因此失败。
 */
function tailscaleDnsName(): Promise<string | null> {
  return new Promise((resolve) => {
    let index = 0;
    const attempt = () => {
      if (index >= TAILSCALE_CANDIDATES.length) {
        resolve(null);
        return;
      }
      const bin = TAILSCALE_CANDIDATES[index++];
      execFile(bin, ['status', '--json'], { timeout: 2000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) {
          attempt();
          return;
        }
        try {
          const status = JSON.parse(stdout) as TailscaleStatus;
          const dns = (status.Self?.DNSName || '').replace(/\.$/, '');
          resolve(dns || null);
        } catch {
          attempt();
        }
      });
    };
    attempt();
  });
}

async function handleLanInfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // 优先用请求自带的端口（最贴近浏览器实际打开的地址），Host 没写端口时退回监听端口
  const port = portFromHostHeader((req.headers.host || '').toString()) ?? serverPort;
  const token = getLanToken();
  // 只绑了回环时，直连类入口（tailscale 100.x / 局域网 IP）根本连不上，别给出去骗人扫码
  const bindLoopbackOnly = isBindLoopbackOnly();

  if (!isLanEnabled() || !token) {
    sendJson(res, 200, { enabled: false, port, token: null, entries: [], bindLoopbackOnly });
    return;
  }

  const query = `?token=${encodeURIComponent(token)}`;
  // kind 决定排序：Tailscale 是首选通路，普通局域网 IP 垫底
  const drafts: Array<{ kind: LanEntryKind; url: string; note?: string }> = [];

  const dnsName = await tailscaleDnsName();
  const ips = bindLoopbackOnly ? [] : localIPv4Addresses();
  for (const ip of ips) {
    if (isTailscaleIPv4(ip)) drafts.push({ kind: 'tailscale', url: `http://${ip}:${port}/viewer${query}` });
  }
  if (dnsName) {
    drafts.push({
      kind: 'tailscale-serve',
      url: `https://${dnsName}/viewer${query}`,
      note: `需先在电脑上执行：tailscale serve https / http://127.0.0.1:${port}`,
    });
  }
  for (const ip of ips) {
    if (!isTailscaleIPv4(ip)) drafts.push({ kind: 'lan', url: `http://${ip}:${port}/viewer${query}` });
  }

  const order: Record<LanEntryKind, number> = { tailscale: 0, 'tailscale-serve': 1, lan: 2 };
  drafts.sort((a, b) => order[a.kind] - order[b.kind]);

  // 二维码是锦上添花：qrcode 没装 / 载不进来时也要把文字链接给出去，
  // 否则整个「手机观看」面板会因为一个可选依赖而变成 500。
  type QrToString = (text: string, options: { type: 'svg'; margin: number }) => Promise<string>;
  let qrToString: QrToString | null = null;
  try {
    const mod = await import('qrcode');
    qrToString = mod.toString as unknown as QrToString;
  } catch (err: any) {
    console.warn(`[aco-live] 载入 qrcode 失败，只给出文字链接：${err?.message || String(err)}`);
  }
  const entries: LanEntry[] = [];
  for (const draft of drafts) {
    let qrSvg = '';
    if (qrToString) {
      try {
        qrSvg = await qrToString(draft.url, { type: 'svg', margin: 1 });
      } catch (err: any) {
        console.warn(`[aco-live] 生成二维码失败（${draft.url}）：${err?.message || String(err)}`);
      }
    }
    entries.push({ ...draft, qrSvg });
  }

  sendJson(res, 200, { enabled: true, port, token, entries, bindLoopbackOnly });
}

// --- 会话索引 ---

function sessionsDir(): string {
  return path.join(getDataDir(), 'sessions');
}

function sessionPathFor(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

/** 从 parse 好的会话对象抽索引条目；形状不对返回 null。 */
function indexEntryOf(id: string, value: unknown): SessionIndexEntry | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as Partial<StoredSession>;
  if (!Array.isArray(s.messages)) return null;
  return {
    id,
    groupId: typeof s.groupId === 'string' ? s.groupId : '',
    name: typeof s.name === 'string' ? s.name : id,
    lastUpdated: typeof s.lastUpdated === 'number' ? s.lastUpdated : 0,
    messageCount: s.messages.length,
  };
}

async function buildSessionIndex(): Promise<Map<string, SessionIndexEntry>> {
  const map = new Map<string, SessionIndexEntry>();
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir());
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return map;
    throw err;
  }
  const started = Date.now();
  for (const name of names) {
    // 跳过原子写留下的中间文件（正常情况下不该有，崩溃时可能残留）
    if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!SESSION_ID_RE.test(id)) continue;
    const r = await readJson(path.join(sessionsDir(), name));
    // 单个坏文件不能让整个索引失败：跳过它，其余会话照常能看
    if (r.status !== 'ok') continue;
    const entry = indexEntryOf(id, r.value);
    if (entry) map.set(id, entry);
  }
  console.log(`[aco-live] 会话索引已建立：${map.size} 个会话，耗时 ${Date.now() - started}ms`);
  return map;
}

function ensureSessionIndex(): Promise<Map<string, SessionIndexEntry>> {
  if (sessionIndex) return Promise.resolve(sessionIndex);
  if (!sessionIndexPromise) {
    sessionIndexPromise = buildSessionIndex()
      .then((map) => {
        sessionIndex = map;
        return map;
      })
      .catch((err) => {
        // 失败就清掉句柄，下一次请求真的重试
        sessionIndexPromise = null;
        throw err;
      });
  }
  return sessionIndexPromise;
}

// --- 完整会话缓存 ---

function cacheGet(id: string): StoredSession | undefined {
  const hit = sessionCache.get(id);
  if (!hit) return undefined;
  // 移到队尾 = 最近使用
  sessionCache.delete(id);
  sessionCache.set(id, hit);
  return hit;
}

function cacheSet(id: string, session: StoredSession): void {
  if (sessionCache.has(id)) sessionCache.delete(id);
  sessionCache.set(id, session);
  while (sessionCache.size > SESSION_CACHE_SIZE) {
    const oldest = sessionCache.keys().next();
    if (oldest.done) break;
    sessionCache.delete(oldest.value);
  }
}

type LoadResult = { status: 'ok'; session: StoredSession } | { status: 'missing' } | { status: 'error'; error: string };

async function loadSession(id: string): Promise<LoadResult> {
  const cached = cacheGet(id);
  if (cached) return { status: 'ok', session: cached };
  const r = await readJson(sessionPathFor(id));
  if (r.status === 'missing') return { status: 'missing' };
  if (r.status === 'error') return { status: 'error', error: r.error };
  const value = r.value as StoredSession;
  if (!value || typeof value !== 'object' || !Array.isArray(value.messages)) {
    return { status: 'error', error: `会话 ${id} 的文件结构不是 ChatSession` };
  }
  cacheSet(id, value);
  return { status: 'ok', session: value };
}

// --- localdb 的写钩子 ---

/**
 * 会话 PUT 落盘成功后调用（server/localdb.ts 的 handlePut）。
 * `parsed` 就是刚写下去的那个对象，直接复用，避免为了广播再 parse 一遍几十 MB。
 */
export function onSessionWritten(id: string, parsed: unknown): void {
  const entry = indexEntryOf(id, parsed);
  if (!entry) return;
  // 索引还没建过就不动它：建的时候会从磁盘读到这份最新内容
  if (sessionIndex) sessionIndex.set(id, entry);
  // 已在缓存里、或正是电脑端当前会话（手机大概率马上要拉）→ 直接刷新缓存
  if (sessionCache.has(id) || id === presenceReport.activeSessionId) {
    cacheSet(id, parsed as StoredSession);
  }
  broadcast('session', {
    id: entry.id,
    groupId: entry.groupId,
    name: entry.name,
    total: entry.messageCount,
    lastUpdated: entry.lastUpdated,
  });
}

/** agents / groups / settings 三张表要广播 catalog；providers / meta 不广播（前者含 key，后者手机用不上）。 */
const CATALOG_TABLES = ['agents', 'groups', 'settings'];

/**
 * 整表 PUT 落盘成功后调用（server/localdb.ts 的 handlePut）。
 * 手机端的目录数据（成员、角色、供应商下拉）只在 bootstrap 时拉一次，没有这条事件
 * 电脑端改了什么手机永远看不到。广播给**全部**客户端，手机端收到后防抖重拉 bootstrap。
 * 事件里只有表名和时间戳，不带任何内容——内容要经 /api/view/bootstrap 的白名单投影才出门。
 */
export function onTableWritten(table: string): void {
  if (CATALOG_TABLES.indexOf(table) < 0) return;
  broadcast('catalog', { table, at: Date.now() });
}

/** 会话 DELETE 成功后调用。 */
export function onSessionDeleted(id: string): void {
  const prev = sessionIndex?.get(id);
  sessionIndex?.delete(id);
  sessionCache.delete(id);
  broadcast('session', {
    id,
    groupId: prev?.groupId ?? '',
    name: prev?.name ?? '',
    total: 0,
    lastUpdated: Date.now(),
    deleted: true,
  });
}

// --- /api/view/bootstrap ---

/** AgentConfig 里手机能看能改的那几项；visionProxy* / image* / effort 等不出门（挑字段，不是删字段）。 */
function projectAgentConfig(c: any) {
  if (!c || typeof c !== 'object') return undefined;
  return {
    temperature: typeof c.temperature === 'number' ? c.temperature : null,
    topP: typeof c.topP === 'number' ? c.topP : null,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : undefined,
    enableReasoning: !!c.enableReasoning,
    reasoningBudget: typeof c.reasoningBudget === 'number' ? c.reasoningBudget : undefined,
  };
}

/**
 * 白名单投影。一期只出 id/name/avatar/role；PHONE_ACTIONS_PLAN §2.7 有意放宽——
 * 手机要能编辑提示词与模型，新的边界是「凭据永不出机，提示词与配置可以」。
 * 显式不出门：searchConfig（里面是搜索引擎的 apiKey）、voiceId / voiceProviderId、enableGoogleSearch。
 * 写法是「挑字段」不是「删字段」：Agent 将来加字段时漏挑只会少显示，不会泄漏。
 */
function projectAgent(a: any) {
  return {
    id: a?.id,
    name: a?.name,
    avatar: a?.avatar,
    role: a?.role,
    providerId: a?.providerId,
    modelId: a?.modelId,
    systemPrompt: typeof a?.systemPrompt === 'string' ? a.systemPrompt : '',
    color: a?.color,
    config: projectAgentConfig(a?.config),
    mentionOnly: !!a?.mentionOnly,
    enablePM: !!a?.enablePM,
    commandMode: a?.commandMode === 'native' ? 'native' : 'text',
    isActive: a?.isActive !== false,
  };
}

/**
 * 供应商投影：只出下拉框要用的三样 + 模型的 id/name。
 * **不含** apiKey / baseUrl / vertexProject / openaiApiMode 等任何其它字段，价格也不出。
 * 这是 providers.json 唯一一条通向 /api/view 的路径，读完立刻投影，原对象不进任何缓存。
 */
function projectProvider(p: any) {
  return {
    id: p?.id,
    name: p?.name,
    type: p?.type,
    models: Array.isArray(p?.models) ? p.models.map((m: any) => ({ id: m?.id, name: m?.name })) : [],
  };
}

function projectGroup(g: any) {
  return {
    id: g?.id,
    name: g?.name,
    memberIds: Array.isArray(g?.memberIds) ? g.memberIds : [],
    adminIds: Array.isArray(g?.adminIds) ? g.adminIds : [],
    mentionOnlyIds: Array.isArray(g?.mentionOnlyIds) ? g.mentionOnlyIds : [],
    scenario: typeof g?.scenario === 'string' ? g.scenario : '',
  };
}

/** userProfiles 只出 id/name/avatar——persona 是人设，属于「永远不出电脑」的那一类。 */
function projectSettings(s: any) {
  return {
    userProfiles: Array.isArray(s?.userProfiles)
      ? s.userProfiles.map((p: any) => ({ id: p?.id, name: p?.name, avatar: p?.avatar }))
      : [],
    userName: typeof s?.userName === 'string' ? s.userName : 'User',
    userAvatar: typeof s?.userAvatar === 'string' ? s.userAvatar : '',
    expandAllReasoning: !!s?.expandAllReasoning,
    language: s?.language === 'en' ? 'en' : 'zh',
    darkMode: !!s?.darkMode,
  };
}

async function handleBootstrap(res: ServerResponse): Promise<void> {
  const dir = getDataDir();
  const [agentsR, groupsR, settingsR, providersR] = await Promise.all([
    readJson(path.join(dir, 'agents.json')),
    readJson(path.join(dir, 'groups.json')),
    readJson(path.join(dir, 'settings.json')),
    readJson(path.join(dir, 'providers.json')),
  ]);
  for (const r of [agentsR, groupsR, settingsR, providersR]) {
    if (r.status === 'error') {
      sendJson(res, 500, { error: r.error });
      return;
    }
  }

  let index: Map<string, SessionIndexEntry>;
  try {
    index = await ensureSessionIndex();
  } catch (err: any) {
    sendJson(res, 500, { error: `建立会话索引失败：${err?.message || String(err)}` });
    return;
  }

  const agentsRaw = agentsR.status === 'ok' && Array.isArray(agentsR.value) ? (agentsR.value as any[]) : [];
  const groupsRaw = groupsR.status === 'ok' && Array.isArray(groupsR.value) ? (groupsR.value as any[]) : [];
  const settingsRaw = settingsR.status === 'ok' ? settingsR.value : null;
  // providers.json 里是明文 API key。这一行读进来的原始对象只在下一行被 projectProvider
  // 挑成 id/name/type/models 就丢掉，不赋给任何模块级变量、不进缓存。
  const providers =
    providersR.status === 'ok' && Array.isArray(providersR.value)
      ? (providersR.value as any[]).map(projectProvider)
      : [];

  const sessions = Array.from(index.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);

  sendJson(res, 200, {
    agents: agentsRaw.map(projectAgent),
    providers,
    groups: groupsRaw.map(projectGroup),
    sessions,
    settings: projectSettings(settingsRaw),
    presence: presenceState(),
  });
}

// --- /api/view/sessions/:id ---

/** 附件投影：图片的 base64 换成一个 URL，文档只留壳；textContent / visionDescription 一律丢掉。 */
function projectAttachment(
  sessionId: string,
  messageId: string,
  index: number,
  att: StoredAttachment,
  tokenQuery: string
): ViewAttachment {
  const base: ViewAttachment = {
    type: att.type,
    content: '',
    mimeType: att.mimeType,
  };
  if (att.fileName) base.fileName = att.fileName;
  if (att.type === 'image') {
    base.content =
      `/api/view/sessions/${encodeURIComponent(sessionId)}` +
      `/attachments/${encodeURIComponent(messageId)}/${index}${tokenQuery}`;
  }
  return base;
}

/**
 * ViewMessage = Message 去掉 reasoningSignature（对观众无意义、体积不小），
 * 附件按上面的规则剥掉 base64。其余字段（isStreaming / reasoningText / replyToId /
 * pmTargetId / isSystem / isError…）原样保留，手机端直接喂给 ChatBubble。
 *
 * `tokenQuery`：给 lan 角色的图片 URL 追加 `?token=…`。`<img src>` 发不出
 * `Authorization` 头，不带 token 的话手机上每张图都是 403 —— 契约要的是「ChatBubble
 * 的 <img src> 直接可用」，所以只能走 §3.1 允许的另一条 token 通道（query）。
 * loopback 角色不追加，电脑端的 URL 保持干净。
 */
function toViewMessage(sessionId: string, msg: StoredMessage, tokenQuery: string): StoredMessage {
  const { reasoningSignature, attachments, ...rest } = msg;
  const out: StoredMessage = { ...rest };
  if (Array.isArray(attachments)) {
    out.attachments = attachments.map((att, i) => projectAttachment(sessionId, msg.id, i, att, tokenQuery));
  }
  return out;
}

/** lan 角色要在附件 URL 上带 token；loopback 不需要。 */
function attachmentTokenQuery(role: Role): string {
  if (role !== 'lan') return '';
  const token = getLanToken();
  return token ? `?token=${encodeURIComponent(token)}` : '';
}

function clampInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function handleViewSession(res: ServerResponse, id: string, url: URL, role: Role): Promise<void> {
  const loaded = await loadSession(id);
  if (loaded.status === 'missing') {
    sendJson(res, 404, { error: `session ${id} not found` });
    return;
  }
  if (loaded.status === 'error') {
    sendJson(res, 500, { error: loaded.error });
    return;
  }
  const session = loaded.session;
  const total = session.messages.length;

  const tailParam = url.searchParams.get('tail');
  const fromParam = url.searchParams.get('from');

  let from: number;
  let to: number;
  if (fromParam !== null) {
    from = Math.min(Math.max(0, clampInt(fromParam, 0)), total);
    to = Math.min(Math.max(from, clampInt(url.searchParams.get('to'), total)), total);
    if (to - from > MAX_VIEW_MESSAGES) to = from + MAX_VIEW_MESSAGES;
  } else {
    const n = Math.min(Math.max(1, clampInt(tailParam, DEFAULT_TAIL)), MAX_VIEW_MESSAGES);
    from = Math.max(0, total - n);
    to = total;
  }

  const tokenQuery = attachmentTokenQuery(role);
  sendJson(res, 200, {
    id: session.id ?? id,
    groupId: session.groupId ?? '',
    name: session.name ?? id,
    lastUpdated: session.lastUpdated ?? 0,
    total,
    from,
    // 手机的成员面板要显示「禁言中 / 还剩多久」，这是唯一的来源（禁言是会话级的，不在 bootstrap 里）
    mutedAgents: Array.isArray(session.mutedAgents) ? session.mutedAgents : [],
    messages: session.messages.slice(from, to).map((m) => toViewMessage(id, m, tokenQuery)),
  });
}

// --- /api/view/sessions/:id/attachments/:messageId/:index ---

/** `data:image/png;base64,xxxx` 与裸 base64 都要能吃。 */
function decodeBase64Content(content: string): Buffer | null {
  if (!content) return null;
  const comma = content.startsWith('data:') ? content.indexOf(',') : -1;
  const raw = comma >= 0 ? content.slice(comma + 1) : content;
  try {
    const buf = Buffer.from(raw, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

async function handleAttachment(
  res: ServerResponse,
  id: string,
  messageId: string,
  indexRaw: string
): Promise<void> {
  const index = Number.parseInt(indexRaw, 10);
  if (!Number.isInteger(index) || index < 0) {
    sendJson(res, 404, { error: 'attachment not found' });
    return;
  }
  const loaded = await loadSession(id);
  if (loaded.status === 'missing') {
    sendJson(res, 404, { error: `session ${id} not found` });
    return;
  }
  if (loaded.status === 'error') {
    sendJson(res, 500, { error: loaded.error });
    return;
  }
  const msg = loaded.session.messages.find((m) => m.id === messageId);
  const att = msg?.attachments?.[index];
  // 非图片一律 404：文档的 textContent 是模型读过的原文，不该有出门的路径
  if (!att || att.type !== 'image') {
    sendJson(res, 404, { error: 'attachment not found' });
    return;
  }
  const buf = decodeBase64Content(att.content);
  if (!buf) {
    sendJson(res, 404, { error: 'attachment not decodable' });
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-type', att.mimeType || 'application/octet-stream');
  res.setHeader('content-length', String(buf.length));
  // 消息 id 固定则内容固定，可以放心让手机浏览器缓存一天；private 挡住中间代理
  res.setHeader('cache-control', 'private, max-age=86400');
  // 字节是用户当初拖进来的任意文件，mimeType 也是文件自带的，不让浏览器再自己嗅探一遍
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(buf);
}

// --- 路由 ---

/** 这些路径只给 loopback（电脑端本机页面）。其余 live/view 路径 loopback 与 lan 都可以。 */
export function isLoopbackOnlyLivePath(pathname: string): boolean {
  return (
    pathname === '/api/live/lan-info' ||
    pathname === '/api/live/presence' ||
    // action-result 是电脑端自己的回传通道：局域网角色能发它就能伪造任意动作的「执行成功」
    pathname === '/api/live/action-result'
  );
}

/** 本模块是否认领这个路径。 */
export function isLivePath(pathname: string): boolean {
  return pathname.startsWith('/api/live/') || pathname.startsWith('/api/view/');
}

/**
 * 处理 /api/live/* 与 /api/view/*。调用方保证 role 已经过授权矩阵校验。
 * 返回的 promise resolve 即视为已响应（SSE 例外：响应会一直开着）。
 */
export async function handleLiveRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  role: Role
): Promise<void> {
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  if (pathname === '/api/live/lan-info') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleLanInfo(req, res);
    return;
  }

  if (pathname === '/api/live/presence') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handlePresence(req, res);
    return;
  }

  if (pathname === '/api/live/events') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    handleEvents(req, res, url, role);
    return;
  }

  if (pathname === '/api/live/inbox') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleInbox(req, res);
    return;
  }

  if (pathname === '/api/live/control') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleControl(req, res);
    return;
  }

  if (pathname === '/api/live/action') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleAction(req, res);
    return;
  }

  if (pathname === '/api/live/action-result') {
    if (method !== 'POST') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleActionResult(req, res);
    return;
  }

  if (pathname === '/api/view/bootstrap') {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    await handleBootstrap(res);
    return;
  }

  if (pathname.startsWith('/api/view/sessions/')) {
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method ${method} not allowed on ${pathname}` });
      return;
    }
    // 形如 <id> 或 <id>/attachments/<messageId>/<index>
    const rest = pathname.slice('/api/view/sessions/'.length).split('/');
    const id = safeDecode(rest[0]);
    if (!SESSION_ID_RE.test(id)) {
      sendJson(res, 400, { error: 'invalid session id' });
      return;
    }
    if (rest.length === 1) {
      await handleViewSession(res, id, url, role);
      return;
    }
    if (rest.length === 4 && rest[1] === 'attachments') {
      await handleAttachment(res, id, safeDecode(rest[2]), rest[3]);
      return;
    }
    sendJson(res, 404, { error: `unknown endpoint: ${pathname}` });
    return;
  }

  sendJson(res, 404, { error: `unknown endpoint: ${pathname}` });
}

/** 路径段解码；坏的百分号编码不抛，原样返回（后面的正则/查找会把它挡掉）。 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
