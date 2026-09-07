
import Dexie, { Table } from 'dexie';
import { Agent, ApiProvider, ChatSession, ChatGroup, GlobalSettings } from '../types';
import { INITIAL_AGENTS, INITIAL_PROVIDERS, INITIAL_SESSIONS, INITIAL_GROUPS, DEFAULT_SETTINGS } from '../constants';

// 存储后端有两套：
//   file   —— 走 /api/db/*，数据落在 <repo>/data/ 的 JSON 文件里（server/localdb.ts）
//   legacy —— 原来的 Dexie/IndexedDB 实现，一行没删，探测不到 /api/db 时原样回退
// 对外的四个函数签名不变，App.tsx 不用关心当前在哪套后端上。

class AIObserverDB extends Dexie {
  agents!: Table<Agent>;
  providers!: Table<ApiProvider>;
  sessions!: Table<ChatSession>;
  groups!: Table<ChatGroup>;
  settings!: Table<any>; // Using 'any' to wrap GlobalSettings with an ID

  constructor() {
    super('AIObserverDB');

    // Version 1: Original schema
    (this as any).version(1).stores({
      agents: 'id',
      providers: 'id',
      sessions: 'id',
      settings: 'id'
    });

    // Version 2: Add groups table and migrate existing sessions
    (this as any).version(2).stores({
      agents: 'id',
      providers: 'id',
      sessions: 'id',
      groups: 'id',
      settings: 'id'
    }).upgrade(async (tx: any) => {
      // 迁移：为每个现有session创建一个同名group
      const sessions = await tx.table('sessions').toArray();
      const agents = await tx.table('agents').toArray();
      const activeAgentIds = agents.filter((a: Agent) => a.isActive !== false).map((a: Agent) => a.id);

      for (const session of sessions) {
        if (!session.groupId) {
          const groupId = `group-${session.id}`;
          // 创建群组
          await tx.table('groups').add({
            id: groupId,
            name: session.name || 'Unnamed Group',
            memberIds: session.memberIds || activeAgentIds,
            scenario: session.scenario || '',
            memoryConfig: session.memoryConfig || {
              enabled: false,
              threshold: 20,
              keepRecent: 5,
              excludePM: true,
              summaryModelId: '',
              summaryProviderId: ''
            },
            createdAt: session.lastUpdated || Date.now()
          });
          // 更新session的groupId
          await tx.table('sessions').update(session.id, {
            groupId: groupId,
            name: '对话 1'
          });
        }
      }
    });
  }
}

const db = new AIObserverDB();

db.on('blocked', () => {
  console.warn('Database upgrade blocked — another tab is holding an older connection. Close other tabs and retry.');
});

// ============================================================================
// 公共类型
// ============================================================================

export type StorageMode = 'file' | 'legacy' | 'unknown';

export const SNAPSHOT_SCHEMA_VERSION = 1;

/** JSON 全量备份的格式，导出/导入两头共用。 */
export interface DbSnapshot {
  schemaVersion: number;
  exportedAt: string;
  agents: Agent[];
  providers: ApiProvider[];
  groups: ChatGroup[];
  sessions: ChatSession[];
  settings: GlobalSettings;
}

type CollectionName = 'agents' | 'providers' | 'sessions' | 'groups';

interface DbAllResponse {
  meta: { schemaVersion: number; migratedFrom: string; migratedAt: string } | null;
  agents: Agent[] | null;
  providers: ApiProvider[] | null;
  groups: ChatGroup[] | null;
  settings: GlobalSettings | null;
  sessions: ChatSession[] | null;
  missing: string[];
}

// ============================================================================
// 后端探测
// ============================================================================

const API_BASE = '/api/db';

let mode: StorageMode = 'unknown';
/** 探测时拿到的 /api/db/all，loadAllData 直接复用，不重复请求。 */
let bootSnapshot: DbAllResponse | null = null;

export const getStorageMode = (): StorageMode => mode;

let probePromise: Promise<void> | null = null;

function probeBackend(): Promise<void> {
  if (mode !== 'unknown') return Promise.resolve();
  // 同一 tick 里可能有好几个调用者同时进来（App 的几个保存 effect），只探一次
  if (!probePromise) {
    probePromise = doProbe().catch((err) => {
      probePromise = null;
      throw err;
    });
  }
  return probePromise;
}

async function doProbe(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/all`, { headers: { accept: 'application/json' } });
  } catch (err) {
    // 连不上 = 没有中间件（比如 dist 被别的静态服务器托管），回退 IndexedDB
    mode = 'legacy';
    console.warn('[db] /api/db 不可达，回退 IndexedDB：', err);
    return;
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // 没挂插件的托管方式会给回 404 页或 SPA 的 index.html，都是 HTML
    mode = 'legacy';
    console.warn(`[db] /api/db/all 返回 ${res.status} (${contentType || '无 content-type'})，回退 IndexedDB`);
    return;
  }

  // 能回 JSON 就说明对面确实是 localdb 插件。从这里往后任何失败都是真·读失败，
  // 必须抛出去走错误页——静默回退到默认值等于拿种子数据覆盖用户磁盘上的真实数据。
  mode = 'file';
  installFlushHooks();

  const payload = await res.json();
  if (!res.ok) {
    throw new Error(payload?.error || `读取 data/ 失败：HTTP ${res.status}`);
  }
  bootSnapshot = payload as DbAllResponse;
}

/**
 * 保存路径专用：mode 还没定就先探一次，只决定后端方向，不做搬家/播种。
 *
 * 为什么需要：vite HMR 更新 App.tsx 时会把 db.ts 换成一个全新的模块实例，
 * 模块级的 mode 归零，而 App 的 isDbLoaded 是活的 state，保存 effect 会立刻打进来 ——
 * 此时 initDB 不会再被调用。没有这一步，HMR 之后所有保存都会静默丢掉。
 */
async function ensureBackend(): Promise<void> {
  if (mode !== 'unknown') return;
  try {
    await probeBackend();
  } catch (err) {
    // 探测时读到 500（data/ 里有坏文件）。此时 mode 已经是 'file'，写照常进行；
    // 真正的错误处理留给下一次页面加载走 initDB 的错误页。
    console.error('[db] 后端探测报错（data/ 可能有损坏文件）：', err);
  }
}

// ============================================================================
// 写调度器（file 模式内部使用，对 App.tsx 透明）
// ============================================================================

const DEBOUNCE_MS = 300;
const MAX_WAIT_MS = 2000;
/** keepalive 请求的体积上限（浏览器普遍是 64KB），超了就退回普通 fetch。 */
const KEEPALIVE_MAX_BYTES = 60 * 1024;

interface PendingWrite {
  key: string;
  url: string;
  method: 'PUT' | 'DELETE';
  payload: unknown;
  timer: ReturnType<typeof setTimeout> | null;
  /** 这一批合并的第一次入队时间，用于 maxWait 封顶 */
  firstQueuedAt: number;
  /** 写成功后的登记回调，参数是真正发出去的那份 payload */
  onSuccess?: (payload: unknown) => void;
}

/** key → 待发送的写。同 key 反复调度只覆盖 payload，不排队。 */
const pendingWrites = new Map<string, PendingWrite>();
/** key → 已发出的写的队尾。同 key 串行，跨 key 并行。 */
const inflightWrites = new Map<string, Promise<void>>();

function scheduleWrite(
  key: string,
  url: string,
  method: 'PUT' | 'DELETE',
  payload: unknown,
  onSuccess?: (payload: unknown) => void
): void {
  const now = Date.now();
  let entry = pendingWrites.get(key);
  if (!entry) {
    entry = { key, url, method, payload, timer: null, firstQueuedAt: now, onSuccess };
    pendingWrites.set(key, entry);
  } else {
    // 已经在等的同 key 写：直接覆盖成最新内容，firstQueuedAt 不动（maxWait 才有意义）
    entry.url = url;
    entry.method = method;
    entry.payload = payload;
    entry.onSuccess = onSuccess;
    if (entry.timer !== null) clearTimeout(entry.timer);
  }
  // trailing 300ms 合并；但距第一次入队超过 maxWait 就立刻发，
  // 否则流式输出期间的高频更新会把定时器一直往后推，几分钟都不落盘。
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, entry.firstQueuedAt + MAX_WAIT_MS - now));
  entry.timer = setTimeout(() => {
    const e = pendingWrites.get(key);
    if (e) e.timer = null;
    void firePending(key, false);
  }, wait);
}

function utf8ByteLength(text: string): number {
  try {
    return new TextEncoder().encode(text).byteLength;
  } catch {
    return text.length * 3; // 没有 TextEncoder 就按最坏情况估，宁可不走 keepalive
  }
}

async function sendWrite(entry: PendingWrite, urgent: boolean): Promise<void> {
  try {
    const init: RequestInit = { method: entry.method };
    if (entry.method === 'PUT') {
      const body = JSON.stringify(entry.payload);
      init.headers = { 'content-type': 'application/json' };
      init.body = body;
      // 页面正在隐藏/卸载：小体积用 keepalive 保证请求发得出去，
      // 大体积（内联图片的 session 动辄几 MB）超过浏览器 keepalive 配额，只能普通 fetch 尽力而为。
      // 配额算的是**字节**不是字符：中文一个字 3 字节，按 body.length 判会把 60K 字的中文
      // 会话（180KB）当成小体积，浏览器直接 reject 掉整个请求 = 静默丢写。先用字符数快筛
      // （省掉大 body 的编码开销），过筛的再量一次真实字节数。
      if (urgent && body.length <= KEEPALIVE_MAX_BYTES && utf8ByteLength(body) <= KEEPALIVE_MAX_BYTES) {
        init.keepalive = true;
      }
    } else if (urgent) {
      init.keepalive = true;
    }
    const res = await fetch(entry.url, init);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body?.error) detail = body.error;
      } catch { /* 响应体不是 JSON，用状态码就够了 */ }
      throw new Error(detail);
    }
    entry.onSuccess?.(entry.payload);
  } catch (err) {
    // 不 rethrow：同 key 的队列不能因为一次失败卡住。onSuccess 没被调用，
    // 该条目在脏检测里仍然是脏的，下一次 state 变化会重发。
    console.error(`[db] 写入 ${entry.key} 失败：`, err);
  }
}

function firePending(key: string, urgent: boolean): Promise<void> {
  const entry = pendingWrites.get(key);
  if (!entry) return inflightWrites.get(key) ?? Promise.resolve();
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  pendingWrites.delete(key);

  const prev = inflightWrites.get(key) ?? Promise.resolve();
  const send = () => sendWrite(entry, urgent);
  const tail: Promise<void> = prev.then(send, send);
  inflightWrites.set(key, tail);
  void tail.then(() => {
    if (inflightWrites.get(key) === tail) inflightWrites.delete(key);
  });
  return tail;
}

/**
 * 把所有待写立刻发出去并等它们结束。幂等：pending 发完就清空，再调一次是空转。
 * 已知窗口：页面被强杀（进程崩溃 / 断电）时，最近一次 maxWait 内的写会丢。
 */
export const flushPendingWrites = async (urgent = false): Promise<void> => {
  if (mode !== 'file') return;
  const waits: Promise<void>[] = [];
  for (const key of Array.from(pendingWrites.keys())) waits.push(firePending(key, urgent));
  // firePending 已经把新队尾写回 inflightWrites，这里再收一遍能覆盖「只有在途、没有待发」的 key
  for (const p of Array.from(inflightWrites.values())) waits.push(p);
  await Promise.all(waits);
};

let flushHooksInstalled = false;
function installFlushHooks(): void {
  if (flushHooksInstalled || typeof window === 'undefined') return;
  flushHooksInstalled = true;
  // pagehide 覆盖关标签/刷新，visibilitychange 覆盖切后台（移动端可能不再回来）
  window.addEventListener('pagehide', () => { void flushPendingWrites(true); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPendingWrites(true);
  });
}

// ============================================================================
// file 模式：底层请求
// ============================================================================

async function putJson(pathname: string, body: unknown): Promise<void> {
  const res = await fetch(`${API_BASE}${pathname}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) detail = payload.error;
    } catch { /* ignore */ }
    throw new Error(`PUT ${pathname} 失败：${detail}`);
  }
}

async function deleteJson(pathname: string): Promise<void> {
  const res = await fetch(`${API_BASE}${pathname}`, { method: 'DELETE' });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const payload = await res.json();
      if (payload?.error) detail = payload.error;
    } catch { /* ignore */ }
    throw new Error(`DELETE ${pathname} 失败：${detail}`);
  }
}

/** 只拿磁盘上的 session id 列表（不读内容），导入时用来找出该删的多余会话。 */
async function listSessionIds(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/sessions`, { headers: { accept: 'application/json' } });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || `列出 sessions 失败：HTTP ${res.status}`);
  return Array.isArray(payload?.ids) ? (payload.ids as string[]) : [];
}

async function fetchAll(): Promise<DbAllResponse> {
  const res = await fetch(`${API_BASE}/all`, { headers: { accept: 'application/json' } });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload?.error || `读取 data/ 失败：HTTP ${res.status}`);
  return payload as DbAllResponse;
}

function stripSettingsId(settings: any): GlobalSettings {
  const { id, ...rest } = settings || {};
  return rest as GlobalSettings;
}

// ============================================================================
// initDB
// ============================================================================

/** legacy 后端的 initDB —— 与改造前完全一致，一行没动。 */
const legacyInitDB = async () => {
  try {
    const agentCount = await db.agents.count();
    if (agentCount === 0) {
      await (db as any).transaction('rw', db.agents, db.providers, db.sessions, db.groups, db.settings, async () => {
        await db.agents.bulkPut(INITIAL_AGENTS);
        await db.providers.bulkPut(INITIAL_PROVIDERS);
        await db.groups.bulkPut(INITIAL_GROUPS);
        await db.sessions.bulkPut(INITIAL_SESSIONS);
        await db.settings.put({ id: 'global', ...DEFAULT_SETTINGS });
      });
      console.log('Database initialized with default data');
    }
  } catch (err) {
    console.warn('initDB failed (corrupt DB?), will try loading with defaults:', err);
  }
};

/** 把一批数据写进 data/。搬家和播种共用；任何一步失败都直接抛。 */
async function writeAllTables(data: {
  agents: Agent[];
  providers: ApiProvider[];
  groups: ChatGroup[];
  sessions: ChatSession[];
  settings: GlobalSettings;
}): Promise<void> {
  await putJson('/agents', data.agents);
  await putJson('/providers', data.providers);
  await putJson('/groups', data.groups);
  await putJson('/settings', data.settings);
  for (const session of data.sessions) {
    await putJson(`/sessions/${encodeURIComponent(session.id)}`, session);
  }
}

async function writeMeta(migratedFrom: 'indexeddb' | 'seed' | 'import'): Promise<void> {
  await putJson('/meta', {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    migratedFrom,
    migratedAt: new Date().toISOString(),
  });
}

/**
 * React StrictMode 在 dev 下会把 bootstrap effect 跑两遍，两次 initDB 并发进来都会看到
 * meta === null，于是把整个数据集（几十 MB）搬两遍。用单飞 promise 合并掉。
 * 失败时清掉句柄，让下一次调用真的重试。
 */
let initPromise: Promise<void> | null = null;

export const initDB = async (): Promise<void> => {
  if (!initPromise) {
    initPromise = doInit().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
};

const doInit = async (): Promise<void> => {
  await probeBackend();
  if (mode !== 'file') {
    await legacyInitDB();
    return;
  }

  // probeBackend 在 mode 已定时是空转，不会重新拉快照。所以只要上一次探测抛过错
  // （data/ 里有坏文件 → 500），bootSnapshot 就还是 null，而下面把 null 当成「meta 缺失」
  // 会直接走进搬家/播种分支，拿 IndexedDB 或 INITIAL_* 覆盖掉用户磁盘上的真实数据 ——
  // 正是这次改造要防的那件事。没有快照就必须重读一次，读不动就继续抛。
  if (!bootSnapshot) bootSnapshot = await fetchAll();

  // meta 存在 = 已经初始化过，什么都不做
  if (bootSnapshot.meta) return;

  // meta 缺失 = 首次启动：先看 IndexedDB 里有没有旧数据，有就搬过来。
  // 这里刻意不 catch Dexie 的异常：库损坏 / 被别的标签页阻塞时宁可报错让用户重试，
  // 也不能当成「空库」去播种——一旦写下 meta，自动搬家的窗口就永远关上了。
  const legacyAgentCount = await db.agents.count();

  if (legacyAgentCount > 0) {
    const [agents, providers, groups, sessions, settingsRecord] = await Promise.all([
      db.agents.toArray(),
      db.providers.toArray(),
      db.groups.toArray(),
      db.sessions.toArray(),
      db.settings.get('global'),
    ]);
    // IndexedDB 只读不删不改，搬家失败还能靠 git revert 回到旧代码继续用
    await writeAllTables({
      agents,
      providers,
      groups,
      sessions,
      settings: settingsRecord ? stripSettingsId(settingsRecord) : DEFAULT_SETTINGS,
    });
    await writeMeta('indexeddb');
    console.log(`[db] 已从 IndexedDB 搬家到 data/：${agents.length} agents / ${sessions.length} sessions`);
  } else {
    await writeAllTables({
      agents: INITIAL_AGENTS,
      providers: INITIAL_PROVIDERS,
      groups: INITIAL_GROUPS,
      sessions: INITIAL_SESSIONS,
      settings: DEFAULT_SETTINGS,
    });
    await writeMeta('seed');
    console.log('[db] data/ 已用默认数据初始化');
  }

  // 搬家/播种刚写完，探测时拿的那份快照全是 null，必须重读一次；
  // 顺带验证数据确实落到了磁盘上。
  bootSnapshot = await fetchAll();
};

// ============================================================================
// loadAllData
// ============================================================================

const legacyLoadAllData = async () => {
  const safeLoad = async <T>(fn: () => Promise<T>, fallback: T, label: string): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`Failed to load ${label}, using defaults:`, err);
      return fallback;
    }
  };

  const agents = await safeLoad(() => db.agents.toArray(), [], 'agents');
  const providers = await safeLoad(() => db.providers.toArray(), [], 'providers');
  const sessions = await safeLoad(() => db.sessions.toArray(), [], 'sessions');
  const groups = await safeLoad(() => db.groups.toArray(), [], 'groups');
  const settingsRecord = await safeLoad(() => db.settings.get('global'), null, 'settings');

  let loadedSettings = DEFAULT_SETTINGS;
  if (settingsRecord) {
      const { id, ...rest } = settingsRecord;
      loadedSettings = rest as GlobalSettings;
  }

  return {
    agents: agents.length ? agents : INITIAL_AGENTS,
    providers: providers.length ? providers : INITIAL_PROVIDERS,
    groups: groups.length ? groups : INITIAL_GROUPS,
    sessions: sessions.length ? sessions : INITIAL_SESSIONS,
    settings: loadedSettings
  };
};

export const loadAllData = async () => {
  if (mode !== 'file') return legacyLoadAllData();

  const snap = bootSnapshot;
  if (!snap) throw new Error('data/ 尚未读取成功，无法加载（initDB 未先行或已失败）');

  // 缺文件 → 用默认值（只可能发生在首次启动，saveCollection 拒写空数组）。
  // 注意这里的 fallback 只对 null 生效；读失败在服务端就是 500，probeBackend 已经抛掉了。
  const agents = snap.agents ?? INITIAL_AGENTS;
  const providers = snap.providers ?? INITIAL_PROVIDERS;
  const groups = snap.groups ?? INITIAL_GROUPS;
  const settings = snap.settings ? stripSettingsId(snap.settings) : DEFAULT_SETTINGS;

  // 空数组仍退默认值：与 HEAD 行为保持一致（空 ≠ 读失败）
  const sessionsOnDisk = snap.sessions;
  const sessions = sessionsOnDisk && sessionsOnDisk.length ? sessionsOnDisk : INITIAL_SESSIONS;

  // 引用脏检测的基线：App 会把这些对象原样塞进 state，
  // 不先登记的话第一次 saveCollection 会把全部会话（含几十 MB 内联图片）整个重写一遍。
  // 只登记**真的在磁盘上**的那些：退到 INITIAL_SESSIONS 时若一并登记，
  // 这批种子会因为引用没变而永远写不下去（data/sessions/ 被手工删掉时就会踩到）。
  lastSavedSessions.clear();
  if (sessions === sessionsOnDisk) {
    for (const s of sessions) lastSavedSessions.set(s.id, s);
  }

  return {
    agents: agents.length ? agents : INITIAL_AGENTS,
    providers: providers.length ? providers : INITIAL_PROVIDERS,
    groups: groups.length ? groups : INITIAL_GROUPS,
    sessions,
    settings,
  };
};

// ============================================================================
// saveCollection / saveSettings
// ============================================================================

const legacySaveCollection = async <T extends { id: string }>(tableName: CollectionName, items: T[]) => {
  try {
    const table = (db as any).table(tableName);
    await (db as any).transaction('rw', table, async () => {
       await table.clear();
       await table.bulkPut(items);
    });
  } catch (err) {
    console.error(`Failed to save ${tableName}`, err);
  }
};

/** id → 上次成功写盘的那个 session 对象引用。 */
const lastSavedSessions = new Map<string, ChatSession>();

function saveSessionsToFiles(items: ChatSession[]): void {
  const present = new Set<string>();

  for (const session of items) {
    present.add(session.id);
    // 引用脏检测：App 里所有会话更新都走 setSessions(prev => prev.map(...)) 生成新对象，
    // 没被改动的会话引用不变。流式期间只有正在说话的那一个是新对象，靠这个避免
    // 每 300ms 把全部会话（内联 base64 附件，几十 MB）整个重写一遍。
    if (lastSavedSessions.get(session.id) === session) continue;
    scheduleWrite(
      `sessions/${session.id}`,
      `${API_BASE}/sessions/${encodeURIComponent(session.id)}`,
      'PUT',
      session,
      (payload) => { lastSavedSessions.set(session.id, payload as ChatSession); }
    );
  }

  // state 里没有、但磁盘上有的 = 被删掉的会话
  for (const id of Array.from(lastSavedSessions.keys())) {
    if (present.has(id)) continue;
    scheduleWrite(
      `sessions/${id}`,
      `${API_BASE}/sessions/${encodeURIComponent(id)}`,
      'DELETE',
      null,
      () => { lastSavedSessions.delete(id); }
    );
  }
}

// Generic helper to sync a collection (React State -> DB)
// legacy 后端用 clear() + bulkPut() 保证 state 里删掉的条目也从库里消失；
// file 后端整表 PUT（sessions 除外，见 saveSessionsToFiles）。
export const saveCollection = async <T extends { id: string }>(tableName: CollectionName, items: T[]) => {
  if (items.length === 0) {
    console.warn(`saveCollection('${tableName}'): refusing to save empty array (would delete all data)`);
    return;
  }
  // 只在方向未知时才 await，好让常规路径同步走到 scheduleWrite ——
  // 多插一个 microtask 会让「同一 tick 里先 save 再 flush」的调用方漏掉这次写。
  if (mode === 'unknown') {
    await ensureBackend();
    if (mode === 'unknown') {
      // 探测都失败了：不猜方向。猜错会把数据写进 IndexedDB，而用户以为它在 data/ 里。
      console.warn(`saveCollection('${tableName}'): 存储后端未确定，跳过本次写入`);
      return;
    }
  }
  if (mode !== 'file') {
    await legacySaveCollection(tableName, items);
    return;
  }
  if (tableName === 'sessions') {
    saveSessionsToFiles(items as unknown as ChatSession[]);
    return;
  }
  scheduleWrite(tableName, `${API_BASE}/${tableName}`, 'PUT', items);
};

const legacySaveSettings = async (settings: GlobalSettings) => {
  try {
    // Explicitly destructure to remove any potential 'id' from the settings object
    // to ensure we don't write id: undefined to the DB.
    const { id, ...rest } = settings as any;
    await db.settings.put({ id: 'global', ...rest });
  } catch (err) {
    console.error('Failed to save settings', err);
  }
};

export const saveSettings = async (settings: GlobalSettings) => {
  if (mode === 'unknown') {
    await ensureBackend();
    if (mode === 'unknown') {
      console.warn('saveSettings: 存储后端未确定，跳过本次写入');
      return;
    }
  }
  if (mode !== 'file') {
    await legacySaveSettings(settings);
    return;
  }
  scheduleWrite('settings', `${API_BASE}/settings`, 'PUT', stripSettingsId(settings));
};

// ============================================================================
// JSON 全量导出 / 导入
// ============================================================================

export const exportSnapshot = async (): Promise<DbSnapshot> => {
  await ensureBackend();
  if (mode === 'file') {
    // 先把待写的落盘，否则导出的是磁盘上的旧版本
    await flushPendingWrites();
    const snap = await fetchAll();
    return {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      agents: snap.agents ?? [],
      providers: snap.providers ?? [],
      groups: snap.groups ?? [],
      sessions: snap.sessions ?? [],
      settings: snap.settings ? stripSettingsId(snap.settings) : DEFAULT_SETTINGS,
    };
  }

  const [agents, providers, groups, sessions, settingsRecord] = await Promise.all([
    db.agents.toArray(),
    db.providers.toArray(),
    db.groups.toArray(),
    db.sessions.toArray(),
    db.settings.get('global'),
  ]);
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    agents,
    providers,
    groups,
    sessions,
    settings: settingsRecord ? stripSettingsId(settingsRecord) : DEFAULT_SETTINGS,
  };
};

function assertValidSnapshot(snapshot: any): asserts snapshot is DbSnapshot {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('备份文件不是一个 JSON 对象');
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`备份文件版本不匹配：期望 ${SNAPSHOT_SCHEMA_VERSION}，实际 ${snapshot.schemaVersion}`);
  }
  for (const key of ['agents', 'providers', 'groups', 'sessions'] as const) {
    if (!Array.isArray(snapshot[key])) throw new Error(`备份文件缺少字段或格式不对：${key}`);
  }
  if (!snapshot.settings || typeof snapshot.settings !== 'object') {
    throw new Error('备份文件缺少字段或格式不对：settings');
  }
}

/**
 * 用备份覆盖当前数据：导入后磁盘状态必须**等于**备份，所以除了覆盖写，还要把
 * 备份里没有的会话文件删掉——否则「恢复到某个备份」会变成「备份 ∪ 磁盘残留」，
 * 用户以为删干净了的会话会在刷新后复活。调用方负责 confirm 与 reload。
 */
export const importSnapshot = async (snapshot: unknown): Promise<void> => {
  assertValidSnapshot(snapshot);
  await ensureBackend();

  if (mode !== 'file') {
    await (db as any).transaction('rw', db.agents, db.providers, db.sessions, db.groups, db.settings, async () => {
      await db.agents.clear(); await db.agents.bulkPut(snapshot.agents);
      await db.providers.clear(); await db.providers.bulkPut(snapshot.providers);
      await db.groups.clear(); await db.groups.bulkPut(snapshot.groups);
      await db.sessions.clear(); await db.sessions.bulkPut(snapshot.sessions);
      await db.settings.put({ id: 'global', ...stripSettingsId(snapshot.settings) });
    });
    return;
  }

  // 先把在途的写清干净，免得导入完了又被旧 payload 盖回去
  await flushPendingWrites();

  // 先探磁盘上现有的会话 id（只列名不读内容，坏文件也不会让这一步失败）。
  // 列不出来就退化成「只覆盖不删除」并告警，绝不因此让整个导入失败。
  let staleIds: string[] | null = null;
  try {
    const keep = new Set(snapshot.sessions.map((s) => s.id));
    staleIds = (await listSessionIds()).filter((id) => !keep.has(id));
  } catch (err) {
    console.error('[db] 无法列出现有会话，导入将只覆盖不删除多余文件：', err);
  }

  await writeAllTables({
    agents: snapshot.agents,
    providers: snapshot.providers,
    groups: snapshot.groups,
    sessions: snapshot.sessions,
    settings: stripSettingsId(snapshot.settings),
  });

  // 删多余会话放在覆盖写之后：万一删到一半失败，磁盘上是「备份 ∪ 残留」，
  // 比「备份缺了几张表 + 已经删干净」要好收拾得多。
  if (staleIds) {
    for (const id of staleIds) {
      await deleteJson(`/sessions/${encodeURIComponent(id)}`);
    }
  }

  await writeMeta('import');
  lastSavedSessions.clear();
};
