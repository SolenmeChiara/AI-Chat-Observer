# PHONE_VIEWER_PLAN — 手机观众模式（局域网实时观看 + 发消息）

状态：设计定稿，施工中（2026-09-06）
前置：LOCAL_STORAGE_PLAN.md 已上线（数据在 `data/`，所有会话写入经 `server/localdb.ts` 收敛）。
不引入新进程；新增依赖仅 `qrcode`（服务端生成二维码 SVG）。

## 0. 目标与范围

Sol 的需求：在手机浏览器上同步看电脑端正在跑的群聊，最好还能发一条消息。

v1 做：
- 手机打开 `http://<电脑局域网IP>:5173/viewer?token=…`，实时看到电脑端当前会话（含流式打字机效果、思考链、图片），可切到别的会话只读浏览。
- 手机能发纯文本消息（支持 @提及），消息由电脑端吸收后按正常路径入流；电脑端自动播放开着时 AI 自然接话。
- 手机上看得到「电脑在线 / 自动播放中 / 正在生成：xxx」。
- 局域网访问是显式开关（`npm run dev:lan`），带共享 token；API key 与人设永远不出电脑。

v1 不做（见 §9）：手机传附件、自动播放关闭时的远程触发、电脑离线时的消息暂存、HTTPS、Tailwind 本地化。

## 1. 侦察结论（2026-09-06，三份报告精华）

**App.tsx（挂点地图）**
- 流式增量没有独立 state，直接函数式写进 `sessions[].messages[].text`（`App.tsx:1249-1251` / `2060-2063`），并带 `isStreaming` 标记（`types.ts:130`，占位创建 `App.tsx:1259-1262`，收尾清除 `2363`）。→ 半截内容随 ≤2s 的落盘一起进文件，手机盯文件写入事件即可，不需要单独流式通道。
- `handleUserSend`（`App.tsx:2624-2834`）纯追加、不触发任何 agent；触发全在 autoplay effect（`2934-3280`），第一行 `if (!isAutoPlay) return`，且只看 `activeSession.messages`。→ 手机消息只有进「电脑端当前会话」且自动播放开着才会有人接。
- 用户 Message 构造在 `2766-2775`：`id: Date.now().toString()`（有碰撞风险）、`senderId: USER_ID`（`constants.ts:4`）、用户资料全局一份（`settings.userProfiles` + `activeProfileId`）。
- `activeGroupId` / `activeSessionId`（`App.tsx:165/167`）、`isAutoPlay`（`200`）、`processingAgents`（`204`）都是纯内存态，不持久化；重启后落回 `session-1`。→ 手机要知道电脑在看哪个会话，只能靠电脑端主动上报。
- 复用 App.tsx 做观众端不可行：启动即 `GET /api/db/all`（本机 60 MB）；禁言到期 `setInterval`（`1023-1055`）无条件每 60s 跑且会写消息；旧会话批量改名 effect（`1079-1104`）启动即遍历所有会话调 API。
- 4 处闭包式 `setSessions`（`App.tsx:450-451`、`459-460`、`519`、`524-526`）会在几十毫秒窗口内吞掉外部追加的消息 → 改函数式，纯机械。
- SSE 回调里不能直接 `triggerAgentReply`（同 tick 旧闭包，`App.tsx:2908-2915` 记录过同样的坑）。v1 不远程触发，天然规避。

**ChatBubble / 入口**
- 真实入口是 `src/main.tsx`（根目录 `index.tsx` 是死代码），无任何外层 Provider；`I18nProvider` 在 `App.tsx:3339` 内部；`useT()` 无 Provider 时回退模块级 locale，不崩。主题是直接改 `document.documentElement.classList`（`App.tsx:336-341`）。
- `ChatBubble.tsx:12-26`：13 个 props 只有 `message` 必填；依赖仅 `types` / `USER_ID` / `useT` / `marked` / `DOMPurify` / `lucide-react`，无 service、无 db。`onDelete`/`onPlayTTS` 不传则按钮不渲染；但引用按钮（`:305`）和 @Ta（`:308`）无条件渲染，操作栏靠 hover（`:170-173`、`:294` `opacity-0`）——触屏上是隐形可点按钮。→ 加 `readOnly` prop 整条操作栏不渲染。
- `React.memo` 比较器（`:370-377`）是引用比较，`DOMPurify.sanitize` 裸跑在 render 里（`:283`）→ 手机端合并消息时必须保留未变化消息的旧对象引用。
- 消息列表（`App.tsx:3565-3598`）33 行、无虚拟化、无日期分隔；滚动到底逻辑 `370-403`；发送框相关 `2573-2622`（@提及解析/选择/键盘）、`3715-3747`（@弹窗）、`3799-3821`（textarea + 发送）。
- 附件 base64 内联在 `Message.attachments[].content`（`types.ts:99-106`），文档还多存 `textContent` + `visionDescription`；`reasoningText`/`reasoningSignature` 也内联。本机最大会话 24 MB，中位约 300 KB。→ 服务端必须提供剥附件的尾部读取端点。
- `src/index.css:36-58` 已有 `100dvh`、`.pb-safe`、橡皮筋禁用、640px 以下按钮 44px 最小尺寸。
- Tailwind 走 `https://cdn.tailwindcss.com`（`index.html:11`），无 `postcss.config.js`，`dist` 产物里 `@tailwind` 指令原样保留 → 手机所在网络必须能上外网才有样式（与电脑现状一致）。

**服务端**
- `server/localdb.ts` 是单个 connect 中间件手写路由（`:322-412`）；`configureServer`/`configurePreviewServer`（`:434-440`）直接 `server.middlewares.use`，跑在 Vite 内建中间件之前；匹配的路径不 `next()` → preview 的 compression（`dep-*.js:66295`，且它不认 `no-transform`）碰不到 `/api/*`；dev 无 compression；无响应超时。SSE 可行。
- `handlePut`（`:285-309`）：`readBody` → `JSON.parse` 校验 → `serializeByPath(atomicWrite(JSON.stringify(parsed,null,2)))`。所有会话写入（含导入）在此收敛 → SSE 广播钩子放 `:302-308`（写成功之后），parsed 对象顺手进缓存。
- `isRequestAllowed`（`:85-117`）：A 回环闸门（`ACO_ALLOW_LAN` 控制；对端回环 + Host 回环）、B Origin 同源（永远生效）。`:66-70` 注释已指定二期改这一处。
- 无 `GET /api/db/sessions/:id`；`GET /api/db/all` 连 `providers.json`（明文 key）一起吐。
- Vite 5.4.21 / Node 22.18。`appType` 默认 spa，`/viewer` 会拿到 index.html。`server.host` 未设（仅回环）。`hostCheckMiddleware` 对纯 IPv4 Host 直接放行。局域网 IP 用 `os.networkInterfaces()` 自取（`server.resolvedUrls` 在 `configureServer` 内同步读是 null）。
- `qrcode` 不在依赖里；`ws` 只是 Vite 的传递依赖，不能用。

## 2. 总体架构

```
手机浏览器 /viewer (ViewerApp)           电脑浏览器 localhost:5173 (App)
   │ GET /api/view/bootstrap                 │ 正常保存：PUT /api/db/sessions/:id
   │ GET /api/view/sessions/:id?tail|from    │ POST /api/live/presence（当前会话/自动播放/生成中）
   │ SSE /api/live/events?token=…            │ SSE /api/live/events?role=desktop
   │ POST /api/live/inbox {sessionId,text}   │   ← inbox 事件 → appendUserMessage() → 正常保存
   └──────────────┬──────────────────────────┘
                  ▼
        Vite 插件（server/localdb.ts + server/live.ts）
        - 会话文件唯一写者是电脑端；手机永远不写 data/
        - PUT 落盘成功 → 更新会话缓存 → 广播 session 事件
        - inbox 只转发给电脑端连接，不落盘
        - 角色判定：loopback（全权）/ lan（只读视图 + inbox）/ 拒绝
```

三条数据流：

1. **观看**：手机 bootstrap 拿 agents/groups/会话索引/用户资料/presence → 拉当前会话尾部 200 条 → 收到 `session` 事件后按 `from` 增量拉 → 合并（按 id 替换，未变化的保留旧引用）。
2. **发消息**：手机 POST inbox → 服务端校验（token、必须是电脑当前会话、电脑在线、限速）→ 经 SSE 转给电脑端 → `appendUserMessage(sessionId, {id, text})` → React state → 正常 debounce 落盘 → PUT → `session` 事件 → 手机看到自己的消息（此前手机本地先乐观显示「发送中」）。
3. **presence**：电脑端在 `activeSessionId / activeGroupId / isAutoPlay / processingAgents` 变化时 POST（200ms 防抖）；服务端合并「电脑端 SSE 连接是否存在」得出 `desktopOnline` 后广播给手机。

关键不变量：**会话文件只有电脑端一个写者**。手机消息不直接进文件，避免双写者互相覆盖；电脑不在线时手机发不出（503），不做暂存。

## 3. 服务端 API 契约

### 3.1 角色判定（替换 `isRequestAllowed`）

```ts
type Role = 'loopback' | 'lan';
function resolveRole(req, url): Role | null
```
1. Origin 校验（永远生效，沿用现有逻辑）：有 `Origin` 头则 `new URL(origin).host` 必须等于 `Host` 头，否则 null。
2. 对端 remoteAddress 回环 **且** Host 主机名回环 → `'loopback'`。
3. 否则若 LAN 已开启（`config.mode === 'lan'` 或 `ACO_ALLOW_LAN === '1'`）：Host 主机名必须是 IP 字面量（`net.isIP() !== 0`）**或以 `.ts.net` 结尾**（Tailscale MagicDNS；两者都挡 DNS rebinding——攻击者域名既不是 IP 也拿不到 ts.net 子域）**且** token 校验通过（`Authorization: Bearer <token>` 或 SSE 用 `?token=`，`crypto.timingSafeEqual`）→ `'lan'`。注意这一步不要求对端非回环：`tailscale serve` 反代时请求从 127.0.0.1 进来、Host 是 `xxx.ts.net`，就该落到这里。
4. 其他 → null → 403 `{ error }`。

**Tailscale 是首选通路（Sol 2026-09-06 指定）**：手机与电脑都装 Tailscale，走 WireGuard 加密隧道，只有 Sol 自己的设备能到达。两种用法都要支持：
- 直连 Tailscale IP：`http://100.x.y.z:5173/viewer?token=…`（需要 `dev:lan` 绑定所有接口；Host 是 IP 字面量）。
- `tailscale serve https / http://127.0.0.1:5173`：`https://<机器名>.<tailnet>.ts.net/viewer?token=…`（HTTPS、Vite 可只听回环；Host 是 `.ts.net`）。
普通局域网 IP 仍然可用，只是不推荐。

授权矩阵：

| 路径 | loopback | lan |
|---|---|---|
| `/api/db/*`（现有全部） | ✅ | ❌ 403（providers 永远不服务给局域网，比「剥 apiKey」更强） |
| `GET /api/live/lan-info` | ✅ | ❌ |
| `POST /api/live/presence` | ✅ | ❌ |
| `GET /api/live/events` | ✅（`?role=desktop` 标记电脑端） | ✅ |
| `POST /api/live/inbox` | ✅ | ✅ |
| `GET /api/view/*` | ✅ | ✅ |

### 3.2 端点

**`GET /api/live/lan-info`** → `{ enabled: boolean, port: number, token: string | null, entries: Array<{ kind: 'tailscale' | 'tailscale-serve' | 'lan', url: string, qrSvg: string, note?: string }> }`
- `entries` 按 kind 排序（tailscale 优先）：`tailscale` = `os.networkInterfaces()` 里 100.64.0.0/10 段的 IPv4 → `http://<ip>:<port>/viewer?token=…`；`tailscale-serve` = 若能跑 `tailscale status --json`（PATH 或 `C:\Program Files\Tailscale\tailscale.exe`，2s 超时，失败静默）取 `Self.DNSName`（去尾点）→ `https://<dnsname>/viewer?token=…`，`note` 说明需先执行 `tailscale serve https / http://127.0.0.1:<port>`；`lan` = 其余非内部 IPv4。`qrSvg` 为 `qrcode` 生成的 SVG 字符串。
- `enabled=false` 时 `entries=[]`、`token=null`，前端提示用 `npm run dev:lan` 启动。

**`POST /api/live/presence`**（body ≤ 64 KB，`application/json`）
```ts
interface PresenceReport { activeGroupId: string; activeSessionId: string; isAutoPlay: boolean; processingAgentIds: string[] }
```
服务端存最新一份，广播 `presence` 事件（见 3.3）。

**`GET /api/live/events`** → `text/event-stream`。响应头 `cache-control: no-store`、`x-accel-buffering: no`、`connection: keep-alive`；立即 flush 头；每 25s 写一行 `: ping` 注释保活。连接关闭时从集合移除。

**`POST /api/live/inbox`**（`application/json`，body ≤ 64 KB）
```ts
{ sessionId: string; text: string; clientId?: string }
```
校验顺序与返回：400（字段缺失 / text 空或 > 4000 字符）→ 503 `{ error: 'desktop-offline' }`（无 role=desktop 的 SSE 连接）→ 409 `{ error: 'not-active-session' }`（`sessionId !== presence.activeSessionId`）→ 429（滑动窗口：每连接来源 20 条/分钟）→ 202 `{ id }`。
`id = 'inbox-' + Date.now() + '-' + 6位随机`。事件只推给 desktop 连接，不落盘。

**`GET /api/view/bootstrap`**
```ts
{
  agents: Array<Pick<Agent, 'id' | 'name' | 'avatar' | 'role'>>,      // 渲染需要什么加什么；systemPrompt/model/providerId 等禁止
  groups: Array<Pick<ChatGroup, 'id' | 'name' | 'memberIds' | 'adminIds'>>,
  sessions: Array<{ id: string; groupId: string; name: string; lastUpdated: number; messageCount: number }>,
  settings: { userProfiles: Array<{ id; name; avatar }>; userName; userAvatar; expandAllReasoning; language; darkMode },
  presence: PresenceState
}
```
会话索引首次请求时解析 `data/sessions/*.json` 一遍建立（本机约 60 MB，秒级，只做一次），之后随 PUT/DELETE 增量更新。

**`GET /api/view/sessions/:id?tail=N`** 或 **`?from=i[&to=j]`**（`to` 不含，默认 total；N、范围上限 500）
```ts
{ id, groupId, name, lastUpdated, total: number, from: number, messages: ViewMessage[] }
```
`ViewMessage` = `Message` 做以下裁剪：`attachments[]` 中图片的 `content` 替换为 `/api/view/sessions/:id/attachments/:messageId/:index`（ChatBubble `<img src>` 直接可用），文档附件 `content: ''`；删除 `textContent`、`visionDescription`、`reasoningSignature`。其余字段（`isStreaming`、`reasoningText`、`replyToId`、`pmTargetId`、`isSystem`、`isError`…）原样。
服务端保留一个小 LRU（3 个）完整会话缓存；PUT 时若该 id 在缓存或等于 `presence.activeSessionId`，用 parsed 对象直接刷新，避免二次 parse。

**`GET /api/view/sessions/:id/attachments/:messageId/:index`** → 解码 base64 按 `mimeType` 返回字节，`cache-control: private, max-age=86400`（消息 id 不变则内容不变）。非图片或越界 404。

**`DELETE /api/db/sessions/:id`** 现有端点：成功后更新索引/缓存并广播 `session` 事件带 `deleted: true`。

### 3.3 SSE 事件（`event:` 名 + JSON `data:`）

| 事件 | 收件人 | data |
|---|---|---|
| `hello` | 全部 | `{ role, presence: PresenceState, serverStartedAt }` |
| `session` | 全部 | `{ id, groupId, name, total, lastUpdated, deleted?: true }`（每次会话 PUT/DELETE 落盘成功后） |
| `presence` | 全部 | `PresenceState = PresenceReport & { desktopOnline: boolean; updatedAt: number }` |
| `inbox` | 仅 desktop | `{ id, sessionId, text, receivedAt }` |

`desktopOnline` = 存在 `role=desktop` 连接；desktop 连接断开后延迟 5s 再广播 offline（给 EventSource 自动重连留窗口）。

### 3.4 LAN 开关与 token

- `package.json` 新增 `"dev:lan": "vite --mode lan"`、`"preview:lan": "vite preview --mode lan"`。插件 `config(config, { mode })` 钩子：`mode === 'lan'` 或 `ACO_ALLOW_LAN === '1'` 时启用 LAN，在 `server.host` / `preview.host` 未设置时置为 `true`，并把 `'.ts.net'` 加进 `server.allowedHosts` / `preview.allowedHosts`（否则 Vite 自带的 hostCheck 会把 MagicDNS 主机名的 index.html 请求挡掉；纯 IPv4 Host 它本来就放行）。默认 `npm run dev` 行为不变（只监听回环，局域网一律 403）。
- token：首次以 LAN 模式启动时生成 24 字节随机数（base64url），存 `data/lan-token.txt`；之后复用（二维码稳定）。想作废就删这个文件重启。启动时终端打印一次入口 URL。
- 现有 `ACO_ALLOW_LAN=1` 语义从「裸放行」改为「按 3.1 走 lan 角色」，不再存在把 key 暴露到局域网的路径。

## 4. 电脑端改动

**4.1 `appendUserMessage`（App.tsx）** — 从 `handleUserSend` 抽出可编程入口：
```ts
appendUserMessage(sessionId: string, input: {
  text: string; id?: string; replyToId?: string; pmTargetId?: string;
  asNarrator?: boolean; attachments?: Attachment[]; parseCommands?: boolean;   // 默认 false
}): boolean   // false = 会话不存在 / id 已存在（去重）
```
- 语义 = 现在 `App.tsx:2759-2823` 的主体：构造 Message、`parseCommands` 为真时才解析 `/roll` `/tarot`、函数式 `setSessions` 定位到 `sessionId`（不是 `updateActiveSession`）、`lastUpdated`、清 `yieldedAgentIds`。不碰输入框/附件/引用等 UI state。
- `handleUserSend` 保留 `/search` 分支与 UI 清理，中间换成 `appendUserMessage(activeSessionId, { ..., parseCommands: true })`。
- 用 `useCallback` + ref 暴露给 SSE 回调，避免旧闭包。
- 本地消息 id 保持 `Date.now().toString()` 不动（不改现有行为）；inbox 消息用服务端给的 `inbox-…` id。

**4.2 `services/liveBridge.ts`（新）** — `useLiveBridge({ enabled, report: PresenceReport, onInbox })`
- `enabled = isDbLoaded && getStorageMode() === 'file'`。
- 开 `EventSource('/api/live/events?role=desktop')`；`open` 时立即 POST 一次 presence；`report` 变化 200ms 防抖 POST；`inbox` 事件 → `onInbox`（经 ref 调用最新的 `appendUserMessage`）。
- 不在本 hook 里触发任何 agent。
- 网络错误只 `console.warn`，绝不影响主流程。

**4.3 4 处闭包式 `setSessions` 改函数式**：`App.tsx:450-451`、`459-460`、`519`、`524-526`（选下一个 activeSessionId 的读闭包保留，只改写入）。

**4.4 Sidebar「📱 手机观看」** — 备份按钮旁加一个按钮，打开 `components/PhoneViewerModal.tsx`：请求 `/api/live/lan-info`；`enabled` 时显示二维码（`qrSvg` 内联）+ URL 文本 + 一句安全提示（同一 WiFi 的人拿到这个链接就能看聊天、发消息；换 token 删 `data/lan-token.txt`）；否则显示「当前只监听本机，用 `npm run dev:lan` 启动才能开放局域网」。i18n 新 key 只由本模块加。

## 5. 手机端 `viewer/ViewerApp.tsx`

- 入口：`src/main.tsx` 判 `location.pathname === '/viewer'` → `import('../viewer/ViewerApp')` 懒加载（电脑端 bundle 不变，手机不加载 App）。
- 文件：`viewer/ViewerApp.tsx`（UI）、`viewer/viewerClient.ts`（token / fetch / SSE / 合并逻辑）、`viewer/strings.ts`（自带 zh/en 小词典，读 bootstrap 的 `settings.language`；**不改 `i18n.tsx`**，避免与 4.4 冲突）。
- token：URL `?token=` → 存 `localStorage['aco-viewer-token']` → `history.replaceState` 去掉 query；fetch 带 `Authorization: Bearer`，EventSource 用 `?token=`。无 token / 401 / 403 → 提示页「请在电脑端点『手机观看』扫码」。
- 状态：`bootstrap`、`presence`、`followDesktop`（默认 true；presence 的 `activeSessionId` 变化即切换）、`viewingSessionId`、`messages`、`total`、`from`、`pending`（乐观显示的本地消息）。
- 拉取协议：进入会话 `?tail=200`；收到 `session` 事件（id 匹配当前会话）→ 若 `total < 已知 total` 整体重拉尾部；否则 `?from=max(from, known-8)`，响应第一条 id 与本地对应位置不一致 → 整体重拉。合并按 id 替换，未变化（`text`、`isStreaming`、`reasoningText`、`isError` 相同）的保留旧对象引用。「加载更早」按钮用 `?from=&to=` 往前翻 200。
- 渲染：复用 `ChatBubble`，传 `readOnly`、`isStreaming={!!msg.isStreaming}`、`sender` 从全量 agents 找、`allAgents` = 该会话所属 group 的 memberIds 对应 agents、`userProfile` = bootstrap.settings 拼成的 `GlobalSettings` 子集（类型上做 cast 或 ChatBubble 把 `userProfile` 放宽为 `Pick<…>`）。列表 + 滚动到底照抄 `App.tsx:3565-3598` / `370-403`。
- 头部：会话名 + 会话下拉（按 group 分组）+ 「跟随电脑」开关 + 状态条（在线点、自动播放、正在生成：名字列表）。
- 发送框：textarea + 发送按钮（手机不做 Enter 发送）+ @弹窗（照抄 `2573-2622` / `3715-3747`，统一用 sessionMembers）。可发条件：`presence.desktopOnline && viewingSessionId === presence.activeSessionId`；不满足时禁用并显示原因。发出后 pending 显示，收到含该 id 的消息后移除；409/503 显示错误并保留文本。
- 主题：跟随 `settings.darkMode` 改 `documentElement.classList`。
- 断线重连：EventSource `open` 时若非首次 → 重拉 bootstrap + 当前会话尾部。
- `ChatBubble` 改动（唯一）：新增 `readOnly?: boolean`——为真时不挂 hover 处理、整条操作栏不渲染、跳过 data-URL→blob 的 effect（content 可能是 http URL）。

## 6. 局域网安全（规则与理由）

威胁模型：同一 WiFi 上的其他设备；手机或电脑浏览器里打开的恶意网页；分享出去的链接/截图。

| 风险 | 对策 | 在哪 |
|---|---|---|
| 局域网里任何人读聊天、读 key | 默认只监听回环；LAN 需显式 `dev:lan`；LAN 角色根本没有 `/api/db/*`，providers 永不出机；agents 只出 id/name/avatar/role | §3.1 矩阵 |
| 拿到 IP 的人直接访问 | 共享 token（24 字节随机，常数时间比较）；二维码只在电脑端本机页面显示 | §3.4 |
| 恶意网页借用户浏览器打局域网地址（CSRF） | Origin 同源校验永远生效；跨源 GET 没有 CORS 头读不到响应；inbox 只收 `application/json` | §3.1 步骤 1 |
| DNS rebinding（攻击者域名解析到 192.168.x.x） | loopback 角色要求 Host 是回环名；lan 角色要求 Host 是 IP 字面量——rebinding 请求的 Host 必然是攻击者域名 | §3.1 步骤 2/3 |
| token 泄漏 | 删 `data/lan-token.txt` 重启即作废；`.gitignore` 已覆盖 `data/` | §3.4 |
| 明文 HTTP 被同网嗅探 | 首选 Tailscale：WireGuard 隧道端到端加密，且只有 Sol 自己 tailnet 里的设备能到达；`tailscale serve` 还能直接给 HTTPS。普通局域网 IP 是退路，不建议在公共/访客网络用 | §3.1 / §9 |
| 手机滥发消息刷 API 费用 | inbox 限速 20/分钟；只能进电脑当前会话；无远程触发 | §3.2 |

## 7. 分工与并行施工

三个 opus 实现员各自 worktree，互不重叠的文件集；契约以本文 §3-§5 为准，接口不得擅改（要改先写进报告的「偏离点」）。

| 工位 | 文件 | 要点 |
|---|---|---|
| W1 服务端 | `server/localdb.ts`、`server/live.ts`（新）、`server/http.ts`（新，共享 sendJson/readBody/resolveRole/token）、`vite.config.ts`、`package.json`（`qrcode` + `@types/qrcode` + 两个脚本） | §3 全部；PUT 钩子；会话索引/缓存；LAN 开关 |
| W2 电脑端 | `App.tsx`、`services/liveBridge.ts`（新）、`components/Sidebar.tsx`、`components/PhoneViewerModal.tsx`（新）、`i18n.tsx` | §4 全部 |
| W3 手机端 | `viewer/*`（新）、`src/main.tsx`、`components/ChatBubble.tsx` | §5 全部 |

W2/W3 在 W1 未合并时用本文契约自测（W3 可在 worktree 里写一个最小 mock 中间件或用固定 JSON 文件模拟；W2 的 hook 对 SSE 不可用时只 warn）。三者合并后由集成审查员做端到端。

## 8. 验证方案

红线：不碰 5173、不碰 `data/`、不 commit/push。临时实例：`ACO_DATA_DIR=<scratch>/data npx vite --port 51xx --mode lan`，用脚本先往临时目录塞 2-3 个合成会话（其中一个含 base64 小图和 `isStreaming` 消息）。

- 静态：`npx tsc --noEmit -p tsconfig.json`、`npx tsc --noEmit -p tsconfig.node.json`、`npx vite build --outDir <scratch>/dist`。
- 闸门：本机 `curl http://127.0.0.1:51xx/api/db/all` 200；`curl http://<本机局域网IP>:51xx/api/db/all` 403（对端非回环）；带正确 token 打 `/api/view/bootstrap` 200 且响应里 grep 不到 `apiKey` / `systemPrompt`；错 token 403；`Host: evil.example` 403；带跨源 `Origin` 403；模拟 `tailscale serve`：从 127.0.0.1 发、`Host: foo.tail1234.ts.net` + 正确 token → `/api/view/bootstrap` 200 而 `/api/db/all` 403。
- SSE：node 脚本连 `/api/live/events`，另起 curl PUT 一个会话，脚本收到 `session` 事件；desktop 连接断开 5s 后收到 `presence.desktopOnline=false`。
- inbox：无 desktop 连接 → 503；desktop 连上、presence 指向会话 A，POST 到 B → 409，到 A → 202 且 desktop 收到 `inbox`。
- 视图：`?tail=2` 返回最后两条、图片附件 `content` 是 URL、附件端点返回正确 `content-type`；`?from` 越界得空数组。
- 手机端 UI：集成阶段主循环用 Chrome MCP 在临时端口以 `/viewer?token=` 打开，走一遍观看/切换/发送；最后 Sol 用真手机验收。

## 9. 遗留与后续

- 手机传图（走 `parseFile`/压缩，base64 进会话文件）。
- 自动播放关闭时的远程触发（inbox 加 `kind: 'trigger'`，电脑端用「看到标记的 effect」触发而非 SSE 回调内直接调）。
- 电脑离线时的 inbox 暂存（`data/inbox.json`，启动时消化）。
- Tailwind 本地化（补 `postcss.config.js`，删 CDN；要过一轮视觉回归）——无外网的局域网场景才需要。
- HTTPS / 局域网域名（Vite `allowedHosts`）。
- 已知：电脑端要用 `localhost` 打开；从本机用局域网 IP 打开会被当作 lan 角色，主界面拿不到 `/api/db/*`。
