# 工具抽象层规划(Tool Abstraction Layer Plan)

> 状态:规划定稿,未开工。
> 目标:同一套 agent 能力,支持 function calling 的模型走原生 tools,老模型继续走文本协议。两轨可在同一个群里共存。
> 本文档基于 2026-07-10 的代码侦察,行号以当时代码为准(commit 6178c62 附近)。

---

## 1. 背景与现状

当前所有 agent 能力靠「文本协议」实现:模型在输出里嵌 `{{PASS}}`、`{{SEARCH: query}}` 等指令,前端正则解析。协议教学集中在 `services/shared.ts` 的 `buildProtocols`(101-199)+ `buildSystemPrompt`(204-241);解析与分发在 `App.tsx` 的 `triggerAgentReply`(1075-2141)。

文本协议的优点是任何模型都能用;缺点是脆(格式写歪就漏)、费 token(教学文本 + wrapper)、有格式泄漏类 bug(如 humanDisguise 被 RESPONSE wrapper 出卖)。

现有协议 token 全集(14 个):

| token | 语义 | 类型 |
|---|---|---|
| `{{RESPONSE: 内容}}` | 发言(裸文本一律丢弃) | 正文包装 |
| `{{PASS}}` | 沉默(流中即时 break) | 表态 |
| `{{REPLY: id}}` | 引用某条消息 | 标记 |
| `{{SEARCH: query}}` | 联网搜索(进搜索事务) | 请求-响应 |
| `{{SILENCE: 30min}}` | 自我禁言 | 动作 |
| `{{MUTE/UNMUTE: Name}}` | admin 禁言/解禁 | 动作 |
| `{{NOTE/DELNOTE/CLEARNOTES}}` | admin 群公告板 | 动作 |
| `{{RES_PM_Name: 内容}}` | 私聊(可与公开发言并存) | 内容 |
| `{{ROLL: 2d6+1}}` / `{{TAROT: 3}}` | 骰子/塔罗(客户端算结果) | 动作 |
| `[SPLIT]` | 单条回复切多气泡 | 纯显示 |

解析时机是混合式:流中逐 chunk 检测(实时显示 + PASS 提前中断),流结束后统一做权威抽取与副作用执行(App.tsx 1786-2088)。

原生 tools 现状:全项目仅两处——Gemini `googleSearch` grounding(geminiService.ts:244)、OpenAI Responses `image_generation`(openaiService.ts:512)。Anthropic 与 OpenAI Chat 两路完全没碰过 tools。Anthropic/OpenAI 均为裸 fetch 手写 SSE 解析,无 SDK;Gemini 用官方 `@google/genai` SDK。

四条流式函数(`streamGeminiReply` / `streamAnthropicReply` / `streamOpenAIReply` / `streamOpenAIResponsesReply`)接口同构:统一返回 `AsyncGenerator<StreamChunk>`,`StreamChunk` 定义在 types.ts:238-246。分发点 App.tsx:1448-1486 按 `provider.type` + `openaiApiMode` 分四路。

---

## 2. 架构设计

### 2.1 三个核心决策

**决策一:解析双轨,分发单轨。**
新增统一中间表示 `CapabilityCall { capability: string; args: Record<string, unknown> }`。原生轨把 tool_use 解析成 `CapabilityCall`,通过 `StreamChunk` 新增字段 `toolCalls?: CapabilityCall[]` 传出;App.tsx 在流消费处把 toolCalls 映射进现有的 detected 系列变量(`isPass` / `detectedSearchQuery` / `detectedAdminAction` …),此后走**完全不变**的现有分发逻辑(1730-2088)。文本轨正则解析原样保留。这样原生轨上线不碰两千行分发代码,风险封在 service 层。

**决策二:原生轨「正文即发言」,PASS 沿用文本标记。**
原生轨不再需要 `{{RESPONSE:}}` wrapper——模型直接输出的文本就是发言;想沉默就输出 `{{PASS}}`(**不做成工具**,沿用文本标记);空输出视同 PASS(与现有 isFormatError 行为一致,App.tsx:1847)。这样省 token、杜绝 wrapper 泄漏类 bug、输出更自然。三家 API 都支持正文与 tool call 并存(Anthropic text+tool_use blocks / OpenAI content+tool_calls / Gemini text part + functionCall part),所以「发言 + 搜索」同回合仍然成立。

PASS 不工具化的理由(Sol 拍板,2026-07-10):工具的价值在结构化参数,pass 无参数,工具化只有仪式感;而 `{{PASS}}` 的文本检测(含流中提前 break 的优化,App.tsx:1561-1564)在原生轨的流消费循环里零成本继承。由此确立**工具化取舍原则:带结构化参数、有格式出错风险的能力才值得工具化;纯标记类沿用文本**。据此 `{{REPLY: id}}` 同样保留文本标记。

**决策三:SEARCH 复用现有搜索事务,不做请求内 loop(Phase 3 再议)。**
原生轨模型调用 `search` 工具后,本回合正常结束,搜索结果照旧作为系统消息落地,由现有 searchTxnRef 事务(App.tsx:144, 1968-2060, 2489-2517)驱动二次触发。**不存在 tool_use/tool_result 配对问题**:本项目每次请求的历史是从群聊记录重新文本化拼装的(filterVisibleMessages → 群聊 log),上一回合的 tool_use block 根本不会以 API 原生形态进入下一次请求,所以无需回传 tool_result。请求内多轮 loop(同回合拿到结果继续说)留作 Phase 3 增强。

### 2.2 能力注册表(新文件 `services/capabilities.ts`)

```ts
interface CapabilityDef {
  id: string;                      // 'pass' | 'search' | 'mute' | ...
  description: string;             // 工具描述,双轨共用语义源
  paramsSchema: object;            // JSON Schema(原生轨用)
  availability: (ctx: CapabilityContext) => boolean;  // admin/hasSearch/娱乐开关
}
```

`CapabilityContext` 即现在 `buildProtocols` 的参数集(agent、groupAdminIds、hasSearchTool、entertainmentConfig、成员名单)。注册表输出「本回合可用能力清单」,两个消费者:

- **文本轨**:`renderTextProtocols(caps)` → 生成现在 buildProtocols 的那几段教学文本(重构,输出语义不变);
- **原生轨**:`renderToolSchemas(caps, providerKind)` → 各家格式的 tools 数组。

### 2.3 能力语义映射表

| capability | 参数 | 原生轨执行语义 | 对应现有处置(不改) |
|---|---|---|---|
| ~~pass~~ | — | **不工具化**:两轨都用 `{{PASS}}` 文本 | App.tsx:1849-1881(yieldedAgentIds) |
| `search` | `query: string` | 进搜索事务 | App.tsx:1968-2060 |
| ~~reply_to~~ | — | **不工具化**:两轨都用 `{{REPLY: id}}` 文本 | replyToId(App.tsx:1716) |
| `set_silence` | `duration?` | 自我禁言 | admin 动作块 1755-1769 |
| `mute` / `unmute` | `name, duration?` | admin 禁言 | 同上(admin gate 保留) |
| `add_note` / `del_note` / `clear_notes` | `content` / `keyword` / 无 | 群公告板 | 1732-1754 |
| `send_pm` | `target, content` | 私聊,可多次调用 | 1799-1844 |
| `roll_dice` / `draw_tarot` | `spec` / `count?` | 客户端算结果插系统消息 | 2062-2088 |

`[SPLIT]` 不入注册表:它是纯显示层标记,两轨都继续走文本处理(App.tsx:1682-1707)。

availability 与现有条件一一对应:admin 三件套仅 `role===ADMIN`;search 仅 `hasSearchTool && !disableSearch`;pm 仅 `enablePM` 双开关;娱乐按 entertainmentConfig。**文本轨与原生轨的可用性判断必须走同一个函数**,不允许两处各写一遍。

### 2.4 配置与 UI

`Agent` 增加字段 `commandMode?: 'text' | 'native'`(types.ts:75-92)。**缺省语义于 2026-07-10 由 Sol 拍板翻转为 `'native'`**(实测通过后:「现在没几个模型不支持 function calling」)——未显式设置的 agent 一律走原生轨,显式选 `'text'` 才走文本协议(旧模型/剥 tools 的中转站用)。归一化统一走 `getCommandMode()`(capabilities.ts),禁止各处自行判断。混合群(一半 text 一半 native)是一等公民场景,必须测试。

### 2.5 system prompt 的分轨

原生轨的 systemPrompt 组装差异(shared.ts:204-241 加分支或平行函数):
- `[OUTPUT FORMAT]` 段(shared.ts:232-239)去掉 RESPONSE wrapper 教学,换成「直接输出你的发言即可;想保持沉默就只输出 `{{PASS}}`」——PASS/REPLY 的文本教学**保留**(它们两轨通用);
- 已工具化能力的 protocol 教学文本不拼(工具 schema 的 description 自带教学);PASS/REPLY/`[SPLIT]` 等文本标记的教学照拼;
- `buildAttentionInstruction`(shared.ts:43-85)内嵌的 `{{RESPONSE:}}` 字样按轨换措辞(`{{PASS}}` 字样不用动);
- 四个 service 末尾硬编码的触发消息「You MUST wrap your reply in {{RESPONSE:…}}」(geminiService.ts:210-213 / anthropicService.ts:205 / openaiService.ts:159, 489)按轨换文案(原生轨:「直接输出发言,或输出 {{PASS}} 保持沉默」)。**这四处最容易漏,施工时逐一核对。**

---

## 3. 各 provider 原生轨技术要点

### Gemini(最省事,SDK 代劳,建议 pilot)
- 请求:`config.tools = [{ functionDeclarations: [...] }]`(现有 geminiService.ts:244 处扩展);
- 响应:`part.functionCall = { name, args }`,args 已是对象,无需手拼 JSON;chunk 循环(325-367)加一个 part 分支;
- **grounding 与 search 工具是两种功能,不只是技术共存问题**(Sol 澄清,2026-07-10):`googleSearch` grounding 是 Gemini 服务端内部完成的私人搜索——搜索过程与结果都不回传前端、不落群聊,只有该 agent 自己「知道」,且拿不出来;我们的 search 工具是公开搜索,结果作为消息落地、全群共享、驱动搜索事务。两者共存语义合理(私下查证 vs 公开查资料),但有**截胡风险**:两个都开时,模型很可能用 grounding 私下搜完就作答,根本不调 search 工具,且不报任何错。
- 由此:测试 native search 工具时必须**关闭该 agent 的 enableGoogleSearch**,否则测不到;若实测发现 API 层面拒绝混用(报错),再考虑 UI 互斥。长期可在 search 工具的 description 里强调「结果会分享给全群」,给模型一个选它而非内部搜索的理由。
- **grounding + function calling 混用已实测打通**(2026-07-10,commit `348a10a` + `8f08c7a`):仅 Gemini 3 + AI Studio 支持(Preview,Vertex 不支持),需要 SDK ≥ 2.0。两个硬要求:① `googleSearch` 与 `functionDeclarations` 必须**合并进同一个 Tool 对象**(拆成 tools 数组两个条目会触发 400「Please enable tool_config.include_server_side_tool_invocations」,即使 flag 已带上);② `config.toolConfig.includeServerSideToolInvocations: true`(JS SDK 里在 ToolConfig 下;Python SDK 是 config 顶层,两边形状不同勿混)。开 flag 后流里会出现服务端工具调用的 parts(grounding 过程可见),形状待实测——桥接层的 unknown-capability warn 会把它们打出来。
- **运维教训(vite)**:npm 升级依赖后必须重启 dev server——vite 只在启动时决定依赖预打包,热更新不会重载 node_modules 里的新版;升级后浏览器可能继续跑 `node_modules/.vite/deps/` 里的旧缓存(错误栈里 `@xxx.js?v=<hash>` 可与 `.vite/deps/_metadata.json` 的 hash 对照确认)。当年 SDK 2.11 升级后 400 不消失,根因即此。

### Anthropic(裸 fetch,手写 SSE)
- 请求:body 加 `tools: [{ name, description, input_schema }]`(anthropicService.ts:265-271);
- 响应:SSE 加三类事件解析(351-414 处扩展):`content_block_start`(type=tool_use,拿 name/id)→ `input_json_delta`(累积 partial_json 字符串)→ `content_block_stop`(JSON.parse 收尾);`stop_reason: 'tool_use'`;
- 缓存注意:tools 位于缓存前缀,能力清单要稳定排序,开关变动会 cache miss(可接受,不做对策)。

### OpenAI Chat Completions(裸 fetch)
- 请求:`tools: [{ type:'function', function:{ name, description, parameters } }]`;
- 响应:`delta.tool_calls[]` 增量流(index / id / function.name / arguments 字符串逐段拼接),在 290-384 的解析里加状态机;`finish_reason: 'tool_calls'`;
- **坏 JSON 容错**:arguments 拼完 `JSON.parse` 失败时按「无工具调用」处理并 console.warn,绝不让一个坏调用炸掉整条回复;
- 中转站/本地端点(Ollama、LM Studio)对 tools 支持参差——commandMode 现已默认 native(2026-07-10 翻转),这类端点需手动切回 text;识别静默不支持的方法:让 agent 搜索,只说话不出搜索气泡即端点剥了 tools。

### OpenAI Responses(裸 fetch,已有 image_generation 先例)
- 请求:function 工具与现有 `image_generation`(openaiService.ts:511-513)同数组并存,格式为顶层展开 `{ type:'function', name, description, parameters }`;
- 响应:typed 事件解析(595-674)加 `response.output_item.added`(type=function_call)与 `response.function_call_arguments.delta / .done`。

### 流式 UI 细节(四家通用)
tool call 生成期间没有 text delta,占位气泡会像卡死。检测到 tool call 开始时,在气泡里放一条临时提示(如「正在调用 search…」),流结束后由现有清洗逻辑替换为最终内容。

---

## 4. 分阶段实施

每个 Phase 独立 commit、独立可验收,做完即可停,不留半成品。

### Phase 0 — 注册表重构(纯重构,行为零变化)
- 新建 `services/capabilities.ts`:CapabilityDef、注册表、availability;
- `buildProtocols` 改为从注册表生成文本教学,输出语义与现状一致;
- **验收**:`npx tsc --noEmit` + `npm run build` 干净;现有文本轨群聊行为无任何变化(PASS/SEARCH/PM/admin/娱乐全部照旧)。

### Phase 1 — 原生轨最小可用(仅 search 一个工具,Gemini 先行)
- `StreamChunk.toolCalls?: CapabilityCall[]`(types.ts);
- `renderToolSchemas` 的 Gemini 版;streamGeminiReply 请求体 + functionCall part 解析;
- App.tsx 流消费循环加 toolCalls → detected 变量映射(约 30-50 行);
- Agent.commandMode 字段 + 编辑面板下拉;
- 原生轨 system prompt 分轨(2.5 节四处全改);
- **验收**:native Gemini agent 直接输出正文成功发言、输出 `{{PASS}}` 正确沉默(文本标记跨轨继承)、用 search 工具触发搜索事务且二次回复引用结果;text agent 混群共存无异常;text 轨回归无变化。

### Phase 2 — 三家补齐 + 能力补全
- Anthropic → OpenAI Chat → OpenAI Responses 逐家实现(每家独立 commit);
- 能力从 {search} 扩到全集(2.3 节映射表,PASS/REPLY 除外——它们永远走文本);
- **验收**:四路 provider 各建一个 native agent 过全能力冒烟;混合群长跑一场无异常。

### Phase 3 — 增强(按需,不承诺)
- 请求内 tool loop:search/roll 结果以 tool_result 回传,同回合续写(需要各 service 实现多轮循环,搜索事务机制相应简化);
- MCP client:平台直接挂外部 MCP server(浏览器限制:仅 HTTP/SSE transport,且受 CORS 制约,大概率要等后端);
- 娱乐工具升级同回合出结果。

---

## 5. 风险与决策记录

| 风险/决策 | 处理 |
|---|---|
| Gemini grounding 截胡 search 工具(grounding 是服务端私人搜索,结果不落群聊) | 测试时关 grounding;工具 description 强调「结果全群共享」;API 报错才考虑 UI 互斥 |
| 中转站剥 tools / 小模型乱调工具 | 默认已翻转为 native(2026-07-10);问题端点手动切回 text,静默剥 tools 用「搜索不出气泡」识别 |
| 模型输出坏 JSON args | try/catch 按无调用处理,console.warn,不炸回复 |
| tools 破坏 Anthropic prompt cache 前缀 | 能力清单稳定排序,接受开关变动的 cache miss |
| attention/触发消息里的协议字样漏改 | 2.5 节四处清单,施工 checklist 逐条勾 |
| 原生轨模型误输出其他 `{{XXX}}` 文本指令 | 现有清洗链(App.tsx:1886-1898)照跑,无害兜底 |
| PASS/REPLY 不工具化(Sol 拍板 2026-07-10) | 无参数/纯标记类能力工具化收益为零,文本检测零成本继承;确立「带结构化参数才工具化」原则 |

---

## 6. 施工提示(给执行 agent)

- 改 `shared.ts` 前先读完 101-241;改 App.tsx 前先读 1514-1721(流消费)与 1730-2088(分发),**分发逻辑一行都不要动**,你的改动止步于 detected 变量赋值;
- 每完成一个 Phase 跑 `npx tsc --noEmit && npm run build`,并汇报改动文件清单与行号;
- 不确定 API 细节时停下来报告,不要凭记忆猜 SSE 事件名;
- 本文件的行号会随施工漂移,以语义定位为准。
