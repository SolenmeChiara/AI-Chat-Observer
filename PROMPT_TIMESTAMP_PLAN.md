# Prompt / 时间戳整改工程档案(2026-08-27)

本轮工程由两次审计驱动:prompt 拼装链路审计 + 时间戳全链路审计。本文档是施工档案,
session 重启后从「进行中」一节接续。

## 已完成(均已提交推送)

| commit | 内容 |
|---|---|
| `7936e8a` | native 轨历史消息不再强制包装 `{{RESPONSE:}}`(formatMessageText 加 mode 参数) |
| `0267cdd` | REPLY 教学补「id 从 [ID: ...] 标签里抄」的锚点 + 「别自己写标签」兜底 |
| `10cfb87` | 引用预览带上被引消息的 ID 与发送者名(新增 shared.formatReplyPreview,四链路统一) |
| `230309a` | SILENCE 不带时长真正永久生效(`\|\|30`→`??30`);REPLY 示例去除自相矛盾的时间标签 |
| `e8a1921` | 摘要输入带时间戳;落库前剥离模型模仿的伪日志标签(stripImitatedLogLabel,审查修补×2) |
| `6554f17` | 每秒变化的 [NOW] 行移出缓存前缀(SystemPromptParts 三层拆分),历史增量缓存真正命中 |

## 统一标签批次(已完成,与本文档更新同 commit)

Sol 拍板:**每条历史消息统一带 `[ID: xxx] [MM-DD HH:mm]` 头(ID 前、时间后),含
agent 自己的消息、搜索结果、Anthropic thinking 回忆块**。已实施(opus 实施 +
独立 opus 审查 PASS_WITH_NOTES,两条一行修补已采纳):

1. formatMessageText 去 isSelf 裸文本分支,全消息全标签,ID/时间对调,签名去掉
   isSelf/addTimestampToSelf;anthropicService 手抄重复实现改调 shared 版;
2. [OUTPUT FORMAT] 两轨整头禁令;native 示例毫秒值 1787855460000 与 08-27 14:31
   在本机时区(America/New_York)自洽——**换时区跑会轻微失配,仅示例观感**;
3. stripImitatedLogLabel 适配 ID-first(新旧顺序都认,行为差分零倒退);
4. `[Replying to [ID: xxx] ...]` 行首宽进 → detectedReplyId(显式 {{REPLY}} 优先);
   分段消费开始后冻结前缀(审查 N2 修补);
5. Anthropic 缓存账目:input = uncached + 0.1×read + 1.25×write(加权 token 当量,
   美元数准确;Message.tokens 无渲染点,字段不再是字面 token 数)。

审查已知项(未修,接手前先读审查报告原文):引文含 `"]` 时预览提前收尾留残渣
(罕见);[SPLIT] 第 2 段起不做预览剥离(只跑 stripImitatedLogLabel);
summaryService transcript 仍为 time-first 格式(另一条通道,有意未改);
formatMessageText 的 agent 形参已是死参。

## 部署后验证(Sol 实跑)

- devtools console 看 `[Anthropic] 💾 Cache: N read, M written` —— 缓存修复生效判据:
  第 2 轮起 read ≈ 上轮整段历史,written 只剩增量;
- 开 [SPLIT] 群连说 3 轮,气泡与 IndexedDB 的 text 均无 `[ID:]/[时间]` 头;
- 触发一次记忆摘要,确认摘要出现真实时间段落;
- 观察 RESTRAINT 场景 PASS 率有无异动(attention 指令从 system 移入 user 轮尾部,
  审查 N3,预计中性偏正)。

## 后续批次(2026-08-28)

- **REPLY 工具化**(9573931 + 文档 c74999c):引用回复成为第 11 个 native 工具,
  quote-only 空正文回合走 PASS。冒烟重点:OpenAI 兼容 native agent 引用时是否吐正文
  (审查 N1:该系惯例 tool_calls+content:null,引用即哑火+5 条冷却,无 follow-up 兜底,
  实测普遍空正文再议);被引者是否拿到下一轮;text 轨混群零影响。
- **Persona 切换修复 + i18n 一帧滞后**(da14997):设置页「设为当前」补写 legacy 三件套,
  加载时自愈错位库;App 的 tt 改为从 settings.language 直接派生。

## 暂缓清单(审计发现、Sol 未点名,按价值排序)

- **i18n 硬编码中文批次**(诊断报告 P1/P2):TTS 描述、modelFetcher/searchService/
  provider 报错文案约百处绕过 i18n;en 表缺 4 个 key(App.tsx 搜索限流两处);
  exportHtml/Sidebar 硬编码 zh-CN locale;index.html lang/title 不随设置变。体力活,
  适合 sonnet 批量。
- **Persona 结构性改造**(诊断修复 3):停用 legacy 三件套作权威源,消费点(约 15 处)
  改为按 activeProfileId 派生;narrator 回落语义需显式保留。
- **isFormatError 不跑伪标签清洗**(REPLY 工具化审查 N2,既有缺口):正文只有伪预览行/
  伪日志头时仍落空气泡(现在还带 replyToId)。修法:nativeCleanedBody 链尾追加两个纯
  函数,会连带改变纯文本场景行为,单独一批。

- **正向语用教学**(第一轮审计 S1):native 轨全上下文抑制:鼓励 = 6:1,无任何
  「针对具体内容回应」教学。若统一标签批次后 agent 仍「接不上话」,这是下一刀。
- **attention 判定收紧**(S5/F5):无词边界子串匹配 + 只看最后一条,短名/常见词名
  agent 被大面积误判;RESTRAINT 泛滥压制针对性。
- **[PROTOCOL NOTE] 收窄**(S4):native 轨「勿模仿 {{...}}」与 REPLY/PASS 教学相邻
  且方向相反,建议明示排除自身标记。
- **[NOW] 行格式统一**(R6):`toLocaleString()` 跟随宿主 locale(en-US 出 12 小时制),
  与历史行 24h 制不一致;历史行无年份跨年歧义。改 formatMessageTime 会击穿全部历史
  缓存,挑空闲时机。
- **导出 HTML 时间**(R7/F8):只有时分秒无日期,时区跟观看设备走,locale 硬编码 zh-CN。
- **PM 文本未过伪标签清洗**(e8a1921 已知未修):extractedPMContent 直落库,暴露面仅
  RESPONSE+PM 并存。
- **OpenAI/Gemini 缓存 token 账目**:同 N5 类问题,cached_tokens 未入账,未改。
- **N6**:短人设时 Anthropic stable 段 <1024 token,断点 1 静默空转(既存,无害)。
- **窗口裁剪在可见性过滤之前**(F7/S8):BLIND/屏蔽场景实际窗口远小于名义值;换序
  影响缓存锚点,需重评 STRIDE。
- **禁言到期靠 60s 定时器**(F7):最多过度禁言 60 秒;RightSidebar 倒计时不刷新。
- **{{PASS}} 全文子串检测**(S9):正文任何位置出现即整条丢弃;REPLY 正则不容忍前导
  空白(四处)。types.ts commandMode 注释过时。
- **statsService / ttsService 等未审计**(时间戳审计如实声明的盲区)。
