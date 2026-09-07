# 手机远程动作通道（Phone Remote Actions）施工档案

> 状态：设计定稿，待施工。起草 2026-09-07，侦察基于 HEAD 4787603（记忆归档改造之后的行号可能偏移，以符号名为准）。
> 前置：`PHONE_VIEWER_PLAN.md`（观众模式一期 + 二期遥控）。本档案沿用其安全约束（§6）与验证方法（§8、§12.4）。
> Sol 拍板：电脑标签页常开，手机是遥控器，不做「电脑关掉手机也能用」。

## 0. 一句话

把二期的 `control` 通道泛化成**动作通道**：手机发 `{type, payload}`，服务端校验后经 SSE 只推给电脑那一页，
电脑 App 用既有 handler 执行，结果经服务端广播回手机。电脑标签页仍是唯一状态源；API key 永不下发。
第一批动作：发消息（含私讯 / 回复）、切会话、群成员增删、禁言 / 解禁、改 agent 提示词与模型、新建 agent、让 TA 发言。

## 1. 现状（侦察结论摘要）

- 通道：`POST /api/live/control`（live.ts `handleControl`）→ 400/503/409/429/202 → `broadcast('control', …, c => c.isDesktop)`；
  desktop 身份 = SSE 建连时 `role === 'loopback' && ?role=desktop`。电脑侧 `services/liveBridge.ts` 用 EventSource 收 `control`，
  App.tsx `handleControlEvent` 只认 `autoplay`。
- 读侧：`GET /api/view/bootstrap` 投影 agents 只出 `id/name/avatar/role`，groups / settings 有白名单，**从不读 providers.json**；
  `GET /api/view/sessions/:id` 只出消息（去 `reasoningSignature`、附件投影）。agents / groups 变化**没有任何 SSE 事件**，手机端只在启动时拉一次 bootstrap。
- 鉴权：`server/http.ts resolveRole`（Origin 同源 → loopback → lan 需 Host 为 IP/.ts.net + token 常数时间比对）。
- 电脑端 handler：`appendUserMessage(sessionId, {text, pmTargetId?, replyToId?, parseCommands?})`、`handleSwitchSession(id)`、
  `handleActivateAgent(id)` / `handleRemoveAgent(id)`（隐式作用于 `activeGroupId`）、`handleMuteAgent(agentId, minutes, mutedBy)` /
  `handleUnmuteAgent(agentId)`（隐式作用于当前会话）、`handleAddAgentFromRightSidebar(providerId, modelId)`、`triggerAgentReply(agentId)`。
  **agent 的增删改没有 App 层 handler**，全在 `components/Sidebar.tsx` 里直接 `setAgents`。
- 敏感字段不止 `providers.json` 的 `apiKey`：`Agent.searchConfig.apiKey`（在 agents.json 里）、`TTSProvider.apiKey`（settings 侧）。
- 手机端 `viewer/ViewerApp.tsx` 单组件（~980 行），消息气泡复用 `components/ChatBubble`，i18n `viewer/strings.ts` 单表 en。
  `/viewer` 无独立 HTML 入口，靠 `src/main.tsx` 的 pathname 分流。
- 验证资产：`mofalajidui/viewer-mock/`（mockLive.ts + vite.mock.config.ts，gitignored）供 viewer 单独联调。

## 2. 设计决策（定稿）

### 2.1 作用域规则：动作只作用于电脑当前激活的群组 / 会话

除 `session.switch` 外，所有会话级 / 群级动作都要求 `payload.sessionId === presence.activeSessionId`，否则 409 `not-active-session`
（与二期 control 同一条规则）。理由：既有 handler 隐式依赖 `activeGroupId` / `activeSession`，不改它们的签名；
手机要改别的群，先切过去。agent 级动作（`agent.update` / `agent.create`）不带 sessionId，不受此限。

### 2.2 契约：`POST /api/live/action`

请求：`application/json`，body ≤ 64 KB（沿用 `SMALL_BODY_BYTES`）。
```ts
{ id?: string;            // 手机生成的 clientActionId（可选，服务端会覆盖成自己的 id 并在响应里返回）
  type: ActionType;
  sessionId?: string;     // 会话级动作必填
  payload: object }       // 按 type 校验，见 2.3
```
响应：`202 { id }`（已转发） / `400 bad-request`（形状或字段不合法，body 里带 `field`） / `405` / `503 desktop-offline` /
`409 not-active-session` / `429 rate-limited` / `403`（鉴权失败由中间件给）。
限流：独立桶 `action:<remoteAddress>`，**30 次 / 分钟**（常量单独命名 `ACTION_MAX_PER_WINDOW`，别再复用 INBOX 那对）。
广播：`broadcast('action', { id, type, sessionId, payload, receivedAt }, c => c.isDesktop)`。

角色：loopback + lan（与 control 相同）。

### 2.3 动作类型与 payload 校验（服务端做形状校验，电脑端做语义校验）

| type | sessionId | payload | 服务端校验 | 电脑端执行 |
|---|---|---|---|---|
| `message.send` | 必填 | `{ text: string; pmTargetId?: string; replyToId?: string; parseCommands?: boolean }` | text 非空 ≤ 20000 字符；id 字段 ≤ 128 | `appendUserMessage(sessionId, {...})`；pmTargetId 必须是群成员或 `'user'`，否则失败 |
| `session.switch` | 必填（目标） | `{}` | — | `handleSwitchSession(sessionId)`（会话不存在 → 失败）。注意它会 `setIsAutoPlay(false)`，与电脑端行为一致 |
| `group.member.add` | 必填 | `{ agentId }` | id ≤ 128 | `handleActivateAgent(agentId)`；agent 不存在 → 失败 |
| `group.member.remove` | 必填 | `{ agentId }` | 同上 | `handleRemoveAgent(agentId)` |
| `agent.mute` | 必填 | `{ agentId; durationMinutes: number }` | 0 ≤ minutes ≤ 10080，整数 | `handleMuteAgent(agentId, minutes, mutedBy)`，`mutedBy` = `settings.userName || 'User'` 加后缀「（手机）」 |
| `agent.unmute` | 必填 | `{ agentId }` | — | `handleUnmuteAgent(agentId)` |
| `agent.trigger` | 必填 | `{ agentId }` | — | `triggerAgentReply(agentId)`；agent 不是群成员或正在处理中 → 失败 |
| `agent.update` | 不带 | `{ agentId; patch: AgentPatch }` | patch 只允许 2.4 的白名单键，未知键 400；systemPrompt ≤ 64000 字符；name ≤ 100 | 新增 App 层 `applyRemoteAgentPatch`（2.4） |
| `agent.create` | 不带 | `{ providerId; modelId; name?: string; systemPrompt?: string; joinActiveGroup?: boolean }` | 同上限 | 复用 `handleAddAgentFromRightSidebar` 的构造逻辑（抽成可复用函数），再 patch name/prompt；`joinActiveGroup` 为真时随后 `handleActivateAgent` |

`AgentPatch` 白名单（2.4）之外的任何键（尤其 `searchConfig`、`voiceId`、`providerId` 以外的凭据类）一律 400。

### 2.4 `AgentPatch` 与 App 层 agent handler

```ts
type AgentPatch = {
  name?: string; systemPrompt?: string; providerId?: string; modelId?: string;
  color?: string; avatar?: string;
  config?: { temperature?: number|null; topP?: number|null; maxTokens?: number; enableReasoning?: boolean; reasoningBudget?: number };
  role?: 'MEMBER' | 'ADMIN'; mentionOnly?: boolean; enablePM?: boolean; commandMode?: 'native' | 'text';
};
```
App.tsx 新增 `applyRemoteAgentPatch(agentId, patch)`：
- agent 不存在 → 失败；`providerId` 若给出必须存在于 `providers`；`modelId` 若给出必须存在于（新的或原来的）provider 的 `models`；
  两者都不合法 → 失败，不做部分应用。
- `config` 做浅合并；其它字段直接覆盖。用 `setAgents(prev => prev.map(...))`。
- Sidebar 的 `updateAgent` 里如有「换 provider 时重置 modelId」之类的联动，这里要对齐（施工时读 Sidebar.tsx:686-738 照抄语义）。

### 2.5 结果回传：`POST /api/live/action-result`（loopback only）

电脑执行完（成功或失败）后 POST：
```ts
{ id: string; ok: boolean; error?: string; data?: object }   // data 只放 id 类信息（如新建的 agentId），不放任何内容体
```
服务端校验后 `broadcast('action-result', {...}, c => !c.isDesktop)`。手机端按 `id` 匹配等待中的动作，**8 s** 超时视为失败
（比 control 的 4 s 长，因为 `agent.trigger` 之类会真的等 handler 返回）。

### 2.6 目录变更事件：`catalog`

`server/localdb.ts` 的表 PUT 成功后（`agents` / `groups` / `settings` 三张），调用 live 的 `onTableWritten(table)` →
`broadcast('catalog', { table, at })` 给**全部**客户端。手机端收到后 300 ms 防抖重拉 `bootstrap`。
（sessions 已有 `session` 事件，不动。）

### 2.7 读侧投影扩展（`GET /api/view/bootstrap` 与 `GET /api/view/sessions/:id`）

**这是一次有意的策略变更**：一期规定「agents 只出 id/name/avatar/role」，现在 token 持有者需要读提示词才能编辑。
新的边界是：**凭据永不出机，提示词与配置可以**。

- `projectAgent` 扩成：`id, name, avatar, role, providerId, modelId, systemPrompt, color, config, mentionOnly, enablePM, commandMode, isActive`。
  **显式剔除** `searchConfig`（含 apiKey）、`voiceId`、`voiceProviderId`、`enableGoogleSearch`。写法用「白名单挑字段」不用「黑名单删字段」。
- 新增 `providers` 投影：`{ id, name, type, models: [{ id, name }] }`。**不含** `apiKey`、`baseUrl`、任何其它字段。服务端读 `providers.json`
  只在这一处，且读完立即投影，不把原对象放进任何缓存。
- `projectGroup` 补 `memberIds, adminIds, mentionOnlyIds, scenario`（如已有则不动）。
- `handleViewSession` 响应补 `mutedAgents`（`MuteInfo[]` 原样，不含敏感字段）。
- 一期验证里「bootstrap grep 不到 systemPrompt」这条**作废**，改为「grep 不到 `apiKey` / `baseUrl` / `searchConfig`」。

### 2.8 电脑端

- `services/liveBridge.ts`：新增 `action` 监听（逐字段校验后 `onActionRef.current?.(evt)`），新增 `postActionResult(result)`。
- App.tsx：`handleActionEvent(evt)`：按 `type` 查一张分发表，每个分支 `try { … ; result ok } catch { result ok:false, error }`。
  handler 一律经 ref 调用（沿用 `handleStopAllRef` 的写法），避免 SSE 闭包拿到旧函数。会话级动作先核对 `evt.sessionId === activeSessionIdRef.current`，
  不一致 → `ok:false, error:'not-active-session'`（服务端已挡一次，这里是双保险）。
- 不允许通过动作通道改 `providers` / `settings` / TTS，没有对应 type，服务端 400。

### 2.9 手机端

在 `viewer/ViewerApp.tsx` 现有单组件基础上加一个「管理」抽屉（底部弹出，全屏高度 90%），**拆成独立组件文件**放 `viewer/panels/`：
- `MembersPanel.tsx`：当前群成员列表（头像 / 名字 / 角色 / 禁言状态与剩余时间），每行操作：禁言（15 分钟 / 1 小时 / 永久 三个快捷 + 解禁）、
  移出群、让 TA 发言；底部「添加成员」从非成员 agents 里选。
- `AgentEditPanel.tsx`：选一个 agent（默认当前群成员优先）→ 表单：名字、供应商（下拉，来自 bootstrap.providers）、模型（联动下拉）、
  提示词（textarea，自动高度）、温度 / 最大输出、mentionOnly / enablePM 开关、commandMode。保存 = 一次 `agent.update`，
  只提交改过的键。
- `AgentCreatePanel.tsx`：供应商 / 模型 / 名字 / 提示词 + 「加入当前群」开关 → `agent.create`。
- `SessionsPanel.tsx`：按群分组的会话列表 → `session.switch`（切换后 `followDesktop` 置回 true）。
- 发送区：在 textarea 旁加「私讯给…」选择器（群成员 + 「主持人/我」不需要）和「回复」（长按气泡 → 设置 replyToId，顶部显示引用条可取消）。
  发送走 `message.send`（不再走 inbox；inbox 端点保留不删）。
- `viewerClient.ts`：`sendAction(type, payload, sessionId?) → Promise<{id}>`；`connectLiveEvents` 新增 `onActionResult` 与 `onCatalog`；
  `fetchBootstrap` 类型补 providers 与扩展后的 agent 字段。
- 等待态：每个按钮按 actionId 显示 pending（沿用 control 的 `controlPending` 模式，做成通用的 `pendingActions: Map<id, {type, at}>`），
  结果 toast 2 s；失败显示 error 文案。
- `strings.ts` 加 key（中文原文即 key）。

### 2.10 安全（沿用一期 §6，增补）

- 凭据：`apiKey`（provider / searchConfig / TTS）、`baseUrl`、`lan-token` 永不进 bootstrap / action-result / catalog。验证矩阵必须 grep。
- 提示词出机：仅 token 持有者（lan 角色）可读；Sol 已知情（本档案即记录）。
- 动作通道：只有白名单 type；payload 形状与长度在服务端校验；语义（id 存在性、成员关系）在电脑端校验；结果广播只含 ok / error / id。
- 限流：`action` 独立桶 30/分钟；`rateHits` 无淘汰是既有遗留，本次顺手加「每次命中时清掉窗口外的时间戳，空桶删 key」（一行）。
- 作用域：会话级动作只作用于电脑当前会话（409）。
- `action-result` 只收 loopback；lan 角色 POST 它 → 403（中间件矩阵加进 `isLoopbackOnlyLivePath`）。
- CSRF / DNS rebinding / Origin：一期机制不变，新端点自动受保护（同一个中间件）。

## 3. 触点地图（file:symbol，行号以侦察时为准）

| 触点 | 位置 | 改法 |
|---|---|---|
| 鉴权矩阵 | `server/localdb.ts` 中间件 ~206-243；`server/live.ts isLoopbackOnlyLivePath` ~905 | `action-result` 加进 loopback-only |
| 路由表 | `server/live.ts` ~918-1006 | 加 `action`、`action-result` |
| control 处理 | `server/live.ts handleControl` ~390-437 | 不动；新 `handleAction` 仿它，校验表驱动 |
| 限流 | `server/live.ts rateLimitOk` ~319、常量 ~46 | 新常量 `ACTION_MAX_PER_WINDOW = 30`；顺手加窗口外淘汰 |
| SSE 客户端 | `server/live.ts SseClient` ~115、`broadcast` ~192 | 不动 |
| bootstrap | `server/live.ts handleBootstrap` ~712、`projectAgent` ~685、`projectGroup` ~689 | 扩投影；新增 `projectProvider`；读 `providers.json` |
| 会话读 | `server/live.ts handleViewSession` ~805 | 补 `mutedAgents` |
| 表 PUT 钩子 | `server/localdb.ts handlePut` ~151-188（已有 `onSessionWritten`） | 加 `onTableWritten(table)` |
| 电脑桥 | `services/liveBridge.ts` ~124-198 | 加 `action` 监听、`postActionResult` |
| 电脑分发 | `App.tsx handleControlEvent` ~2838、`useLiveBridge` ~2850 | 加 `handleActionEvent`；handler refs |
| App 层 agent handler | `App.tsx handleAddAgentFromRightSidebar` ~853；Sidebar `updateAgent` ~686 | 新 `applyRemoteAgentPatch`、`createAgentFromModel` |
| 手机客户端 | `viewer/viewerClient.ts`（`sendControl` ~291、`connectLiveEvents` ~315、事件绑定 ~345） | 加 `sendAction`、两个事件 |
| 手机 UI | `viewer/ViewerApp.tsx`（发送区 ~949、遥控按钮 ~792、presence ~378） | 抽屉入口 + `viewer/panels/*` |
| 手机 i18n | `viewer/strings.ts` | 加 key |
| 类型 | `types.ts Agent` 79-97、`ApiProvider` 24-26、`MuteInfo` 145 | 不改；动作契约放 `server/actionContract.ts`（**三方共用**：服务端、电脑端、手机端都 import 它。放 server/ 是因为 tsconfig.node.json 是 composite 工程，只能 import include 范围内的文件；文件内只有类型与纯常量） |

## 4. 不改的东西

- `control` / `inbox` 端点与事件：保留原样（inbox 留作兼容，手机端改走 `message.send`）。
- 供应商、API key、TTS、全局设置：不开放远程修改。
- 记忆归档（`MEMORY_COMPACTION_PLAN.md`）的字段：不进 bootstrap（手机不显示总结）。
- `parseCommands` 从手机默认仍为 false（与 inbox 一致），手机端不提供 `/roll` 之类入口。

## 5. 分工与并行施工

- **W1 服务端 + 电脑端**（一个 opus）：§2.2–2.8 全部。验证：curl 矩阵 + node SSE 脚本 + CDP 两标签页（电脑页 + 手机页）端到端。
- **W2 手机端**（一个 opus，独立 worktree）：§2.9，对着 §2.2–2.7 的契约开发，用 `mofalajidui/viewer-mock/mockLive.ts` 扩一个假动作服务端
  （收 action → 延迟 300 ms 广播 action-result；PUT 表 → 广播 catalog）联调。
- 契约文件 `server/actionContract.ts` 已由主循环按 §2.3/2.4 写好并随本档案提交，W1 / W2 直接 import，**不改它的形状**；确需改动写进报告的偏离点。
- 合并：W1 分支先进，W2 rebase 后进；独立 opus 审查做端到端（真服务端 + 真手机页）。

## 6. 验证方案

红线同一期：不碰 5173 / 生产 `data/` / 常驻进程；临时端口 + 临时 `ACO_DATA_DIR` + `--mode lan`（lan 模式才有 token 与 lan 角色）。

1. 静态：`npx tsc --noEmit`；`npx tsc --noEmit -p tsconfig.node.json`（服务端）。
2. 闸门（curl）：`action` 每个 type 一组 400（缺字段 / 超长 / 未知键）；405；无 desktop 503；presence 指 A 而 sessionId=B 409；正确 202；
   lan 无 token 403；lan 有 token 202；31 次/分钟第 31 次 429；`action-result` 从 lan 角色 403。
3. 泄漏：lan token 打 bootstrap，响应 `grep -c 'apiKey\|baseUrl\|searchConfig\|lan-token'` = 0；systemPrompt 存在。
4. SSE：node 脚本以 lan 角色连 events；另起 curl 发 action → 脚本不应收到 `action`（只 desktop 收）；desktop 脚本 POST action-result → lan 脚本收到 `action-result`；
   PUT agents 表 → 两边都收到 `catalog`。
5. 端到端（CDP 两标签页，电脑页 `role=desktop` 用回环地址、手机页用 `/viewer?token=`）：
   - 手机新建 agent 并加入当前群 → 电脑右栏出现成员 → 临时 `data/agents.json` 与 `groups.json` 更新 → 手机 bootstrap 自动刷新出现该 agent。
   - 手机改提示词 → 电脑 Sidebar 展开该 agent 显示新提示词。
   - 手机禁言 15 分钟 → 电脑右栏显示禁言；手机解禁 → 消失。
   - 手机切会话 → 电脑切过去且自动播放停止；手机 `followDesktop` 为真。
   - 手机私讯某 agent → 电脑消息带 `pmTargetId`，其他 agent 的下一次请求体不含该消息。
   - 手机「让 TA 发言」→ 电脑触发该 agent（mock 上游返回固定文本）。
   - 手机发不合法 patch（未知键）→ 400；发不存在的 agentId → 202 后 8 s 内收到 `ok:false`。
6. 回归：二期遥控自动播放（control）仍工作；inbox 仍工作；电脑端 Sidebar 编辑 agent 行为不变。
7. **界面效果（Sol 点名要求，W2 与审查都要做，不是一次性的）**：用手机视口（390×844 与 360×780 两档）截图，
   每个面板每种状态都要有图：抽屉关 / 开、成员列表（含禁言中与剩余时间）、编辑表单（长提示词撑开后）、新建表单、
   会话列表、私讯选择器展开、回复引用条、按钮 pending、成功 toast、失败 error、浅色与深色主题各一套。
   截图看完要真的改：文字截断、按钮挤压、键盘弹起遮住输入区、抽屉滚动与页面滚动打架、点击区域过小（< 40px）这些
   都算缺陷。施工中至少三轮「截图 → 改 → 再截图」，报告里附每轮的截图路径与改了什么。

## 7. 遗留 / 后续（本次不做）

- 非当前群 / 会话的远程操作（需要 handler 显式带 id）。
- 供应商与 key 管理、全局设置、TTS。
- 手机端显示总结 / 记忆面板。
- `/viewer` 独立 HTML 入口与生产构建的多入口。
- 多手机同时操作的冲突提示（最后写的赢，与电脑端多标签页现状一致）。
