// 本机磁盘存储的服务端：一个 Vite 中间件插件，同时挂三组路由——
//   /api/db/*    数据读写（只服务本机，见 server/http.ts 的 resolveRole）
//   /api/live/*  手机观众模式的实时通道（server/live.ts）
//   /api/view/*  剥掉敏感字段的只读视图（server/live.ts）
// 数据落在 <repo>/data/ 下的 JSON 文件里，不再依赖浏览器 origin 存储。
// 纯 Node http + fs/promises，除二维码用的 qrcode 外不引入运行时依赖。
//
// 设计要点：
// - 读失败(文件存在但读不动/parse 不了)一律 500，绝不吞成 null——客户端把 null 当
//   「首次启动」就会拿种子数据把用户真实数据覆盖掉。文件不存在才是 null + missing。
// - 写一律 tmp + rename 原子替换，同一路径的写用 promise 链串行化。
// - 准入判断全部收在 http.ts 的 resolveRole 里；本文件只负责「哪个角色能碰哪条路径」的矩阵。
//   providers.json 里是明文 API key，只有 loopback 角色能走到 /api/db/*，局域网一律 403。
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, UserConfig } from 'vite';
import {
  MAX_BODY_BYTES,
  SESSION_ID_RE,
  TAILSCALE_DNS_SUFFIX,
  ensureLanToken,
  getDataDir,
  getLanToken,
  isLanEnabled,
  isTailscaleIPv4,
  localIPv4Addresses,
  parseRequestUrl,
  readBody,
  readJson,
  resolveRole,
  sendJson,
  setDataDir,
  setLanEnabled,
  type Middleware,
} from './http';
import {
  handleLiveRequest,
  isLivePath,
  isLoopbackOnlyLivePath,
  onSessionDeleted,
  onSessionWritten,
  setServerPort,
} from './live';

/** 整表文件（不含按 id 拆分的 sessions/）。 */
const TABLE_FILES = ['meta', 'agents', 'providers', 'groups', 'settings'] as const;
type TableName = (typeof TABLE_FILES)[number];

// --- 工具：原子写 + 同路径串行 ---

/**
 * 同一个文件路径上的写排成一条 promise 链，避免两次 PUT 交错写同一个目标。
 * 队尾只承载「已结束」不承载错误：前一次写失败不能卡死后面的写。
 */
const writeQueues = new Map<string, Promise<void>>();

function serializeByPath<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const run = prev.then(task, task);
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined
  );
  writeQueues.set(filePath, tail);
  void tail.then(() => {
    // 只有自己还是队尾时才清理，否则会丢掉后来者的排队位置
    if (writeQueues.get(filePath) === tail) writeQueues.delete(filePath);
  });
  return run;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  try {
    await fs.writeFile(tmp, content, 'utf-8');
    // Windows 上 fs.rename 走 MoveFileEx(REPLACE_EXISTING)，覆盖同分区已存在文件是原子的。
    await fs.rename(tmp, filePath);
  } catch (err) {
    // 失败时把半成品 tmp 清掉，别在 data/ 里留垃圾
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// --- 中间件本体 ---

function createMiddleware(): Middleware {
  const filePathFor = (table: TableName) => path.join(getDataDir(), `${table}.json`);
  const sessionsDir = () => path.join(getDataDir(), 'sessions');
  const sessionPathFor = (id: string) => path.join(sessionsDir(), `${id}.json`);

  async function handleGetAll(res: ServerResponse): Promise<void> {
    const out: Record<string, unknown> = {};
    const missing: string[] = [];

    for (const table of TABLE_FILES) {
      const r = await readJson(filePathFor(table));
      if (r.status === 'ok') {
        out[table] = r.value;
      } else if (r.status === 'missing') {
        out[table] = null;
        missing.push(table);
      } else {
        sendJson(res, 500, { error: r.error });
        return;
      }
    }

    let entries: string[];
    try {
      entries = await fs.readdir(sessionsDir());
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        out.sessions = null;
        missing.push('sessions');
        sendJson(res, 200, { ...out, missing });
        return;
      }
      sendJson(res, 500, { error: `读取 sessions/ 目录失败：${err?.message || String(err)}` });
      return;
    }

    const sessions: unknown[] = [];
    for (const name of entries) {
      // 跳过原子写留下的中间文件（正常情况下不该有，崩溃时可能残留）
      if (!name.endsWith('.json') || name.includes('.tmp-')) continue;
      const r = await readJson(path.join(sessionsDir(), name));
      if (r.status === 'ok') {
        sessions.push(r.value);
      } else if (r.status === 'missing') {
        continue; // 列目录和读文件之间被删了，忽略
      } else {
        sendJson(res, 500, { error: r.error });
        return;
      }
    }
    out.sessions = sessions;
    sendJson(res, 200, { ...out, missing });
  }

  /**
   * `sessionId` 非空 = 这是一次会话写入，落盘成功后要通知 live 模块
   * （刷新会话索引/缓存 + 向所有 SSE 连接广播 `session` 事件）。
   * parsed 对象顺手交出去，省掉为了广播再 parse 一遍几十 MB 的开销。
   */
  async function handlePut(
    req: IncomingMessage,
    res: ServerResponse,
    filePath: string,
    sessionId?: string
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch (err: any) {
      const status = err?.statusCode === 413 ? 413 : 400;
      sendJson(res, status, { error: err?.message || 'failed to read request body' });
      return;
    }
    // 先 parse 再写：绝不把一段读不回来的字节落到磁盘上
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      sendJson(res, 400, { error: `invalid JSON: ${err?.message || String(err)}` });
      return;
    }
    try {
      await serializeByPath(filePath, () => atomicWrite(filePath, JSON.stringify(parsed, null, 2)));
    } catch (err: any) {
      sendJson(res, 500, { error: `写入 ${path.basename(filePath)} 失败：${err?.message || String(err)}` });
      return;
    }
    if (sessionId) {
      // 广播失败不能影响这次写的结果：磁盘已经是新的了，回 200 才是真话
      try {
        onSessionWritten(sessionId, parsed);
      } catch (err: any) {
        console.warn(`[aco-live] 广播 session 事件失败：${err?.message || String(err)}`);
      }
    }
    sendJson(res, 200, { ok: true });
  }

  async function handleDeleteSession(res: ServerResponse, filePath: string, sessionId: string): Promise<void> {
    try {
      // force:true —— 文件不存在也算成功（删除是幂等的）
      await serializeByPath(filePath, () => fs.rm(filePath, { force: true }));
    } catch (err: any) {
      sendJson(res, 500, { error: `删除 ${path.basename(filePath)} 失败：${err?.message || String(err)}` });
      return;
    }
    try {
      onSessionDeleted(sessionId);
    } catch (err: any) {
      console.warn(`[aco-live] 广播 session 删除事件失败：${err?.message || String(err)}`);
    }
    sendJson(res, 200, { ok: true });
  }

  return (req, res, next) => {
    let url: URL;
    try {
      url = parseRequestUrl(req);
    } catch {
      next();
      return;
    }
    const pathname = url.pathname;
    const isDb = pathname.startsWith('/api/db/');
    const isLive = isLivePath(pathname);
    if (!isDb && !isLive) {
      next();
      return;
    }

    // --- 准入：角色判定收在 http.ts 的 resolveRole 里 ---
    const role = resolveRole(req, url);
    if (role === null) {
      const reason = isLanEnabled()
        ? `拒绝该请求：不是本机回环，且 Host/token 不满足局域网条件（Host 必须是 IP 字面量或 ${TAILSCALE_DNS_SUFFIX} 域名，并带正确 token）`
        : '只服务本机（要开放手机观看请用 npm run dev:lan 启动）';
      console.warn(`[aco-local-db] 403 ${req.method} ${pathname} — ${reason}`);
      sendJson(res, 403, { error: reason });
      return;
    }

    // --- 授权矩阵（PHONE_VIEWER_PLAN §3.1）---
    // /api/db/*、/api/live/lan-info、/api/live/presence 只给 loopback；
    // /api/live/events、/api/live/inbox、/api/view/* 两个角色都可以。
    if (role !== 'loopback' && (isDb || isLoopbackOnlyLivePath(pathname))) {
      const reason = isDb
        ? '/api/db 只服务本机：providers.json 里是明文 API key，永远不对局域网开放'
        : `${pathname} 只服务本机`;
      console.warn(`[aco-local-db] 403 ${req.method} ${pathname} — ${reason}`);
      sendJson(res, 403, { error: reason });
      return;
    }

    const method = (req.method || 'GET').toUpperCase();

    const run = async (): Promise<void> => {
      if (isLive) {
        await handleLiveRequest(req, res, url, role);
        return;
      }

      const rest = pathname.slice('/api/db/'.length);

      if (rest === 'all') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: `method ${method} not allowed on /api/db/all` });
          return;
        }
        await handleGetAll(res);
        return;
      }

      if ((TABLE_FILES as readonly string[]).includes(rest)) {
        if (method !== 'PUT') {
          sendJson(res, 405, { error: `method ${method} not allowed on /api/db/${rest}` });
          return;
        }
        await handlePut(req, res, filePathFor(rest as TableName));
        return;
      }

      // 只列 id，不读文件内容：导入备份时要知道磁盘上有哪些会话好删掉多余的，
      // 走 /all 的话既要把几十 MB 全读一遍，还会因为某个坏文件 500 而连带让导入失败。
      if (rest === 'sessions') {
        if (method !== 'GET') {
          sendJson(res, 405, { error: `method ${method} not allowed on /api/db/sessions` });
          return;
        }
        let names: string[];
        try {
          names = await fs.readdir(sessionsDir());
        } catch (err: any) {
          if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
            sendJson(res, 200, { ids: [] });
            return;
          }
          sendJson(res, 500, { error: `读取 sessions/ 目录失败：${err?.message || String(err)}` });
          return;
        }
        const ids = names
          .filter((n) => n.endsWith('.json') && !n.includes('.tmp-'))
          .map((n) => n.slice(0, -'.json'.length))
          .filter((id) => SESSION_ID_RE.test(id));
        sendJson(res, 200, { ids });
        return;
      }

      if (rest.startsWith('sessions/')) {
        const id = rest.slice('sessions/'.length);
        if (!SESSION_ID_RE.test(id)) {
          sendJson(res, 400, { error: 'invalid session id' });
          return;
        }
        if (method === 'PUT') {
          await handlePut(req, res, sessionPathFor(id), id);
          return;
        }
        if (method === 'DELETE') {
          await handleDeleteSession(res, sessionPathFor(id), id);
          return;
        }
        sendJson(res, 405, { error: `method ${method} not allowed on /api/db/sessions/:id` });
        return;
      }

      sendJson(res, 404, { error: `unknown endpoint: ${pathname}` });
    };

    run().catch((err) => {
      if (res.writableEnded) return;
      sendJson(res, 500, { error: err?.message || String(err) });
    });
  };
}

/**
 * 数据目录：默认 <项目根>/data，ACO_DATA_DIR 覆盖（相对路径按项目根解析）。
 */
function resolveDataDir(root: string): string {
  const override = process.env.ACO_DATA_DIR;
  if (override && override.trim()) return path.resolve(root, override.trim());
  return path.join(root, 'data');
}

/** 入口 URL 只在启动时打一次，dev/preview 各起一次进程互不影响。 */
let entryUrlsPrinted = false;

function printEntryUrls(port: number): void {
  if (!isLanEnabled() || entryUrlsPrinted) return;
  const token = getLanToken();
  if (!token) return;
  entryUrlsPrinted = true;

  const query = `?token=${encodeURIComponent(token)}`;
  const ips = localIPv4Addresses();
  const tailscale = ips.filter(isTailscaleIPv4);
  const lan = ips.filter((ip) => !isTailscaleIPv4(ip));

  console.log('[aco-live] 手机观看已开启（局域网 / Tailscale 可访问，凭 token）：');
  for (const ip of tailscale) console.log(`  Tailscale  http://${ip}:${port}/viewer${query}`);
  for (const ip of lan) console.log(`  局域网      http://${ip}:${port}/viewer${query}`);
  if (!tailscale.length && !lan.length) console.log('  （没找到非回环 IPv4 地址）');
  console.log(`  也可以 tailscale serve https / http://127.0.0.1:${port} 后走 https://<机器名>.<tailnet>.ts.net/viewer${query}`);
  console.log(`  token 存在 ${path.join(getDataDir(), 'lan-token.txt')}，删掉重启即作废。`);
}

export function localDbPlugin(): Plugin {
  setDataDir(resolveDataDir(process.cwd()));
  const middleware = createMiddleware();

  // 只用 address()，所以按结构类型收——vite 的 HttpServer 是 http.Server | Http2SecureServer
  type Addressable = { address(): string | { port: number } | null } | null | undefined;
  const onListening = (httpServer: Addressable, fallbackPort?: number): void => {
    const addr = httpServer?.address();
    const port = addr && typeof addr === 'object' ? addr.port : fallbackPort ?? 0;
    if (port) setServerPort(port);
    printEntryUrls(port || fallbackPort || 0);
  };

  return {
    name: 'aco-local-db',
    /**
     * LAN 开关只有这一处来源：`--mode lan`（npm run dev:lan / preview:lan）或 ACO_ALLOW_LAN=1。
     * 开启时顺带把监听地址放开到所有接口，并把 `.ts.net` 加进 allowedHosts——
     * Vite 自带的 hostCheck 对纯 IPv4 Host 本来就放行，但 MagicDNS 主机名会被它挡掉
     * （挡的是 index.html 这类静态请求，跟我们自己的 403 是两回事）。
     */
    config(config, { mode }) {
      const lan = mode === 'lan' || process.env.ACO_ALLOW_LAN === '1';
      setLanEnabled(lan);
      if (!lan) return;

      const patch: UserConfig = {};
      // 用户显式配过就不覆盖
      if (config.server?.host === undefined) patch.server = { ...patch.server, host: true };
      if (config.preview?.host === undefined) patch.preview = { ...patch.preview, host: true };
      if (config.server?.allowedHosts !== true) {
        patch.server = { ...patch.server, allowedHosts: [TAILSCALE_DNS_SUFFIX] };
      }
      if (config.preview?.allowedHosts !== true) {
        patch.preview = { ...patch.preview, allowedHosts: [TAILSCALE_DNS_SUFFIX] };
      }
      return patch;
    },
    configResolved(config) {
      setDataDir(resolveDataDir(config.root));
      console.log(`[aco-local-db] 数据目录：${getDataDir()}`);
      // token 必须在第一个请求之前就位（resolveRole 是同步的），所以放在这里同步读/生成
      if (isLanEnabled()) ensureLanToken();
    },
    configureServer(server) {
      // 不用返回值形式：要抢在 vite 内建中间件之前拿到 /api/db/*、/api/live/*、/api/view/*
      server.middlewares.use(middleware);
      const fallback = server.config.server.port;
      if (server.httpServer?.listening) onListening(server.httpServer, fallback);
      else server.httpServer?.once('listening', () => onListening(server.httpServer, fallback));
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
      const fallback = server.config.preview.port;
      if (server.httpServer?.listening) onListening(server.httpServer, fallback);
      else server.httpServer?.once('listening', () => onListening(server.httpServer, fallback));
    },
  };
}

export default localDbPlugin;
