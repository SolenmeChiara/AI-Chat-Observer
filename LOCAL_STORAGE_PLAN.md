# LOCAL_STORAGE_PLAN — 数据存储从 IndexedDB 迁到本机磁盘文件

状态：已实施并通过独立审查，待上线验证（2026-09-06）
方向：Vite 插件中间件 + `data/` 目录 JSON 文件。不引入新进程、不引入新依赖。

## 0. 侦察结论（2026-09-06）

- 应用只在本机 `npm run dev` / `npm run preview` 下运行，无静态托管、无 CI、无 PWA、零后端。加中间件在分发层面无障碍。
- 实测 Chrome Default profile 的 `localhost:5173` origin 约 61 MB，其中 58 MB 是外置大记录（内联 base64 图片的 session 行）。
- 持久化 100% 集中在 `services/db.ts` 的 5 张表，唯一导入点 `App.tsx:16`；无 localStorage / sessionStorage / Cache API。
- 写模型：`saveCollection` 整表 clear+bulkPut。sessions 在 `App.tsx:353-359` 有 1s trailing debounce（连续流式期间会被不断重置，直到 1s 静默才落库）；agents/providers/groups/settings 在 `App.tsx:318-332` 零节流立即写。
- 无 JSON 全量导入/导出；现有导出（`Sidebar.tsx:2357-2374`、`services/exportHtml.ts`）是有损展示格式。
- 多标签页：`db.ts:67` 只 console.warn，state 层互相整表覆盖。
- `db.ts:113-116`「空表 → 用 INITIAL_* 默认值」把读失败伪装成首次启动；磁盘场景下这是静默覆盖真实数据的风险点。
- `tsconfig.json` `include` 只有 `src/`，根目录业务代码不在 `tsc` 覆盖范围内——审查不能指望 tsc 兜底。

## 1. 目标 / 非目标

目标
- 数据落在 `<repo>/data/` 下的人类可读 JSON 文件，不再依赖浏览器 origin 存储；端口漂移、清站点数据、换浏览器都不再丢数据。
- `App.tsx` 对 db 层的调用面（`initDB` / `loadAllData` / `saveCollection` / `saveSettings`）签名不变。
- 首次启动自动从 IndexedDB 搬家，IndexedDB 原样保留作回退。
- 补一条 JSON 全量导出 / 导入通道作备份。

非目标（明确留二期）
- 附件 base64 拆成独立文件（牵动 4 个 API service + ChatBubble + exportHtml，61 MB 量级不值得）。
- 多标签页冲突检测（文件不会损坏即可，state 层覆盖维持现状）。
- 远程后端 / 多用户（ARCHITECTURE.md Phase 3 方向不同）。

## 2. 文件布局

```
data/
  meta.json            { schemaVersion: 1, migratedFrom: 'indexeddb' | 'seed' | 'import', migratedAt: ISO }
  agents.json          Agent[]
  providers.json       ApiProvider[]        ← 明文 API key，data/ 必须进 .gitignore
  groups.json          ChatGroup[]
  settings.json        GlobalSettings（不含 id 字段）
  sessions/
    <sessionId>.json   ChatSession（含 messages、内联附件）
```

- 目录位置默认 `<repo>/data`，环境变量 `ACO_DATA_DIR` 覆盖（测试用临时目录）。
- 按 session 拆文件：流式期间只重写正在说话的那一个会话。

## 3. 服务端：`server/localdb.ts`（Vite 插件）

同时注册 `configureServer` 与 `configurePreviewServer`，在 `vite.config.ts` 的 `plugins` 里加载。

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/api/db/all` | 一次返回 `{ meta, agents, providers, groups, settings, sessions: ChatSession[], missing: string[] }`。文件不存在 → 对应字段 `null` 并列入 `missing`；文件存在但读/parse 失败 → **500 `{ error }`**，绝不吞成 null |
| PUT | `/api/db/agents` `/providers` `/groups` `/settings` `/meta` | body 为 JSON，先 parse 校验再写 |
| PUT | `/api/db/sessions/:id` | 写单个会话 |
| DELETE | `/api/db/sessions/:id` | 删单个会话（不存在也返回 200） |

实现约束
- 原子写：写 `<file>.tmp-<random>` → `fs.rename` 覆盖。同一路径的写入用 promise 链串行化。
- 请求体流式读取，上限 256 MB，超限 413。JSON parse 失败 400。
- `:id` 只允许 `[A-Za-z0-9_-]`，防路径穿越。
- 只监听 `/api/db/*`，其余请求 `next()`。
- 不引入 express / body-parser 等依赖，纯 Node `http` + `fs/promises`。

## 4. 客户端：`services/db.ts` 重写

对外导出保持不变：`initDB` / `loadAllData` / `saveCollection` / `saveSettings`。新增：`exportSnapshot()` / `importSnapshot(snapshot)` / `flushPendingWrites()` / `getStorageMode()`。

后端选择
- 启动时探测 `GET /api/db/all`；成功 → `file` 模式。网络错误或 404（例如 dist 被别的静态服务器托管）→ 回退现有 Dexie 实现并 `console.warn`。现有 Dexie 代码保留为 `legacy` 后端，不删。

`initDB()`（file 模式）
1. `/api/db/all` 返回 `meta === null` → 视为未初始化：
   - 打开 Dexie，`agents.count() > 0` → 读全部 5 张表 → 逐个 PUT 到服务端 → 写 `meta { migratedFrom: 'indexeddb' }`。**IndexedDB 不删不改。**
   - IndexedDB 也为空 → 用 `INITIAL_*` / `DEFAULT_SETTINGS` 种子写文件，`meta { migratedFrom: 'seed' }`。
2. `meta` 存在 → 什么都不做。
3. 搬家过程中任何一步失败 → 抛错（走 `App.tsx:309-312` 的 `dbError` 错误页），不写 meta，下次启动重试。

`loadAllData()`（file 模式）
- 用探测时已拿到的 `/api/db/all` 响应，不重复请求。
- 500 → 抛错。
- `missing` 中的表：agents/providers/groups/sessions 用 `INITIAL_*`，settings 用 `DEFAULT_SETTINGS`（与现状一致；由于 `saveCollection` 拒写空数组，文件缺失只可能发生在首次启动）。
- 返回值形状与现在完全一致。

`saveCollection(table, items)`（file 模式）
- agents / providers / groups：整表 PUT，经写调度器合并。
- sessions：**引用脏检测**。维护 `lastSaved: Map<id, ChatSession>`；`items` 中 `lastSaved.get(id) !== item` 的 PUT，`lastSaved` 有而 `items` 无的 DELETE。PUT/DELETE 成功后才更新 map（失败保持脏，下次重试）。
- 空数组保护（`db.ts:124-127`）保留。

`saveSettings(settings)`：PUT `/api/db/settings`，经写调度器合并。

写调度器（db.ts 内部，对 App.tsx 透明）
- 以「表名」或「sessions/<id>」为 key，trailing 300 ms 合并，maxWait 2 s。
- 同 key 串行：上一次 PUT 未返回前新的写只覆盖待发 payload，不并发。
- `pagehide` / `visibilitychange === 'hidden'` 时调用 `flushPendingWrites()`：body ≤ 60 KB 走 `fetch(..., { keepalive: true })`，更大的走普通 fetch 尽力而为。已知窗口：极端情况下最多丢最近 ~2 s 的写，在文档和报告里如实说明。

`exportSnapshot()` / `importSnapshot()`
- 导出：把当前 5 张表打包成 `{ schemaVersion, exportedAt, agents, providers, groups, settings, sessions }`，由 Sidebar 复用 `downloadFile()` 下载为 `aco-backup-<date>.json`。
- 导入：校验 `schemaVersion` 与五个字段存在 → 逐个 PUT 覆盖 → 写 `meta { migratedFrom: 'import' }` → `location.reload()`。导入前 `confirm` 提示会覆盖现有数据。

## 5. App.tsx 的最小改动

只改一处：`App.tsx:353-359` 的 sessions debounce 加 maxWait（3 s）。现状是 trailing-reset，连续流式期间可能几分钟不落库。其余 useEffect 不动。

Sidebar：在现有导出按钮旁加「导出 JSON 备份」「导入 JSON 备份」两个按钮，走 `exportSnapshot` / `importSnapshot`，i18n 键按 `i18n.tsx` 现有模式加中英文。

`App.tsx:3298-3302` 错误页的「清空所有数据」按钮（`Dexie.delete`）保持不变；file 模式下按钮文案旁加一行说明「文件模式下请手动处理 data/ 目录」即可，不做更多。

## 6. 其他

- `.gitignore` 加 `data/`。
- `vite.config.ts` 端口锁定保留（origin 隔离对 legacy 回退仍有意义）。
- README / ARCHITECTURE 的存储章节在收尾时由主循环安排更新。

## 7. 验证方式（实现方与审查方都按此执行）

- 类型：`npx tsc --noEmit --jsx react-jsx --skipLibCheck --target ES2020 --module ESNext --moduleResolution bundler --lib ES2020,DOM,DOM.Iterable services/db.ts server/localdb.ts App.tsx components/Sidebar.tsx`——只看**新增**错误，与 HEAD 同参数跑一次作对照。
- 构建：`npm run build` 通过。
- 服务端：`ACO_DATA_DIR=<临时目录> npx vite --port 5199`，用 node 脚本打 `/api/db/*`：PUT→GET 回读一致；DELETE 后 GET all 不含该 session；损坏的 JSON 文件 → 500；缺失文件 → `missing`；非法 `:id` → 400；tmp 文件写完不残留。
- 端到端（仅允许 `http://localhost:5199`，**绝不打开 5173**）：新建 agent / group / session → 刷新 → 数据仍在，`data/` 里文件内容正确；通过浏览器 console 用 Dexie 往 5199 origin 的 IndexedDB 灌样例数据 → 删掉 `meta.json` → 刷新 → 文件出现且内容匹配，IndexedDB 未被删。
- 未测路径必须在报告里如实列出。

## 8. 审查清单

1. `App.tsx` 中是否存在对 session / message 对象的原地修改（`.push` / `.splice` / 直接赋值）——有一处漏网引用脏检测就会丢写。审计结果见本文件附录。
2. 500 与 missing 的区分是否贯穿服务端→客户端→错误页，是否存在任何「读失败 → 默认值 → 覆盖写回」的路径。
3. 写调度器并发：同 key 串行、跨 key 并行、失败保持脏、`flushPendingWrites` 幂等。
4. 原子写在 Windows 上的 `rename` 覆盖行为；tmp 文件清理。
5. 路径穿越、请求体上限、JSON 校验。
6. legacy 回退路径是否与 HEAD 行为完全一致。
7. 搬家的不可破坏性：IndexedDB 不删不改；搬家中途失败不写 meta。

## 9. 上线（主循环执行）

1. 审查 PASS 后合并到 main。
2. Sol 关掉当前 5173 的 dev server，`npm run dev` 重启，首次加载自动搬家；打开 `data/` 目录验证 sessions 数量与文件内容。
3. 立刻点一次「导出 JSON 备份」，备份文件亲眼验证落地。
4. 回滚路径：`git revert` 回旧代码即回到 IndexedDB（数据仍在）。

## 附录 A：App.tsx 原地修改审计

审计日期：2026-09-06。审计对象：`App.tsx` 全文（1-3818 行，逐行读完）+ `components/*.tsx` + `services/*.ts` 中所有接触 `ChatSession` / `Message` 的位置。

### 总判定

**安全（0 处漏网）**。sessions state 的每一次更新都创建了新的 session 对象与新的 `messages` 数组，`saveCollection('sessions', items)` 的 `!==` 引用脏检测不会漏写。
未在任何位置发现 `session.messages.push(...)`、`msg.text += chunk`、`s.name = ...` 后复用同一引用的写法。全仓库 grep `\b(session|s|msg|message|m|lastMsg|target)\.\w+\s*(=|+=)` 在 App.tsx 只命中 `e.target.value = ''`（DOM）一处。

### 明细表

| file:line | 代码片段（节选） | 判定 | 说明 |
|---|---|---|---|
| App.tsx:399-401 | `updateActiveSession = fn => setSessions(prev => prev.map(s => s.id === activeSessionId ? fn(s) : s))` | 不可变 | 中枢更新器。不匹配的 session 原样返回 `s`（引用不变→不写），匹配的交给 updateFn。下面所有 updateFn 均已逐个核对。 |
| App.tsx:403-410 | `updateActiveSessionMessages`：`{...s, messages: updateFn(s.messages), lastUpdated}` | 不可变 | 唯一调用点 App.tsx:1229 传入 `prev => [...prev, {...}]`。 |
| App.tsx:1242-1244 | `updateThisSession = fn => setSessions(prev => prev.map(s => s.id === capturedSessionId ? fn(s) : s))` | 不可变 | **流式主路径中枢**。捕获 sessionId 版本，语义同上。其 27 个调用点全部展开新对象。 |
| App.tsx:282 | `setSessions(data.sessions)` | 不可变 | 启动装载，引用直接来自 `loadAllData()`。见下方「实施提示」。 |
| App.tsx:444 / 512 | `setSessions([...sessions, newSession])` | 不可变 | 新建群组/会话。已存在的 session 引用原样带过 → 只有新会话被 PUT。 |
| App.tsx:453 / 517-519 | `setSessions(sessions.filter(...))` | 不可变 | 删群组/会话。留存者引用不变，消失者触发 DELETE。 |
| App.tsx:530 / 545 | `prev.map(s => s.id === id ? {...s, name/summary} : s)` | 不可变 | 重命名 / 更新摘要。 |
| App.tsx:566 | `{...s, messages: s.messages.filter(m => m.id !== messageId), lastUpdated}` | 不可变 | 删单条消息。 |
| App.tsx:578-584 | `handleClearMessages`：`{...s, messages: [], adminNotes: [], debateConfig: {...}}` | 不可变 | 清空记录。 |
| App.tsx:837 / 887-891 / 923 | `{...s, messages: [...s.messages, joinMessage], agentJoinedAt: {...(s.agentJoinedAt||{}), [id]: ...}}` | 不可变 | 加入/管理员系统消息；嵌套对象也是浅拷贝新建。 |
| App.tsx:848-865 | `handleRemoveAgent`：整块 `{...s, mutedAgentIds: filter, debateConfig: {...}, agentVisibility: Object.fromEntries(...), humanDisguise: filter}` | 不可变 | 全部子结构重建，无原地删键。 |
| App.tsx:935-989 | `handleMuteAgent`：`newMutedAgents = [...(s.mutedAgents||[]).filter(...), {...}]`，返回 `{...s, ...}` | 不可变 | 禁言。`existingMute` 只读不改。 |
| App.tsx:993-1012 | `handleUnmuteAgent` 同上 | 不可变 | |
| App.tsx:1019-1041 | 过期禁言巡检：`if (expiredMutes.length === 0) return s;` 否则返回 `{...s, messages: [...s.messages, sysMsg]}` | 不可变 | **无变更分支返回同一引用是正确的**——引用不变即不写盘，正是脏检测想要的行为（该 effect 每 60 s 跑一次，若返回新对象会每分钟重写全部会话文件）。 |
| App.tsx:1062 / 1091 | 自动命名：`{...s, name: newName, isAutoRenamed: true}` | 不可变 | |
| App.tsx:1159-1163 | 记忆摘要：`{...s, summary, adminNotes: []}` | 不可变 | |
| App.tsx:1257 | `{...s, messages: [...s.messages, placeholderMessage], lastUpdated}` | 不可变 | 流式占位符落库。 |
| App.tsx:1293 | `{...s, messages: s.messages.filter(m => m.id !== newMessageId)}` | 不可变 | 超时重试删占位符。 |
| App.tsx:1300-1319 | 超时兜底：`s.messages.map(m => m.id === newMessageId ? {...m, isError, text} : m)`，再 `[...finalized, recoveryMessage]` | 不可变 | 消息对象也是 `{...m}` 重建，不是原地改 `m.text`。 |
| App.tsx:1408-1426 | VisionProxy 描述回写：`{...s, messages: s.messages.map(msg => ({...msg, attachments: msg.attachments.map(att => ({...att, visionDescription}))}))}` | 不可变 | 三层嵌套全部重建（session→message→attachment）。 |
| App.tsx:1529-1532 / 1554-1564 / 1571-1574 | 图像生成分支：`s.messages.map(m => m.id === newMessageId ? {...m, ...} : m)` | 不可变 | 三处（reasoning / image / usage）。 |
| App.tsx:1827-1830 | `{...s, messages: s.messages.map(m => ... {...m, reasoningText: accumulatedReasoning})}` | 不可变 | **流式思考链主路径**。`accumulatedReasoning` 是局部 let 字符串累加，不是 `m.reasoningText +=`。 |
| App.tsx:1852-1858 | `{...m, attachments: [...(m.attachments || []), imageAttachment]}` | 不可变 | 流式图片 part，数组展开而非 push。 |
| App.tsx:2024-2030 | `[SPLIT]` 分段：`[...s.messages.map(...), { id: nextId, ... }]` | 不可变 | 定稿旧段 + 追加新段，一次 map + 展开。 |
| App.tsx:2053-2056 | `{...s, messages: s.messages.map(m => m.id === streamTargetId ? {...m, text: currentSegmentText, ...} : m)}` | 不可变 | **流式正文主路径**，每个 chunk 一次。`accumulatedText` 是局部 let。 |
| App.tsx:2086-2093 | NOTE 去重：命中重复时 `return s`，否则 `{...s, adminNotes: [...existingNotes, newNote]}` | 不可变 | 同 1019 行，无变更返回同引用是正确的。 |
| App.tsx:2098-2101 / 2105 | DELNOTE / CLEARNOTES：`{...s, adminNotes: filter / []}` | 不可变 | |
| App.tsx:2286-2292 | PASS 分支：`messages: [...s.messages.filter(...), ...(passPmMessage ? [passPmMessage] : [])]` | 不可变 | |
| App.tsx:2348-2386 | **finalize 定稿**：`messages: [...s.messages.map(m => ...{...m, text: finalText, tokens, cost, replyToId}...), ...(pmMessage ? [pmMessage] : [])]` | 不可变 | 落库最关键的一次写，逐字段展开重建。 |
| App.tsx:2396-2406 / 2413-2423 / 2432-2442 / 2454-2458 / 2466-2476 | 搜索事务的 5 处消息写入，均 `[...s.messages, msg]` 或 `[...s.messages.filter(...), msg]` | 不可变 | |
| App.tsx:2502-2506 | 骰子/塔罗结果消息 `[...s.messages, entertainmentMsg]` | 不可变 | |
| App.tsx:2522 / 2529-2537 | abort 删占位符 / 错误落库 `{...m, text: m.text ? ... : ..., isError: true}` | 不可变 | 错误文本是新字符串赋进新对象，不是 `m.text +=`。 |
| App.tsx:2647-2651 / 2665 / 2678-2682 / 2699-2703 / 2716-2724 / 2735-2739 | `/search` 命令的 6 处写入，`[...s.messages, msg]` 或 `.filter(...).concat([msg])` | 不可变 | |
| App.tsx:2810-2816 | `handleUserSend` 主写：`messages: [...s.messages, newMessage, ...entertainmentMessages]` | 不可变 | |
| App.tsx:2989-2993 | 冷却清理 `{...s, yieldedAgentIds: [], yieldedAtCount: undefined}` | 不可变 | |
| App.tsx:3372 | `onUpdateDebateConfig={config => updateActiveSession(s => ({...s, debateConfig: config}))}` | 不可变 | `config` 由 RightSidebar 构造为新对象（见下）。 |
| App.tsx:3374-3380 / 3404-3409 | humanDisguise / hidePreJoin toggle，`{...s, ...}` + 新数组/新对象 | 不可变 | |
| App.tsx:3391-3401 | `const newVis = {...(s.agentVisibility || {})}; ... delete newVis[agentId]; return {...s, agentVisibility: ...}` | 不可变 | `delete` 作用在浅拷贝上，不是 state 对象。 |
| RightSidebar.tsx:98 / 123 / 144 | `const assignments = [...debateConfig.assignments]` 后 `assignments.push(...)` / `assignments[idx] = {...}` | 不可变 | 先整数组拷贝再改；元素也是 `{...assignments[idx], ...}` 重建；最后 `onUpdateDebateConfig({...debateConfig, assignments})`。 |
| RightSidebar.tsx:102 / 134 / 360 / 387 | `assignments.filter(...).sort(...)` | 不可变 | `.sort` 作用在 `.filter` 新建的数组上，原数组顺序不受影响。 |
| App.tsx:1337 / 1341 / 1763 / 1935 / 3161 / 3208 | `.filter(...).sort(...)`、`[...sessionMembers].sort(...)`、`[senderId, mentionedId].sort()` | 不可变 | 全部在拷贝/派生数组上排序。 |
| App.tsx:2982 | `[...messages].reverse().find(...)` | 不可变 | 先展开再 reverse。 |
| App.tsx:3154 | `agentsToQueue = readyAgents.sort(() => Math.random() - 0.5)` | 不可变 | `readyAgents` 是 `allMentionAgents.filter(...)` 的新数组。 |
| App.tsx:125-131 | `buildDebateTurnSequence`：`assignments.filter(...).sort(...)`、`sequence.push(...)` | 不可变 | 纯函数，`sequence` 是局部数组。 |
| App.tsx:673 / 702 / 717 / 761 / 792 | `ttsQueueRef.current = messages.slice(...)` / `.push(lastMessage)` / `.shift()` | 原地修改-不涉及 session | 改的是 ref 私有数组；数组里存的 Message 引用只被读（`.text` / `.id` / `.senderId`），从未被写。 |
| App.tsx:3212 | `prev.count++` | 原地修改-不涉及 session | `mentionPairRef.current`，纯 ref 计数器。 |
| App.tsx:284-296 | `mergedSettings.userName = activeProfile.name` 等 3 行 | 原地修改-新对象-不漏写 | `mergedSettings = {...DEFAULT_SETTINGS, ...data.settings}` 已是新对象；且 settings 走整表 PUT，不依赖引用比较。 |
| Sidebar.tsx:525-566 | `let updatedAgent = {...currentData, ...updates}` 后 `updatedAgent.name/avatar/systemPrompt = ...` | 原地修改-新对象-不漏写 | 改的是刚 spread 出来的新对象。agents 整表 PUT，优先级低。同型代码 Sidebar.tsx:695-724。 |
| Sidebar.tsx:641-643 | `const newAgents = [...agents]; newAgents.splice(...)` | 不可变 | 拖拽排序，先拷贝。 |
| Sidebar.tsx:758 | `const m = [...p.models]; m[modelIdx] = {...m[modelIdx], [field]: value}` | 不可变 | providers 整表 PUT。 |
| Sidebar.tsx:814-820 / 840-848 | `const newSettings: GlobalSettings = {...settings, ...}` 后逐字段赋值 | 原地修改-新对象-不漏写 | 同 mergedSettings，settings 整表 PUT。 |
| Sidebar.tsx:588-592 / 597-601 | `const next = {...prev}; delete next[id]` | 不可变 | draftAgents 组件本地 state。 |
| Sidebar.tsx:877-891 / 926-1035 / 2305-2374 | 读 `sessions` / `session.messages` 渲染与导出 | 只读 | Sidebar 从不写 session；导出把内容 push 进本地 `lines: string[]`。 |
| ChatBubble.tsx:144-146 | `[...allAgents.map(a => a.name), userName].filter(Boolean).sort(...)` | 不可变 | 排序的是新建的名字数组。 |
| ChatBubble.tsx 全文 | `message` prop 只读渲染 | 只读 | 无对 `message` 的任何赋值（grep `\.\w+\s*=` 在该文件仅命中一处 `att.mimeType.split('/').pop()` 的读操作）。 |
| StatsPanel.tsx / statsService.ts:137-146 | `Array.from(statsMap.values()).filter().sort()`；`stats.avgChars = ...` | 不可变 / 原地修改-本地对象 | `statsMap` 是函数内新建的 Map，其 value 也是新建的统计对象。传入的 `messages` 只读。 |
| anthropicService.ts:71 / geminiService.ts:119 / openaiService.ts:106,505 | `[...visibleMessages].reverse().find(...)` | 不可变 | 四处一致，先展开再 reverse。 |
| anthropicService.ts:117-133,165-209,241-249 | `formattedMessages.push(...)`、`prevMsg.content.push(...)`、`prevMsg.content = [...]`、`tailBlock.cache_control = {...}` | 原地修改-不涉及 session | 改的是本函数自建的 API 请求体（`formattedMessages` / `contentBlocks` 都是新建对象），与 state 中的 Message 无共享引用。 |
| geminiService.ts:149-227,286-290 | `formattedContents.push(...)`、`lastEntry.parts.push(...)`、`parts.push(...)`、`toolList.push(...)` | 原地修改-不涉及 session | 同上，纯请求体构造。 |
| openaiService.ts:164,329,403,436-441,546-598,706,755-785 | `contentParts.push`、`lines.pop()`、`toolCallAccum[idx] = {...}`、`inputItems.push` | 原地修改-不涉及 session | 同上 + SSE 解析缓冲。 |
| entertainmentService.ts:39,162-165,212-252 / exportHtml.ts:74-75 / capabilities.ts:450-463 / modelFetcher.ts:165-219 | 各类 `.push` / `.splice` / `.sort` | 原地修改-不涉及 session | 全部作用于函数内新建的局部数组（骰子 rolls、洗过的 deck、导出 lines、工具描述、模型列表）。 |
| services/shared.ts | — | 只读 | 全文无任何数组变异或属性赋值（两轮 grep 零命中），只做字符串格式化。 |

### 附带发现（非漏写，供实施/审查参考）

1. **`setSessions` 的非函数式调用**：`App.tsx:444`、`453`、`512`、`517-519`（新建群组/会话、删除群组/会话）用的是闭包里的 `sessions` 变量而不是 `prev => ...`。这是既有的 stale-closure 隐患（流式期间用户点「新建会话」，可能用旧快照覆盖掉刚流进来的 chunk），**与本次迁移无关，也不会造成漏写**——真发生回退时 session 引用同样变化，脏检测照样 PUT（只是 PUT 的是被回退过的内容）。建议单独立项，不要混进本次改动。
2. **`lastSaved` 的初始化**：`App.tsx:282` 直接把 `loadAllData()` 返回的 session 对象放进 state。`saveCollection` 首次被调用时若 `lastSaved` 为空，会把全部会话 PUT 一遍（正确但浪费一次全量写）。建议 `loadAllData()` 在 file 模式返回时顺手用同一批引用填充 `lastSaved`。
3. **无变更即同引用的两处 early-return**（`App.tsx:1024`、`App.tsx:2090`）是脏检测的受益点，不要在后续重构里"顺手"改成无条件返回新对象——`checkExpiredMutes` 每 60 s 跑一次，改了会导致每分钟重写全部会话文件。
4. **`lastUpdated` 并非每次都刷新**（如 `App.tsx:837`、`891`、`923`、`1039` 只加系统消息不动 `lastUpdated`）。脏检测靠引用不靠时间戳，无影响；但如果将来想用 `lastUpdated` 做冲突检测，这条要先补齐。

### 覆盖范围

- **逐行读完**：`App.tsx` 全文 1-3818 行（分 8 段：1-160、160-256、255-435、435-585、584-844、869-1009、1104-1334、1333-1623、1622-1922、1922-2222、2222-2572、2574-2954、2953-3333、3330-3818）。
- **逐行读完**：`components/RightSidebar.tsx:55-170`（辩论配置全部 handler）、`components/Sidebar.tsx:525-650`（agent draft / 拖拽）、`780-875`（profile / 头像）、`components/ChatBubble.tsx:135-160`、`services/anthropicService.ts:140-250`、`services/statsService.ts:125-154`。
- **靠 grep 覆盖（读了命中行的上下文，未整文件通读）**：`components/Sidebar.tsx` 其余部分（含 2305-2374 导出）、`components/StatsPanel.tsx`、`services/geminiService.ts`、`services/openaiService.ts`、`services/entertainmentService.ts`、`services/exportHtml.ts`、`services/capabilities.ts`、`services/modelFetcher.ts`、`services/shared.ts`、`services/summaryService.ts`、`services/ttsService.ts`、`services/searchService.ts`、`services/fileParser.ts`、`services/visionProxyService.ts`。
  grep 模式：`setSessions(` / `updateThisSession(` / `updateActiveSession(` / `.push(` / `.splice(` / `.sort(` / `.reverse(` / `.unshift(` / `.pop(` / `.shift(` / `Object.assign(` / `delete \w+(\.|\[)` / `\w+\[...\] =` / `\.\w+\s*(=[^=>]|\+=)` / `messages\.(sort|reverse|push|splice)` / `\.messages\s*=` / `\.text\s*(=|\+=)` / `\.attachments\s*=`。

### 未确认项

- `services/db.ts` 现有实现本身未审（本次任务范围外）；`saveCollection` 改写后的 `lastSaved` 语义是否与上表结论一致，需由实现方与审查方按第 8 节第 1 条复核。
- 未做运行时验证（本次为纯静态只读审计，未起 dev server、未跑浏览器）。「每次 setSessions 后 session 引用确实变化」是读代码得出的结论，不是实测。若要实测，最省事的办法是在 `saveCollection` 里对比 `lastSaved` 并 `console.log` 本次 PUT 的 session id 数量，跑一轮流式回复看是否恒为 1。
- `components/StatsPanel.tsx` 只靠 grep 确认无变异，未通读；它接收 `messages` 只做统计渲染，风险极低但未逐行核。

## 附录 B：实施记录

实施日期：2026-09-06。实施分支：`worktree-agent-a1f5fac06d1326ff0`（基线 `95b6f2a`）。

### B.1 改动清单

| 文件 | 改动 |
|---|---|
| `server/localdb.ts` | 新增（约 300 行）。Vite 插件 `localDbPlugin()`，同时注册 `configureServer` / `configurePreviewServer`。纯 `node:http` + `node:fs/promises` + `node:crypto`，零新依赖。 |
| `vite.config.ts` | 引入并注册 `localDbPlugin()`。端口锁定保留。 |
| `services/db.ts` | 按第 4 节重写（148 → 约 620 行）。四个对外函数签名不变；新增 `exportSnapshot` / `importSnapshot` / `flushPendingWrites` / `getStorageMode`，导出类型 `DbSnapshot` / `StorageMode`。Dexie 类与原四个实现完整保留为 `legacy*`。 |
| `App.tsx` | 三处：导入行加 4 个符号；sessions debounce 加 maxWait 3 s（新增 `sessionsSaveDeadlineRef`）；错误页加一行 file 模式说明；`<Sidebar>` 多传两个 prop。 |
| `components/Sidebar.tsx` | `SidebarProps` 加 `exportSnapshot` / `importSnapshot`；新增 `backupInputRef`；导出卡片下方加「导出 JSON 备份」「导入 JSON 备份」+ 隐藏 file input。 |
| `i18n.tsx` | 8 个新键的英文翻译。 |
| `.gitignore` | 加 `data/`。 |

### B.2 与设计的偏离

1. **`initDB()` 搬家/播种后重新拉一次 `/api/db/all`**。第 4 节说 `loadAllData` 复用探测时的响应，但搬家刚写完时那份快照全是 `null`。多花一次请求（一辈子只发生一次），顺带验证数据确实落盘。
2. **`loadAllData()` 保留了 HEAD 的「空数组 → `INITIAL_*`」兜底**，不只处理 `missing`。空 ≠ 读失败（读失败在服务端就是 500），这条只是与改造前行为对齐。
3. **`location.reload()` 放在 Sidebar 的导入 handler 里**，不在 `importSnapshot()` 内部，保持数据层没有 UI 副作用。
4. **`importSnapshot()` 只覆盖不删除**：备份里没有的 session 文件会留在 `data/sessions/` 下（已实测确认）。破坏性删除不在规格里，留给用户手动处理。
5. **`flushPendingWrites(urgent = false)` 多了一个可选参数**，用来区分「页面要没了，小 body 走 keepalive」和「导出前的普通落盘」。默认值下签名与规格一致。
6. **服务端超限时不 `req.destroy()`**，改成继续读完但丢弃字节。直接 destroy 会让客户端收到 ECONNRESET 而不是 413（实测如此），排查起来更难。

### B.3 实施中发现并处理的三个问题

1. **StrictMode 双跑 `initDB`**。dev 下 bootstrap effect 跑两遍，两次都看到 `meta === null`，会把整个数据集搬两遍。加了单飞 promise 合并（`initPromise`）。实测日志从两条「已初始化」变一条。
2. **HMR 之后所有保存静默丢失**。vite 热更新 `App.tsx` 时 `services/db.ts` 被换成一个全新模块实例（`?t=...`），模块级 `mode` 归零，而 `App` 的 `isDbLoaded` 是活的 state —— 保存 effect 立刻打进来，此时 `initDB` 不会再被调用。这也是实施过程中 IndexedDB 莫名其妙被写进 `agents/providers/groups/settings` 四张表（唯独 sessions 因为 debounce 没写）的真凶。修法是 `ensureBackend()`：保存路径上 `mode === 'unknown'` 时先探一次后端方向（不做搬家/播种），探不出来就跳过本次写而不是猜。
3. **`await ensureBackend()` 破坏了同 tick 内 `save → flush` 的顺序**。多插一个 microtask 会让紧跟其后的 `flushPendingWrites()` 看不到刚调度的写。改成只在 `mode === 'unknown'` 时才 await，常规路径同步走到 `scheduleWrite`。

### B.4 验证结果

- **类型**：规格第 7 节的显式 `tsc` 命令，HEAD 0 错 / 改动后 0 错（新增 0）。`npm run build` 通过。
- **服务端**：51 条 node 脚本断言全绿，dev server 与 `vite preview` 各跑一遍（覆盖 PUT/GET 回读一致、DELETE、幂等删除、9 种非法 `:id`、裸 socket 路径穿越、坏 body 400、损坏文件 500、缺文件 missing、405/404、`.tmp-` 残留、20 路并发同 key 写、4 MB body）。264 MB body 单独验到 413 且客户端确实收到响应。
- **端到端**（`http://localhost:5199`，dev 与 preview 各一轮）：种子初始化 → 发消息 → 新建会话 → 刷新数据仍在；引用脏检测经 mtime 确认（新建第二个会话时 `session-1.json` 未被重写）；IndexedDB 灌样例 → 删 `meta.json` → 刷新 → 5 张表全部搬到文件、IndexedDB 计数与内容一字未动；导出备份文件名/结构正确；导入覆盖生效且 `meta.migratedFrom` 变 `import`，4 种坏备份被拒且磁盘无变化；`agents.json` 人为损坏 → 错误页显示服务端原始报错、**磁盘上没有任何文件被默认值覆盖**（这是本次改造最关键的安全属性）；`pagehide` / `visibilitychange=hidden` 都能把待写立刻冲出去。

### B.5 已知窗口与遗留风险

- **最多丢 2 s**：写调度器 maxWait 2 s（App 层 sessions debounce 3 s 先于它触发）。正常关标签/刷新有 `pagehide` flush 兜底；进程崩溃/断电则丢最近一批。
- **写失败只在下一次 state 变化时重试**。PUT 失败时 `lastSaved` 不登记，该 session 保持脏；但如果此后再无任何改动，这次写就永远不会补上（只有 console.error）。没有后台重试队列。
- **多标签页**：与 HEAD 同样是 state 层互相覆盖（后保存的标签页内容覆盖先保存的）。审查纠正：DELETE 只针对本标签页自己 `lastSaved` 里的 id，另一标签页新建的会话不在其中，**不会被删**——file 模式在这点上比 HEAD 的 `clear()+bulkPut()` 更安全。规格已列为非目标。
- **legacy 回退分支没有端到端跑过**：需要用非 vite 的静态服务器托管 `dist/`，本次受「只许开 5199」的约束未做。代码路径是原样保留的 HEAD 实现，入口由 `doProbe()` 的 fetch 失败 / 非 JSON content-type 两个分支进入。
- **搬家时 Dexie 抛错会直接报错停在错误页**，不写 `meta`。这是刻意的：把「库损坏/被别的标签页阻塞」当成空库去播种，会永久关闭自动搬家的窗口。代价是 IndexedDB 被浏览器禁用的环境下也进不去（改造前能进）。
- `settings.userName` 在搬家后会被 `App.tsx:284-296` 的 profile 自愈逻辑改写。这是 HEAD 既有行为（IndexedDB 时代同样如此），不是搬家丢数据。

## 附录 C：独立审查记录

审查日期：2026-09-06。审查者在实施方交付后独立复核，以下改动由审查环节直接落在 worktree 里。

### C.1 审查中修掉的问题

1. **`doInit()` 在探测失败后重试会拿默认值覆盖磁盘（最严重，已修）**。`services/db.ts:437`。
   `probeBackend()` 在 `mode` 已定时是空转（`db.ts:121-131`），不会重新拉快照；而 `doProbe()`
   读到 500 时是**先**把 `mode` 置成 `'file'`、**后**才抛错（`db.ts:154-161`），于是失败之后
   `mode === 'file'` 而 `bootSnapshot === null`。此时任何第二次 `initDB()` 都会把
   `bootSnapshot?.meta` 的 `undefined` 当成「meta 缺失 = 首次启动」，直接走进搬家/播种分支：
   IndexedDB 里有数据就拿（可能很旧的）IndexedDB 覆盖 `data/`，IndexedDB 空就拿 `INITIAL_*`
   把 agents / providers（含明文 key）/ groups / settings 全部写成默认值。
   这正是整个改造要防的「读失败 → 默认值 → 覆盖写回」。
   修法：`doInit` 里补一行 `if (!bootSnapshot) bootSnapshot = await fetchAll();`，没有快照就重读，
   读不动就继续抛。
   **可达性说明**：当前 `App.tsx` 只在 bootstrap effect 里调一次 `initDB`，StrictMode 的两次
   调用会被单飞 promise 合并成同一个 in-flight promise，所以**今天的代码路径大概率打不到**；
   它是一颗地雷（任何「重试初始化」的按钮、任何顺序化的二次调用都会引爆），不是现网故障。
   回归测试见 `D4`（修复前该断言失败并抛 `Cannot read properties of undefined (reading 'count')`，
   证明确实走到了 Dexie）。

2. **`importSnapshot()` 只覆盖不删除（附录 B.2 偏离 ④，已修）**。`services/db.ts:729-772`。
   「恢复到某个备份」实际得到的是「备份 ∪ 磁盘残留」，用户以为删掉的会话刷新后复活。
   修法：新增服务端 `GET /api/db/sessions` 只列 id 不读内容（`server/localdb.ts`），导入时
   算出备份里没有的 id 逐个 DELETE。三个刻意的选择：
   - 用「只列名」的新端点而不是 `/all`：`/all` 要把几十 MB 全读一遍，而且任何一个坏文件
     就会 500，导致「数据坏了才来导入备份」这个最需要导入的场景反而导不进去；
   - 删除放在覆盖写**之后**：中途失败时磁盘是「备份 ∪ 残留」，比「表写了一半 + 已删干净」好收拾；
   - 列举失败时**降级成只覆盖不删除并 console.error**，绝不让清扫失败连累整个导入。

3. **`/api/db/*` 的访问闸门（已加）**。`server/localdb.ts` `isRequestAllowed()`。
   `GET /api/db/all` 直接吐明文 API key，原实现对 `req.socket.remoteAddress` / `Host` / `Origin`
   一概不看，只要哪天加了 `--host` 就等于把 key 挂到局域网上。按主循环要求收进**单一函数**：
   - A 组「回环闸门」（受 `ACO_ALLOW_LAN=1` 控制，默认关闸）：TCP 对端必须回环；`Host` 必须是
     回环名（这条挡的是 DNS rebinding —— 攻击者把 evil.com 解析到 127.0.0.1 时对端是回环、
     Origin 与 Host 也自洽，只有 Host 里的名字能暴露它）。
   - B 组「Origin 同源校验」：**与开关无关，永远生效**。
   二期「手机在局域网访问」就在这一个函数里改成「非回环请求剥掉 apiKey + 校验 token」。
   原实现本来就没有输出任何 CORS 头、也不响应 OPTIONS（预检拿到 405），跨站读写本来就进不来，
   这层是纵深防御 + 挡住非浏览器直连。

4. **`loadAllData()` 的脏检测基线登记错位（已修）**。`services/db.ts:539-549`。
   原来无条件用「最终返回的 sessions」去填 `lastSavedSessions`；当 `data/sessions/` 整个不存在
   （`snap.sessions === null`）而 `meta.json` 还在时，退回的 `INITIAL_SESSIONS` 会被登记成
   「已写盘」，于是这批种子会因为引用没变而**永远写不下去**。改成只登记真的从磁盘读到的那批。

5. **keepalive 的 60 KB 判据用错了单位（已修）**。`services/db.ts:250-258`。
   `body.length` 是 UTF-16 字符数，中文一个字 3 字节：6 万字的中文会话（≈180 KB）会被当成
   「小体积」挂上 `keepalive`，浏览器直接 reject 掉整个请求 —— 在 `pagehide` 这个最不该丢写的
   时机静默丢写。改成字符数快筛 + `TextEncoder` 量真实字节数。

### C.2 审查跑过的验证

- `tsc`（规格第 7 节命令，含 `server/localdb.ts`）：改动后 0 错，与 HEAD 的 0 错持平；`npm run build` 通过。
- 服务端 HTTP 层 **72 条断言**：PUT/GET 回读、DELETE 幂等、12 种非法 `:id`（含 `%2e%2e`、`%2E%2E`、
  `%00`、超长、裸 socket 未归一化路径）、坏 JSON 400、损坏文件 500、缺文件 missing、405/404、
  无 CORS 头、并发同 key 25 路、跨 key 并发、4 MB body、`.tmp-` 零残留、闸门 10 条。
- 插件单元层 **12 条**：非回环 `remoteAddress` → 403（vite 只 listen 回环，HTTP 层测不到这条）、
  IPv4-mapped / IPv6 回环放行、非 `/api/db` 路径原样 `next()`、`ACO_ALLOW_LAN=1` 前后的语义差分。
- 客户端层 **40 条**（用真实 `services/db.ts` 打真实服务端，Dexie 换成一碰就报错的替身）：
  引用未变零写、只重写变了的那一个、消失即 DELETE、**maxWait 在持续写入下实测 ~2.0 s 落盘一次**、
  flush 幂等、写失败保持脏且下次重发、成功后不再重发、跨 key 各发一次、空数组保护、
  导入清扫、清扫降级、5 种坏备份被拒且磁盘不动。
- 损坏场景 **各 7 条**（整表文件 / 单个 session 文件，全新进程）：`initDB` 与 `loadAllData` 都抛错、
  磁盘一个字节没变、修好后重试成功、重试后数据完整（这条即 C.1.1 的回归）。
- 真实浏览器（仅 `localhost:5198`）：种子初始化一次（StrictMode 单飞生效，日志只有一条）、
  app 自己发的 PUT 能过新闸门、导入清扫在浏览器里同样生效、
  **IndexedDB 灌数据 → 删 `meta.json` → 刷新 → 5 张表全搬到 `data/`，IndexedDB 计数与内容一字未动**。

### C.3 审查方也没测到的

- legacy(Dexie) 回退分支端到端（需要非 vite 的静态服务器托管 `dist/`）——审查harness 里 Dexie 是替身。
- 真实 61 MB 规模；`/api/db/all` 返回 61 MB 时的客户端内存峰值只做了纸面评估。
- 256 MB 请求体的 413（实施方测过，审查方未重跑）。
- 多标签页并发；真实流式回复下的端到端。
