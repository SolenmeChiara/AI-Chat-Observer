# 记忆归档改造（Memory Compaction）施工档案

> 状态：已实现，待审查。起草 2026-09-07，施工 2026-09-07。
> 关联：`TOOL_LAYER_PLAN.md`（工具层）、`PHONE_VIEWER_PLAN.md`（观众端）。

## 0. 一句话

把「总结」从辅助信息升级为**归档边界**：归档之后模型只看到 `总结 + 边界之后的消息`，
最近 `keepRecent`（默认 5）条永远保留原文；私讯按参与 agent 各自归档成私人记忆；
用户界面照旧显示全部消息，只在边界处画一条分割线。

## 1. 为什么改

### 1.1 现状（HEAD = 4787603）

- 总结：`memoryConfig.threshold` 每满 N 条触发 `updateSessionSummary`，结果写入
  `session.summary`，经 `buildMemoryContext` 注入系统提示 memory 层。
- 历史：`filterVisibleMessages` 按 `settings.contextLimit` 切最近 N 条，STRIDE 量化锚点
  防止窗口头每条消息都挪动。
- 两套机制互不知情：
  - threshold 20 + contextLimit 20 → 窗口里约一半消息总结里也有，重复付费。
  - contextLimit < threshold → 出现一段**既不在总结、也不在窗口**的盲区。
- **已知 bug**：「总结到哪了」只存在 `lastSummaryCountRef`（内存 Map）。刷新页面或本次
  页面生命周期内第一次切进老会话，计数归零，条件立刻成立，整个会话从第 1 条起再合并进
  旧总结一遍。每刷一次多付一次全量总结费，总结越滚越糊。
- 缓存：窗口头每 STRIDE 条挪一次、总结每 threshold 条重写一次，两处各自打断前缀。

### 1.2 改后

- 边界持久化在 session 里，刷新/切会话不再重复归档。
- 两次归档之间历史纯追加、byte 稳定；总结重写与窗口头跳变发生在同一时刻，
  一次归档只打断一次缓存前缀。
- 盲区消失：边界之前的内容一定在总结里，之后的一定是原文。
- 私讯不再随窗口滑走，而是进各自的私人记忆。

## 2. 设计决策（定稿）

### 2.1 数据模型（types.ts）

```ts
interface MemoryConfig {
  enabled: boolean;
  threshold: number;        // 未归档消息达到 N 条时触发归档（含 keepRecent 那几条）
  keepRecent?: number;      // 新增：归档时保留最近 N 条原文不归档，默认 5
  summaryModelId: string;
  summaryProviderId: string;
  excludePM?: boolean;      // 语义调整见 2.5
  summaryMaxTokens?: number;
}

interface ChatSession {
  // ...既有字段
  summary?: string;                          // 公共总结（既有）
  summaryCutoffId?: string;                  // 新增：归档边界 = 最后一条已归档消息的 id
  summaryCutoffTs?: number;                  // 新增：同一条消息的 timestamp，id 找不到时兜底
  privateSummaries?: Record<string, string>; // 新增：agentId → 该 agent 的私人记忆
}
```

- 边界语义：`summaryCutoffId` 指向**最后一条已归档**的消息。发给模型的历史 = 严格在它之后的消息。
- 兜底顺序：按 id 找 → 找不到（消息被删）按 `timestamp > summaryCutoffTs` → 两者都没有 → 视为无边界。
- `lastSummaryCountRef` 删除，未归档条数从边界推导。

### 2.2 触发与归档流程（App.tsx 记忆 effect）

```
unsummarized = 边界之后的非 streaming 消息
if unsummarized.length < threshold → 返回
range = unsummarized[0 .. length - keepRecent)     // 保留尾巴
if range 为空 → 返回（threshold ≤ keepRecent 时的保护）
range = range.slice(0, ARCHIVE_BATCH_MAX)          // 单次上限 150 条，见 2.7
```

1. 公共总结：`updateSessionSummary(session.summary, adminNotes, excludePM ? range.filter(非PM) : range, ...)`。
2. 私人总结（仅 `excludePM` 为真时）：把 range 里的 PM 按参与 agent 分组
   （`senderId === agentId` 或 `pmTargetId === agentId`；人类 `USER_ID` 不生成私人记忆）。
   每个有 PM 的 agent 调一次 `updatePrivateSummary(existing, pms, newPublicSummary, ...)`。
   没有 PM 的归档一次额外调用都不发。
3. **原子提交**：公共 + 全部私人总结都成功后，一次 `setSessions` 同时写入
   `summary` / `privateSummaries` / `adminNotes: []` / `summaryCutoffId` / `summaryCutoffTs`
   （边界 = range 最后一条）。任一失败则**不推进边界**，本轮作废，等下次触发重试。
4. 并发保护：`summarizingSessionsRef: Set<sessionId>`，归档中不重复触发。
   失败后记 `lastArchiveFailAtRef`，60 秒内不重试，避免每来一条消息就撞一次失败的模型。
5. 归档完成后若 unsummarized 仍 ≥ threshold（老会话追赶），effect 会因 session 变化再次触发，
   逐批追上，见 2.7。

### 2.3 上下文拼接

规则只有一条：**群组开启记忆且 session 有有效边界 → 历史 = 边界之后的消息，`contextLimit` 不再参与。**
其余情况（记忆未开启 / 尚无边界）走既有 `contextLimit` 量化窗口，行为与 HEAD 完全一致。

- 侦察结论：`filterVisibleMessages` 在 App.tsx 里一次都没被调用，四个 adapter 各自调用一次
  （anthropicService.ts:72 / openaiService.ts:106、511 / geminiService.ts:115），实参一致。
  因此**不改 adapter 签名**，在 App.tsx 侧做两件事：
  1. `processedMessages`（App.tsx:1403 定义，1477 vision 代理 map）在定义处就先经
     `sliceAfterCutoff(messages, cutoff)` 裁掉边界之前的消息；
  2. 传给四个 adapter 的 `contextLimit` 实参改为 `effectiveContextLimit`：边界有效时为 `0`（adapter 内
     `contextLimit > 0` 守卫自动跳过量化切片），否则为 `settings.contextLimit`。
- `sliceAfterCutoff(messages, cutoff: {id?, ts?})` 放 `services/shared.ts`，纯函数：按 id 找到则返回其后；
  否则按 `timestamp > ts`；两者都无则原样返回。
- 图片生成路径（App.tsx:1523-1524 手写的 `visibleMsgs.slice(-(settings.contextLimit || 20))`）
  因为读的是已裁剪的 `processedMessages`，只需把 `|| 20` 的兜底改成「边界有效时不再切片」。
- 边界之前的 PM 不再出现在历史里（它们在私人记忆里）。
- 总结仍留在系统提示 memory 层，不搬进 messages。两种放法对缓存前缀的影响相同，留在原处改动最小。

### 2.4 memory 层注入

`buildMemoryContext(summary, adminNotes, privateSummary?)`：

```
[SHARED MEMORY]
Long-Term Summary: ...
Recent Admin Notes: ...
[PRIVATE MEMORY] (only you can see this; other members do not know its contents)
...
```

`privateSummary` 为空时不输出 `[PRIVATE MEMORY]` 段，保证没有私讯的 agent 的 memory 层 byte 不变。
memory 层本来就按 agent 生成（persona 在 stable 层），不新增缓存成本。

### 2.5 `excludePM` 语义

| excludePM | HEAD 行为 | 改后行为 |
|---|---|---|
| true（默认） | PM 不进总结，滑出窗口即丢 | PM 不进公共总结，按参与 agent 进私人记忆 |
| false | PM 混进公共总结，全员可见 | 不变（设计上的泄漏，可能有人故意要，保留） |

UI 文案随之更新：「私讯不进公共总结（各自记入私人记忆）」。

### 2.6 总结 prompt

- 公共 prompt（`updateSessionSummary`）：增加一句「这份总结将**替代**被归档的消息，模型之后看不到原文；
  事实、决定、人物关系、未了结的线索必须保留」。隐私条款不变。
- 私人 prompt（新函数 `updatePrivateSummary`）：输入 = 该 agent 已有私人记忆 + 本批 PM 行
  （带时间戳与「谁对谁」）+ 刚生成的公共总结作为只读背景；输出 = 新的私人记忆。
  明确要求：只记私讯内容，不复述公共总结；保留承诺、秘密、约定。
- 两个 prompt 都吃 `summaryMaxTokens`（默认 2000）。

### 2.7 老会话迁移（无需脚本）

- 老 session 没有边界 → 按 2.3 走既有 contextLimit 窗口，**升级瞬间行为不变**。
- 记忆开启的老会话第一次激活时 unsummarized = 全部消息 ≥ threshold，自动触发第一次归档。
  这一次会把整段历史（减去尾巴）合并进已有总结，与 HEAD 每次刷新都在干的事相同，只是最后一次。
- 单次归档上限 `ARCHIVE_BATCH_MAX = 150` 条：超长老会话分批追赶，避免一次塞爆总结模型的上下文。
  追赶期间每批推进一次边界，中途失败也只损失当批。

### 2.8 UI

- 记忆设置面板：新增「保留最近 N 条」数字输入（默认 5，范围 0–50），校验 `threshold > keepRecent`，
  不满足时提示但不阻止保存（运行时由 2.2 的空 range 保护兜底）。
- `contextLimit` 设置旁加一行提示：「开启记忆归档的群组以归档边界为准，此项不生效」。
- 聊天列表：在 `summaryCutoffId` 对应消息之后插入分割线「以上内容已归档进记忆」（i18n），样式沿用现有分割元素。
- 记忆面板：新增「立即归档」按钮，手动跑一次 2.2（同样保留尾巴、同样原子提交）。
  归档中按钮禁用并显示进度。
- 私人记忆：记忆面板里按 agent 折叠展示，可编辑可清空（与公共总结同款交互）。
- 不做「边界回退」：回退边界而不回退总结会造成下次重复归档；需要重来时清空总结即同时清空边界与私人记忆（一个「重置记忆」动作）。

### 2.9 默认值

| 项 | 值 | 说明 |
|---|---|---|
| keepRecent | 5 | Sol 定 |
| threshold | 20（不变） | 触发点。实际每 15 条归档一次 |
| ARCHIVE_BATCH_MAX | 150 | 单批上限 |
| 失败退避 | 60 s | 归档失败后的重试冷却 |

### 2.10 顺手修的两处（侦察发现）

- 总结调用完全不入账：`updateSessionSummary` 只返回文本，三条分支都不读 usage；`calculateCost`（App.tsx:844，
  签名 `(tokens:{input,output}, provider, modelId)`）只在正常回复收尾被调。改成总结函数返回
  `{ text, usage?: {input, output} }`，归档 effect 对公共 + 每个私人总结各记一笔 `setTotalCost`。
  归档从一次调用变成 1+k 次，费用必须可见。
- `summaryService.ts:382` OpenAI 分支 `max_tokens` 写死 2000，忽略了 `outputTokens` 参数：`summaryMaxTokens`
  设置对 OpenAI 供应商无效。改为 `outputTokens`。

### 2.11 `handleClearMessages`（App.tsx:618-626）

清空消息时同时清掉 `summaryCutoffId` / `summaryCutoffTs`（`summary` 按 HEAD 行为保留不动）。
否则边界指向不存在的消息、ts 兜底又永远小于新消息，状态虽然「能用」但不干净。

## 3. 触点地图（侦察于 2026-09-07，HEAD 4787603）

| 触点 | 位置 | 改法 |
|---|---|---|
| 类型 | `types.ts:136-143` MemoryConfig；`types.ts:184-186` ChatSession 记忆字段 | 加 `keepRecent?`；加 `summaryCutoffId?` / `summaryCutoffTs?` / `privateSummaries?` |
| memoryConfig 默认值 | `App.tsx:294-299`、`App.tsx:456-461`、`services/db.ts:51-56`（三处字面量相同） | 三处都加 `keepRecent: 5` |
| 总结触发 effect | `App.tsx:1141-1219`；`lastSummaryCountRef` 定义 `:261`，用点 `:1160/1174/1209/1214` | 按 §2.2 重写；删 ref；依赖数组加 `summaryCutoffId` |
| summary 读点 | `App.tsx:1375`（喂 adapter）、`:1189`（喂总结）、`Sidebar.tsx:1247`、`Sidebar.tsx:2319-2321`（文本导出）、`services/exportHtml.ts:92-93` | 前两处随 effect 改；导出两处顺带输出私人记忆（可选，低优先） |
| adapter 调用 | `App.tsx:1634`(gemini) `:1649`(anthropic) `:1657`(responses) `:1665`(chat)，实参 `scenario, summary, adminNotes, …, settings.contextLimit` | `adminNotes` 之后不加参数；改传 `effectiveContextLimit`；`summary`/`adminNotes` 之外新增 `privateSummary` 的传法见下 |
| memory 层 | `services/shared.ts:304` `buildMemoryContext(summary, adminNotes)`，调用点 `anthropicService.ts:93`、`openaiService.ts:127`、`:524`、`geminiService.ts:136`；四个 `stream*Reply` 的 `summary?, adminNotes?` 位置参数在 `anthropicService.ts:43-44`、`openaiService.ts:78-79`、`:489-490`、`geminiService.ts:91-92` | `buildMemoryContext` 加第三参 `privateSummary?`；四个 adapter 的 `adminNotes?` 之后**紧跟**加 `privateSummary?: string`，App.tsx 四处实参对应加 `activeSession.privateSummaries?.[agent.id]`。位置参数表很长，务必逐个核对第 11/12 位（gemini 第 10/11 位） |
| 历史裁剪 | `App.tsx:1403` `let processedMessages = messages;`；`:1477` vision map；`:1523-1524` 图片路径 | §2.3 |
| `filterVisibleMessages` | `services/shared.ts:318-364`，切片在 `:336-341` | 不改 |
| 总结服务 | `services/summaryService.ts:273` `updateSessionSummary`；分支 `:343` gemini / `:369` anthropic / `:390` openai；`:382` max_tokens 写死 | 返回 `{text, usage}`；新增 `updatePrivateSummary`；prompt 按 §2.6；修 `:382` |
| 记忆设置 UI | `Sidebar.tsx:1084-1167`：threshold `:1105-1110`（min 5 max 500）、excludePM `:1131-1137`、maxTokens `:1156-1161`；写回 `onUpdateGroupMemoryConfig` → `App.tsx:524` | threshold 后加 keepRecent 输入；excludePM 文案改 |
| 记忆面板 | `Sidebar.tsx:1236-1260`：textarea `:1244-1249` 直写 `handleUpdateSummary`（`App.tsx:585`，经 `:3561` 传入）；adminNotes 列表 `:1251-1258` | 加「立即归档」「重置记忆」按钮；加私人记忆按 agent 折叠区；需要新增 props `onArchiveNow` / `onResetMemory` / `onUpdatePrivateSummary` / `isArchiving` |
| contextLimit 设置 | `Sidebar.tsx:2278-2282`，`types.ts:215`，默认 `constants.ts:21` | 加一行提示文案 |
| 消息列表 | `App.tsx:3773-3790` `messages.map` → ChatBubble；无现成分割线；居中胶囊样式可抄 `ChatBubble.tsx:75-88`（isSystem 分支） | 在边界消息之后插一条胶囊分割线 |
| PM 判定 | `constants.ts:4` `USER_ID='user'`；可见性 `shared.ts:354-357`（不认 USER_ID：agent→人类的 PM 只有发送者能看）；人类发 PM `App.tsx:3002`；agent 发 PM 落地 `App.tsx:2379/2443/2465/2478` | 私人记忆分组用 `{senderId, pmTargetId} ∩ agentIds`，agent→人类的 PM 只归发送 agent |
| 持久化 | `services/db.ts:594` 引用相等脏检测 → 整对象 PUT；`server/localdb.ts:151-188` 无白名单 | 不改 |
| 观众端 | `server/live.ts:834-842` 读白名单只有 id/groupId/name/lastUpdated/messages；viewer 不消费 summary | 不改 |
| i18n | `i18n.tsx:5` 单表 `en`，zh 为恒等映射；记忆区例子 `:24`、`:30` | 新 key 只在 `en` 加一行 |
| build | `package.json:9` `tsc && vite build`；tsconfig `include: ["src"]` 但 `src/main.tsx` 动态 import App.tsx，**tsc 会顺着 import 图检查根目录源码**（上一轮审查实测） | 用 `npx tsc --noEmit` 把关 |

侦察还确认：`handleClearMessages`（App.tsx:618-626）不清 summary；总结 effect 依赖数组（`:1219`）不含 summary；
仓库里没有任何 `summaryCutoff` / `privateSummaries` / `keepRecent` 半成品。

## 4. 不改的东西

- 自动播放、冷却、yield、辩论、PM 触发链、[SPLIT]、搜索/引用事务：全部基于 `messages` 数组与计数，不读边界。
- 文本轨 / 原生工具轨的历史格式化（`formatMessageForHistory` 等）不变。
- 手机观众端：只显示消息，不显示总结，不需要同步新字段（待侦察确认）。
- 已知的、不在本次范围内的泄漏：BLIND 模式与 hidePreJoinMessages 的 agent 通过公共总结能看到本不可见的内容，HEAD 已如此。

## 5. 验证方案

离线：`npx tsc --noEmit`（`npm run build` 的 tsc 会穿过动态 import 检查 App.tsx，不是空跑）。

行为：临时端口 + 临时 `ACO_DATA_DIR` + 本地 mock 上游（Anthropic `/v1/messages` 与 OpenAI
`/v1/chat/completions` 的 SSE mock 见 scratchpad `review-qf/mock-upstream.mjs`，可扩展一个
「总结」场景：收到含 `CONVERSATION CHRONICLE TASK` 的请求返回固定文本）。
必测场景：

1. 新会话灌 20 条 → 归档触发 → 边界落在第 15 条，请求 dump 里历史只有第 16–20 条 + 新消息，系统提示含新总结。
2. 归档期间再发 3 条 → 不重复触发；完成后边界正确。
3. 总结模型返回 500 → 边界不推进，60 s 内不重试，60 s 后重试成功。
4. range 内含 A→B 与 用户→A 的 PM，excludePM=true → 公共总结请求体不含 PM 行；A 与 B 各收到一次私人总结请求（A 的含两条，B 的含一条）；之后 A 的请求 memory 层含 `[PRIVATE MEMORY]`，C 的不含且 byte 不变。
5. 私人总结那次调用失败 → 公共总结也不落盘，边界不推进。
6. 老会话（有 summary、无边界、40 条）激活 → 激活瞬间的请求走 contextLimit 窗口；随后自动归档一次；再请求走边界。
7. 删除边界那条消息 → 按 timestamp 兜底，历史范围不变。
8. 记忆关闭的群组 → 请求体与 HEAD 逐字节一致（sha1 对比）。
9. 「立即归档」按钮：不足 threshold 也能手动归档，尾巴保留。
10. 分割线渲染位置正确，刷新后仍在；手机观众端不受影响。

## 6. 遗留 / 后续

- 总结分段（「设定与事实」只增不删 + 「近期剧情」滚动）：Sol 未拍板，本次不做。
- BLIND / 入群前隐藏 与公共总结的泄漏：现状已有，未处理。
- 自动改名（`generateSessionName`）仍不入账，本次只给归档相关调用记费。
- 文本/HTML 导出是否包含私人记忆：低优先，实现方可做可不做，报告里注明。

## 7. 实现备忘（给施工方的坑位提示）

- 四个 `stream*Reply` 的位置参数表很长且相邻多为 string，**在中间插参数会静默错位而 tsc 不报**。
  `privateSummary?: string` 一律追加在参数表最末（`followupHint?` 之后），四处调用点同样在末尾补实参。
- 归档是异步的，期间会有新消息追加。提交时必须用函数式 `setSessions(prev => …)`，只合并记忆相关字段
  到**当时最新**的 session 对象上，绝不能用归档开始时的快照整体覆盖，否则归档期间的消息会丢。
- `triggerAgentReply` 的 useCallback 依赖数组（App.tsx:2662 附近含 `activeSession.summary`）要补
  `summaryCutoffId` / `summaryCutoffTs` / `privateSummaries`，否则边界推进后旧闭包还在发全量历史。
- 「重置记忆」若用 `window.confirm`，Chrome MCP 验证前先用 javascript_tool 把 `window.confirm` 覆盖成
  `() => true`，否则弹窗会卡死扩展。


## 8. 实现记录（施工方填，2026-09-07）

按 §2 / §3 全部落实，`npx tsc --noEmit` 零错误。与规格的偏离逐条如下：

**8.1 `updateSessionSummary` 的三条分支抽成了公共 helper**
规格 §2.10 只要求三条分支各自取 usage。实现里抽出 `runSummaryCompletion(prompt, provider, modelId, outputTokens)`，
公共总结与新增的 `updatePrivateSummary` 共用它。理由：两个函数的请求形状（endpoint、headers、超时、重试）完全一样，
留两份拷贝迟早漂移。超时/重试参数沿用 HEAD 总结路径的 30000ms / 1 retry，未改。

**8.2 公共总结范围为空时不发那次调用**
规格 §2.2 第 1 步字面上是无条件调 `updateSessionSummary`。实现里加了一条保护：`excludePM` 为真且整批 range
全是私讯时，`publicRange` 为空 —— 此时跳过公共调用、`publicText` 沿用既有 summary，只跑私人总结。
理由：空 transcript 喂给「合并进已有档案」的 prompt，模型会凭空重写整份档案，等于把历史档案洗掉。
这条只在「一整批 150 条里一条公开消息都没有」时才会命中，实际很罕见。

**8.3 分割线多了一个「群组记忆已开启」的渲染条件**
规格 §2.8 只说「没有边界则不渲染」。实现里 `archiveDividerAfterId` 还要求 `memoryConfig.enabled`。
理由：记忆被关掉时上下文已经不按边界裁剪（§2.3 的规则本身就带 enabled 判断），此时还画「以上内容已归档进记忆」
会告诉用户一件与模型实际所见相反的事。边界字段本身不清，重新开启记忆后分割线原地回来。

**8.4 「立即归档」在没有可归档消息时禁用**
规格没规定这个交互。Sidebar 用与 `runArchive` 同一套规则算 `archivableCount`（未归档条数 − keepRecent），
为 0 时按钮禁用并显示 `没有可归档的消息`（任务书给了这个 i18n key）。避免按下去毫无反馈。

**8.5 `force` 不跳过失败退避**
按任务书「force 只跳过 threshold 检查，其余不变」的字面实现：60 s 退避对手动「立即归档」同样生效。
副作用是刚失败过的会话点「立即归档」会静默无反应（只有 console 一行 `[Archive] backing off, Ns left`）。
如果审查认为手动动作应当无视退避，改一行即可。

**8.6 导出未包含私人记忆**
规格 §6 列为低优先、可做可不做。本次没做：`Sidebar.tsx` 的文本导出与 `services/exportHtml.ts` 仍只输出公共 summary。

**8.7 计费只在页面生命周期内累计**
`totalCost` 本来就不持久化（HEAD 行为），刷新归零。归档的 1+k 次调用按 `calculateCost` 记进同一个 `totalCost`。
实测：一次公共总结（mock usage 1000 in / 200 out，价格 3 / 15 per 1M）→ `$0.006000`，与手算一致。

**8.8 其他实现细节**
- `sliceAfterCutoff` 放在 `services/shared.ts`，`App.tsx` 与 `Sidebar.tsx` 共用。
- 边界「有效性」在 `triggerAgentReply` 里显式判定：id 找得到、或 id 找不到但有 ts。两者都不成立时退回
  `contextLimit` 窗口 —— 一个失效的边界绝不能变成「不切片」（那会把整段历史原样发出去）。
- 视觉代理（vision proxy）那段原本 `processedMessages = messages.map(...)`，会把裁掉的消息又放回来，
  已改成在 `baseMessages` 上 map。
- 归档提交用函数式 `setSessions(prev => ...)` 只合并记忆字段；实测归档期间追加的 3 条消息全部保留。

**8.9 收尾（审查后第二轮，2026-09-07）**
- 上下文安全阀：边界之后未归档消息超过 max(threshold×3, 60) 条时退回 contextLimit 窗口并 console.warn（`useCutoffWindow`，主路径与图片生成路径共用）。
- 记忆世代号 `memoryGenRef`：重置记忆 / 编辑总结 / 编辑私人记忆 / 清空记录自增；`runArchive` 提交前世代变了或新边界那条消息已不在会话里就整轮作废（不写、不推进、不记退避、费用照记）。
- `findCutoffIndex` 合并了分割线定位与上下文裁剪的算法；ts 兜底改为「最后一条 timestamp <= ts 的下标」。注意：同毫秒兄弟消息仍会被吞（与 ts 相等的那条正是定位点自身），修掉的是两处算法漂移。
- 新建群组 `excludePM` 默认改为 true（Sol 拍板）：三处默认字面量各加一行，老群组不受影响。

状态更新：已实现 + 已审查（PASS_WITH_NOTES）+ 收尾完成，待提交。
