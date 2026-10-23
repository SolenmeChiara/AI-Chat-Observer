# 群组共同往事（Group Shared Memory）施工档案

> 状态：已实现，待审查。起草 / 施工 2026-10-22。
> 关联：`MEMORY_COMPACTION_PLAN.md`（会话归档边界，本功能挂在它的归档流程上）、`PHONE_ACTIONS_PLAN.md`（手机动作通道）。

## 0. 一句话

在「群剧本」和「会话总结」之间加一层**跨会话**的群组记忆：每次会话归档时，总结模型把刚归档的
**公开**消息提炼进 `ChatGroup.sharedMemory`（滚动合并、去重、有长度上限）；同群新开会话时模型
仍然记得之前发生过的事。可以手改、清空、从当前对话手动提炼，手机端也能看和改。

## 1. 为什么

记忆原本只有会话级（`ChatSession.summary` + `privateSummaries`），群组上只有手写的静态 `scenario`。
同一个群开新会话，之前所有会话里发生的事全部遗忘——角色的习惯、梗、关系进展都要重来。

## 2. 设计（定稿）

### 2.1 三层记忆

| 层 | 作用域 | 来源 | 提示词位置 |
|---|---|---|---|
| `scenario` | 群，静态 | 手写 | stable 层头部 `[SCENARIO]` |
| `sharedMemory`（新） | 群，跨会话 | 归档时自动提炼 / 手写 | memory 层头部 `[GROUP HISTORY]` |
| `summary` + `adminNotes` | 会话 | 归档 | `[SHARED MEMORY]` |
| `privateSummaries[agentId]` | 会话，按 agent | 私讯归档 | `[PRIVATE MEMORY]` |

数据：`ChatGroup.sharedMemory?: string`、`sharedMemoryUpdatedAt?: number`（types.ts）。两个字段都是可选，
老数据没有它们照常加载；db.ts / localdb 是整对象存取，不需要迁移。

### 2.2 自动提炼（App.tsx `runArchive`，步骤 2.5）

- 时机：公共总结 + 私人总结都成功之后、世代校验之前；与会话归档**同一刻提交**（同一渲染批），
  一次归档只打断一次缓存前缀。
- 输入：该群现有 `sharedMemory` + **本批被归档的公开消息**（`range.filter(m => !m.pmTargetId)`）。
  - 选「本批原文」而不是「刚生成的会话总结」：会话总结是叙事体、会被压缩，像「Astra 吃饭戴手套」
    这种细节最容易在压缩里丢；而且每次都喂整份累积总结，等于让旧内容被反复重新合并、越滚越偏。
    喂本批原文，每条公开消息恰好被提炼一次。代价是多一次与总结调用同量级的输入 token。
  - 私讯一律滤掉，**与 `excludePM` 无关**（`excludePM=false` 时公共总结里混着私讯，所以也不喂会话总结）。
    `privateSummaries` 从不进入提炼函数；`distillGroupMemory` 内部再按 `pmTargetId` 滤一遍兜底。
- 模型：沿用该群 `memoryConfig.summaryProviderId / summaryModelId / summaryMaxTokens`（与归档同一套）。
- prompt：`summaryService.distillGroupMemory`，标识 `[GROUP MEMORY TASK]`。只收跨会话仍成立的东西
  （习惯、梗、关系、值得回提的事件与约定），短条目列表，合并去重，用对话的语言，
  长度上限 `GROUP_MEMORY_MAX_CHARS = 1500` 字 / `GROUP_MEMORY_MAX_WORDS = 800` 词（只约束模型，不截断）。
- 失败隔离：提炼包在独立 try/catch + 90 s 超时（`GROUP_MEMORY_DISTILL_TIMEOUT_MS`，Gemini SDK 分支自身无超时）。
  失败 / 超时 / 返回空 / 原来有内容却回 `NONE` / 输出超过 `GROUP_MEMORY_REJECT_CHARS`（16000）→ 只打 warning，
  归档照常提交，原共同往事不动，**不记归档失败退避**。
- 并发：`commitGroupMemory` 是比较再交换——提交时群里的 `sharedMemory` 已不等于提炼开始时的 base
  （用户手改了 / 同群别的会话先提交了一版）就作废本次结果，不覆盖。归档在世代校验处作废时提炼结果一起丢掉
  （那批消息下次会重新归档、重新提炼）。

### 2.3 注入

`buildMemoryContext(summary, adminNotes, privateSummary, groupMemory)`：`groupMemory` 非空时在 memory 层最前
输出 `[GROUP HISTORY]` 段，再接原有 `[SHARED MEMORY]`。为空 / 全空白时**输出与 HEAD 逐字节一致**。
放 memory 层头而不是 stable 层：stable 层（剧本 + 人设 + 协议）在整个会话里不变，共同往事只在归档时变，
和会话总结同频，放进 memory 层不会让 stable 前缀失效。四个 adapter 的参数一律追加在最末（`groupMemory?`），
图片生成路径的手写 header 也在 `[Scenario]` 与 `[Summary]` 之间加了 `[Group History]`。

### 2.4 电脑端 UI

侧栏「当前群组配置」里剧本下方新增「共同往事」卡片：可编辑文本框（函数式 `setGroups`）、「清空」（确认后清掉）、
「从当前对话提炼」按钮（不等归档，把当前会话边界之后的公开消息最多 150 条提炼进来；会话总结只在
`excludePM=true` 时作背景给，不动归档边界与会话记忆；没选总结模型时禁用）。

### 2.5 手机端

- bootstrap 的 `projectGroup` 增投 `sharedMemory`、`sharedMemoryUpdatedAt`（与 scenario 同级可见性，只含公开内容）。
- 新动作 `group.memory.update { groupId, text }`：非会话级；整段覆盖写，`text` 为空串 = 清空。
  服务端校验形状与 `ACTION_LIMITS.groupMemory = 16000` 字（中文 ≈ 48 KB，装得进 64 KB 请求体）；
  电脑端判群是否存在（`group-not-found`），写入走与电脑端同一个 handler。
- 观众端侧栏「共同往事」面板（`viewer/panels/GroupMemoryPanel.tsx`）：草稿 + 基线，与 ProfilesPanel 同套路；
  打开期间电脑端出了新版本、而本地有未保存改动时提示「保存会覆盖它」。

## 3. 验证（2026-10-22）

- `tsc --noEmit`（tsconfig.json 与 tsconfig.node.json）0 错；`vite build` 通过。
- 离线单测（scratch 脚本，假 fetch）：`buildMemoryContext` 在 groupMemory 为 undefined / 空 / 全空白 × 4 组输入时与 HEAD 逐字节一致；
  非空时顺序为 GROUP HISTORY < SHARED MEMORY < PRIVATE MEMORY；提炼 prompt 不含私讯与 streaming 消息；
  `NONE` / 超长 / HTTP 失败 / 网络异常均返回 null 不抛错。
- 临时端口 :5199 + 临时数据目录 + 假 OpenAI 兼容端点 + 全新无头浏览器：归档后共同往事写入、提炼请求只含被归档的公开消息
  （不含保留尾巴、私讯、私人记忆、会话总结）；同群新会话触发发言，系统提示里 SCENARIO < GROUP HISTORY < SHARED MEMORY；
  提炼端点返回 500 时归档照常推进、共同往事不变、有 warning；手机动作正常写入 / 未知群 / 超长 / 缺字段 / 多余字段 / 16000 中文字；
  电脑端编辑框、「从当前对话提炼」、观众端面板编辑保存。

## 4. 未测 / 遗留

- 未测：真实模型的提炼质量（合并去重是否稳、长度是否守得住）；Gemini / Anthropic 两条提炼分支（只测了 OpenAI 兼容）；
  真机手机与外网链路；同群两个会话真正并发归档时的比较再交换作废路径（逻辑在，未构造出来）。
- 自动提炼让每次归档多一次总结模型调用，费用照记进 totalCost。
- 归档提交在 `setSessions` updater 里因「边界消息已被删除」作废时，共同往事仍会提交（两者分属两张表，
  无法在同一 updater 里原子判断）；后果只是那批内容日后可能被再提炼一次，由去重规则吸收。
- 电脑端文本框每敲一个字都会写一次 groups 并广播给手机（与剧本框同一既有行为）。
