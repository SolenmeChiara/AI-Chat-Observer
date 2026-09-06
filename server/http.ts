// 服务端共享层：响应/请求体/角色判定/LAN 开关与 token。
// server/localdb.ts（/api/db/*）与 server/live.ts（/api/live/*、/api/view/*）都从这里取工具，
// 保证「谁能访问什么」只有一处定义——二期加手机观众模式时踩过的坑就是判断散在路由里。
//
// 纯 Node 内置模块，不引入 express / body-parser 之类依赖。
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 请求体上限，超过直接 413。内联 base64 附件让单个 session 可以很大，留足余量。 */
export const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** 小请求体上限（presence / inbox 这种纯文本控制消息），64 KB 足够。 */
export const SMALL_BODY_BYTES = 64 * 1024;

/** session id 只允许这些字符，挡掉 `..`、`/`、盘符等一切路径穿越写法。 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: (err?: any) => void) => void;

/**
 * 请求角色。
 * - `loopback`：本机浏览器（电脑端主界面），全权。
 * - `lan`：局域网设备（手机观众），只读视图 + inbox，永远碰不到 /api/db/*。
 * - `null`：拒绝。
 */
export type Role = 'loopback' | 'lan';

// --- 主机名归一 ---

/** 去掉 IPv6 映射前缀和方括号，`::ffff:127.0.0.1` / `[::1]` 都归一成裸地址。 */
export function normalizeHostname(value: string): string {
  let v = value.trim().toLowerCase();
  if (v.startsWith('[')) {
    const end = v.indexOf(']');
    if (end > 0) return v.slice(1, end);
  }
  if (v.startsWith('::ffff:')) v = v.slice('::ffff:'.length);
  return v;
}

export function isLoopbackHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (h === 'localhost' || h === '::1' || h === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
  // 整个 127.0.0.0/8 都是回环
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** Tailscale MagicDNS 域名后缀。`tailscale serve` 反代过来的 Host 长这样。 */
export const TAILSCALE_DNS_SUFFIX = '.ts.net';

/** Host 是不是 MagicDNS 名（`<机器名>.<tailnet>.ts.net`）。 */
export function isTailscaleHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  return h.length > TAILSCALE_DNS_SUFFIX.length && h.endsWith(TAILSCALE_DNS_SUFFIX);
}

/** IPv4 是否落在 Tailscale 的 CGNAT 段 100.64.0.0/10。 */
export function isTailscaleIPv4(address: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(address.trim());
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 100 && b >= 64 && b <= 127;
}

/** `host` 头里的 hostname 部分（去端口）。IPv6 要先摘方括号再摘端口。 */
export function hostnameFromHostHeader(host: string): string {
  const h = host.trim();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(1, end).toLowerCase();
    return '';
  }
  return h.split(':')[0].toLowerCase();
}

/** `host` 头里的端口部分；没写端口（80/443）时返回 null。 */
export function portFromHostHeader(host: string): number | null {
  const h = host.trim();
  let tail: string;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) return null;
    tail = h.slice(end + 1);
  } else {
    const idx = h.indexOf(':');
    if (idx < 0) return null;
    tail = h.slice(idx);
  }
  if (!tail.startsWith(':')) return null;
  const port = Number.parseInt(tail.slice(1), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

// --- 模块级状态：数据目录 / LAN 开关 / token ---

let dataDir = path.join(process.cwd(), 'data');
/** LAN 是否开启。由插件的 config() 钩子按 `mode === 'lan' || ACO_ALLOW_LAN === '1'` 写入。 */
let lanEnabled = false;
/** LAN token，只在 LAN 开启时才有值。null = 不接受任何 lan 角色请求。 */
let lanToken: string | null = null;
/** token 的 Buffer 形式，省掉每次请求的编码开销（timingSafeEqual 要 Buffer）。 */
let lanTokenBuf: Buffer | null = null;

export function setDataDir(dir: string): void {
  dataDir = dir;
}

export function getDataDir(): string {
  return dataDir;
}

export function setLanEnabled(value: boolean): void {
  lanEnabled = value;
}

export function isLanEnabled(): boolean {
  return lanEnabled;
}

export function getLanToken(): string | null {
  return lanToken;
}

/** token 文件路径：`<dataDir>/lan-token.txt`。想作废 token 就删这个文件重启。 */
export function lanTokenPath(): string {
  return path.join(dataDir, 'lan-token.txt');
}

/**
 * 读出（或首次生成）LAN token。同步实现：只在插件启动时调一次，
 * 而 resolveRole 是同步的、必须在第一个请求进来之前就拿到 token。
 * LAN 未开启时什么都不做，也不会在 data/ 里留文件。
 */
export function ensureLanToken(): string | null {
  if (!lanEnabled) {
    lanToken = null;
    lanTokenBuf = null;
    return null;
  }
  if (lanToken) return lanToken;

  const file = lanTokenPath();
  try {
    const existing = fsSync.readFileSync(file, 'utf-8').trim();
    // 太短的（手工改坏 / 写了一半）不认，重新生成，免得留下一个弱 token
    if (existing.length >= 16) {
      lanToken = existing;
      lanTokenBuf = Buffer.from(existing, 'utf-8');
      return lanToken;
    }
  } catch {
    // 不存在 / 读不动都走生成分支
  }

  const generated = crypto.randomBytes(24).toString('base64url');
  try {
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    // mode 0o600：Linux/macOS 上只有本人可读；Windows 上被忽略，靠 data/ 目录本身的 ACL。
    fsSync.writeFileSync(file, `${generated}\n`, { encoding: 'utf-8', mode: 0o600 });
  } catch (err: any) {
    // 落不了盘就只在内存里用：本次进程仍能开手机观看，只是重启后二维码会变。
    console.warn(`[aco-live] 无法写入 ${file}，token 只在本次进程内有效：${err?.message || String(err)}`);
  }
  lanToken = generated;
  lanTokenBuf = Buffer.from(generated, 'utf-8');
  return lanToken;
}

/** 常数时间比较。长度不等直接 false —— timingSafeEqual 长度不等会抛。 */
function tokenMatches(candidate: string): boolean {
  if (!lanTokenBuf || !candidate) return false;
  const buf = Buffer.from(candidate, 'utf-8');
  if (buf.length !== lanTokenBuf.length) return false;
  return crypto.timingSafeEqual(buf, lanTokenBuf);
}

/** 从 `Authorization: Bearer <token>` 或 `?token=` 取 token（EventSource 加不了请求头）。 */
function extractToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const value = auth.slice('bearer '.length).trim();
    if (value) return value;
  }
  return url.searchParams.get('token') || '';
}

// --- 角色判定 ---

/**
 * 所有 API 的准入判断都收在这一个函数里。四步（见 PHONE_VIEWER_PLAN §3.1）：
 *
 * 1. **Origin 同源校验（永远生效）**：带了 `Origin` 就必须与 `Host` 完全一致。
 *    没有 CORS 头时浏览器本来也读不到跨源响应、PUT/DELETE 会被预检拦下，这条是纵深防御，
 *    挡的是「恶意网页借用户浏览器打局域网地址」这类 CSRF。
 * 2. **回环**：TCP 对端是回环地址 **且** `Host` 是回环名 → `loopback`。
 *    两条都要：对端回环挡住 `vite --host` 后局域网里的直连；Host 回环挡住 DNS rebinding
 *    （攻击者把 evil.com 解析到 127.0.0.1，此时对端是回环、Origin 与 Host 也自洽，
 *    只有 Host 里的名字能暴露它）。
 * 3. **局域网 / Tailscale**：LAN 已开启时，`Host` 必须是 IP 字面量**或** `.ts.net`
 *    （MagicDNS）**且** token 常数时间比对通过 → `lan`。两种都挡 DNS rebinding：
 *    攻击者的域名既不是 IP 字面量、也拿不到 Sol 的 tailnet 子域。
 *    **这一步不看对端地址**——`tailscale serve https / http://127.0.0.1:5173` 反代时
 *    请求是从 127.0.0.1 进来的，只有 Host 是 `xxx.ts.net`，必须落到这里而不是被第 2 步吃掉
 *    （第 2 步要求 Host 也是回环名，所以两者不会混）。
 * 4. 其他 → null（调用方回 403）。
 *
 * 注意 `lan` 角色只是「通过了门」，具体能碰哪些路径由路由层的授权矩阵决定：
 * /api/db/* 永远只给 loopback，providers.json 里的明文 key 不存在出机的路径。
 */
export function resolveRole(req: IncomingMessage, url: URL): Role | null {
  const host = (req.headers.host || '').toString();

  // --- 1. Origin 同源校验（与开关无关，永远生效）---
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return null;
    }
    if (!host || originHost !== host.toLowerCase()) return null;
  }

  // --- 2. 回环角色 ---
  const remote = req.socket?.remoteAddress || '';
  const hostname = host ? hostnameFromHostHeader(host) : '';
  if (remote && isLoopbackHostname(remote) && hostname && isLoopbackHostname(hostname)) {
    return 'loopback';
  }

  // --- 3. 局域网 / Tailscale 角色 ---
  if (!lanEnabled || !lanTokenBuf) return null;
  // Host 必须是 IP 字面量（v4 或 v6）或 MagicDNS 名，其余域名一律不认
  if (!hostname) return null;
  const isAllowedHost = net.isIP(normalizeHostname(hostname)) !== 0 || isTailscaleHostname(hostname);
  if (!isAllowedHost) return null;
  if (!tokenMatches(extractToken(req, url))) return null;
  return 'lan';
}

/** 把 req.url 解析成 URL 对象（origin 是占位的，只用 pathname / searchParams）。 */
export function parseRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url || '/', 'http://localhost');
}

// --- 响应 ---

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // 数据是本机磁盘的实时状态，任何一层缓存都可能让前端读到旧值。
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

// --- 请求体 ---

/**
 * 读完整个请求体。超限之后仍然把剩下的字节读掉（只是不再缓存）：
 * 直接 req.destroy() 会把连接打断，客户端看到的是 ECONNRESET 而不是 413，反而更难排查。
 */
export function readBody(req: IncomingMessage, limit: number = MAX_BODY_BYTES): Promise<string> {
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
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const err: Error & { statusCode?: number } = new Error(`request body too large (> ${limit} bytes)`);
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

/** content-type 是不是 application/json（带不带 charset 都算）。 */
export function isJsonRequest(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  if (typeof ct !== 'string') return false;
  return ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

// --- 读 JSON 文件 ---

export type ReadResult =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'error'; error: string };

/**
 * 读失败（文件存在但读不动 / parse 不了）必须让调用方看见 error，绝不吞成 missing——
 * 客户端把 missing 当「首次启动」就会拿种子数据把用户真实数据覆盖掉。
 */
export async function readJson(filePath: string): Promise<ReadResult> {
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
    return { status: 'error', error: `解析 ${path.basename(filePath)} 失败：${err?.message || String(err)}` };
  }
}

// --- 局域网地址 ---

/**
 * 本机所有非 internal 的 IPv4 地址。二维码 / 入口 URL 用。
 * 不用 `server.resolvedUrls`：在 configureServer 里同步读它还是 null。
 *
 * 跳过 Windows 上 Hyper-V / WSL 的虚拟交换机（接口名 `vEthernet (…)`，通常是 172.x 段）：
 * 这些地址手机根本路由不到，扫了只会白扫。只按接口名前缀这一条规则筛，不做网段猜测。
 */
export function localIPv4Addresses(): string[] {
  const out: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    if (/^vEthernet/i.test(name)) continue;
    for (const info of nets[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  return out;
}
