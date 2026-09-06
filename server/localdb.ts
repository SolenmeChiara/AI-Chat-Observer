// 本机磁盘存储的服务端：一个只处理 /api/db/* 的 Vite 中间件插件。
// 数据落在 <repo>/data/ 下的 JSON 文件里，不再依赖浏览器 origin 存储。
// 纯 Node http + fs/promises，不引入 express / body-parser 之类依赖。
//
// 设计要点：
// - 读失败(文件存在但读不动/parse 不了)一律 500，绝不吞成 null——客户端把 null 当
//   「首次启动」就会拿种子数据把用户真实数据覆盖掉。文件不存在才是 null + missing。
// - 写一律 tmp + rename 原子替换，同一路径的写用 promise 链串行化。
// - 只服务本机：providers.json 里是明文 API key，一旦 vite 以 --host 起在局域网上，
//   这个接口就等于把 key 挂出去了。所以按「回环地址 + 回环 Host + Origin 同源」三重闸门拦。
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/** 请求体上限，超过直接 413。内联 base64 附件让单个 session 可以很大，留足余量。 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** 整表文件（不含按 id 拆分的 sessions/）。 */
const TABLE_FILES = ['meta', 'agents', 'providers', 'groups', 'settings'] as const;
type TableName = (typeof TABLE_FILES)[number];

/** session id 只允许这些字符，挡掉 `..`、`/`、盘符等一切路径穿越写法。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;

// --- 工具：只准本机访问 ---

/** 去掉 IPv6 映射前缀和方括号，`::ffff:127.0.0.1` / `[::1]` 都归一成裸地址。 */
function normalizeHostname(value: string): string {
  let v = value.trim().toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end > 0) return v.slice(1, end);
  }
  if (v.startsWith('::ffff:')) v = v.slice('::ffff:'.length);
  return v;
}

function isLoopbackHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (h === 'localhost' || h === '::1' || h === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // 整个 127.0.0.0/8 都是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** `host` 头里的 hostname 部分（去端口）。IPv6 要先摘方括号再摘端口。 */
function hostnameFromHostHeader(host: string): string {
  const h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(1, end).toLowerCase();
    return '';
  }
  return h.split(':')[0].toLowerCase();
}

/** 准入判断的结果。`ok:false` 时 `reason` 必填（直接当 403 的 error 文案）。 */
interface AccessDecision {
  ok: boolean;
  reason?: string;
}

/**
 * 访问闸门。**所有对 /api/db/* 的准入判断都收在这一个函数里**，二期要做「手机在局域网上
 * 访问」时改这里一处即可（预期做法：非回环请求放行但剥掉 providers 里的 apiKey 字段 +
 * 校验 token），不要把判断散到路由里。
 *
 * 两组检查，彼此独立：
 *
 * A. 回环闸门（受 `ACO_ALLOW_LAN=1` 控制，默认关闸）
 *    1. TCP 对端必须是回环地址 —— 挡住 `vite --host` 之后局域网里的直连；
 *    2. `Host` 头必须是回环名 —— 挡住 DNS rebinding：攻击者把 evil.com 解析到 127.0.0.1，
 *       此时对端是回环、Origin 与 Host 也自洽，只有 Host 里的名字能暴露它。
 *    开闸后这两条都不查（局域网访问时 Host 本来就是 LAN IP）。
 *
 * B. Origin 同源校验（**与开关无关，永远生效**）
 *    带了 `Origin` 就必须与 `Host` 完全一致，否则 403。没有 CORS 头时浏览器本来也读不到
 *    响应、PUT/DELETE 会被预检拦下，这条是纵深防御。
 *
 * 之所以默认关闸：providers.json 里是明文 API key，`GET /api/db/all` 直接返回。
 */
function isRequestAllowed(req: IncomingMessage): AccessDecision {
  const host = (req.headers.host || '').toString();

  // --- A. 回环闸门 ---
  if (process.env.ACO_ALLOW_LAN !== '1') {
    const remote = req.socket?.remoteAddress || '';
    if (!remote || !isLoopbackHostname(remote)) {
      return {
        ok: false,
        reason: `/api/db 只服务本机，拒绝来自 ${remote || '未知地址'} 的请求（确需局域网访问请设 ACO_ALLOW_LAN=1，注意这会把明文 API key 暴露在局域网上）`,
      };
    }
    if (!host || !isLoopbackHostname(hostnameFromHostHeader(host))) {
      return { ok: false, reason: `/api/db 只服务本机，拒绝 Host: ${host || '(缺失)'}` };
    }
  }

  // --- B. Origin 同源校验（始终生效）---
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return { ok: false, reason: `/api/db 拒绝无法解析的 Origin: ${origin}` };
    }
    if (!host || originHost !== host.toLowerCase()) {
      return { ok: false, reason: `/api/db 拒绝跨站请求：Origin ${origin} 与 Host ${host || '(缺失)'} 不一致` };
    }
  }

  return { ok: true };
}

// --- 工具：响应 ---

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // 数据是本机磁盘的实时状态，任何一层缓存都可能让前端读到旧值。
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

// --- 工具：读请求体 ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (err: Error & { statusCode?: number }) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      // 超限之后仍然把剩下的字节读掉（只是不再缓存）：直接 req.destroy() 会把连接打断，
      // 客户端看到的是 ECONNRESET 而不是 413，反而更难排查。
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err: Error & { statusCode?: number } = new Error(
          `request body too large (> ${MAX_BODY_BYTES} bytes)`
        );
        err.statusCode = 413;
        chunks.length = 0; // 立刻释放已缓存的部分
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => fail(err as Error));
  });
}

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

// --- 工具：读 JSON ---

type ReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'error'; error: string };

async function readJson(filePath: string): Promise<ReadResult> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch (err: any) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return { status: 'missing' };
    return { status: 'error', error: `读取 ${path.basename(filePath)} 失败：${err?.message || String(err)}` };
  }
  try {
    return { status: 'ok', value: JSON.parse(text) };
  } catch (err: any) {
    // 文件在但 parse 不了 = 数据损坏，必须让前端看见 500，不能当作「没有这张表」
    return { status: 'error', error: `解析 ${path.basename(filePath)} 失败：${err?.message || String(err)}` };
  }
}

// --- 中间件本体 ---

function createMiddleware(getDataDir: () => string): Middleware {
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

  async function handlePut(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req);
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
    sendJson(res, 200, { ok: true });
  }

  async function handleDeleteSession(res: ServerResponse, filePath: string): Promise<void> {
    try {
      // force:true —— 文件不存在也算成功（删除是幂等的）
      await serializeByPath(filePath, () => fs.rm(filePath, { force: true }));
    } catch (err: any) {
      sendJson(res, 500, { error: `删除 ${path.basename(filePath)} 失败：${err?.message || String(err)}` });
      return;
    }
    sendJson(res, 200, { ok: true });
  }

  return (req, res, next) => {
    const rawUrl = req.url || '';
    const pathname = rawUrl.split('?')[0];
    if (!pathname.startsWith('/api/db/')) {
      next();
      return;
    }

    // 准入判断收在 isRequestAllowed 里（回环闸门 + Origin 同源），不过就 403，不落任何盘。
    const allowed = isRequestAllowed(req);
    if (!allowed.ok) {
      const reason = allowed.reason || '/api/db 拒绝该请求';
      console.warn(`[aco-local-db] 403 ${req.method} ${pathname} — ${reason}`);
      sendJson(res, 403, { error: reason });
      return;
    }

    const rest = pathname.slice('/api/db/'.length);
    const method = (req.method || 'GET').toUpperCase();

    const run = async (): Promise<void> => {
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
          await handlePut(req, res, sessionPathFor(id));
          return;
        }
        if (method === 'DELETE') {
          await handleDeleteSession(res, sessionPathFor(id));
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

export function localDbPlugin(): Plugin {
  let dataDir = resolveDataDir(process.cwd());
  const middleware = createMiddleware(() => dataDir);

  return {
    name: 'aco-local-db',
    configResolved(config) {
      dataDir = resolveDataDir(config.root);
      console.log(`[aco-local-db] 数据目录：${dataDir}`);
    },
    configureServer(server) {
      // 不用返回值形式：要抢在 vite 内建中间件之前拿到 /api/db/*
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default localDbPlugin;
