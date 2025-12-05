# AI群聊观察会 - 开发交接笔记

> 给下一个 Claude 的备忘录

## 项目概述

这是一个 **AI 群聊模拟器**，让多个 AI 角色在群里聊天，用户可以观察或参与。

**技术栈：**
- React + TypeScript
- Tailwind CSS (通过 CDN，注意 `darkMode: 'class'` 配置在 index.html)
- Vite
- Dexie (IndexedDB) 用于本地存储

**核心文件：**
- `App.tsx` - 主逻辑，消息处理，autoplay
- `components/Sidebar.tsx` - 控制面板，角色/供应商/设置管理
- `components/RightSidebar.tsx` - 群聊成员管理
- `services/` - API 服务 (openaiService, anthropicService, geminiService, searchService)
- `types.ts` - 类型定义
- `constants.ts` - 常量，头像映射

---

## 最近完成的功能

### 1. 群聊共享搜索 (已完成)

**两种触发方式：**
1. 用户手动：输入 `/search 关键词`
2. AI 自主：AI 输出 `{{SEARCH: 关键词}}`（需配置搜索工具）

**相关文件：**
- `types.ts` - `SearchConfig`, `Agent.searchConfig`, `Message.isSearchResult`
- `services/searchService.ts` - 支持 Serper/Brave/Tavily/Metaso
- `components/Sidebar.tsx` - 角色编辑中的搜索工具配置 UI
- `components/ChatBubble.tsx` - 搜索结果可折叠显示

**注意：**
- Brave/Metaso 有 CORS 限制，推荐用 Serper 或 Tavily
- AI 搜索后再次触发时 `disableSearch=true`，防止循环

### 2. 每个群聊独立成员列表 (已完成)

**改动：**
- `ChatSession` 新增 `memberIds?: string[]`
- 添加/移除成员操作的是 `session.memberIds`，不影响全局 agents
- 兼容旧数据：没有 memberIds 时使用 `isActive` 过滤

**每个群聊独立的功能：**
| 功能 | 状态 |
|------|------|
| 成员列表 | ✅ memberIds |
| 场景设定 | ✅ scenario |
| 记忆摘要 | ✅ summary |
| 管理员笔记 | ✅ adminNotes |
| 禁言列表 | ✅ mutedAgents |

### 3. 角色启用/停用 + 保存配置
- `Agent` 类型有 `isActive?: boolean` 字段
- 编辑角色时使用 **draft 状态**，不会立即影响正在聊天的 AI
- 点击"保存配置"后才生效

### 4. 其他
- 禁言时间叠加（不是重置）
- 图片格式检测修复 (magic bytes)
- 文本选中样式修复 (`::selection`)
- 系统提示词优化 (PASS 机制、身份识别)

---

### 5. 群组层级结构 (已完成)

**结构：**
```
群组 A (成员: Claude, GPT, Gemini)
├── 对话 1: 聊技术
├── 对话 2: 聊哲学
└── 对话 3: 聊游戏

群组 B (成员: Claude, DeepSeek)
├── 对话 1: 项目讨论
└── 对话 2: 代码审查
```

**实现：**
- `types.ts` - 新增 `ChatGroup` 类型，`ChatSession` 添加 `groupId` 字段
- `services/db.ts` - 添加 groups 表，版本2包含迁移逻辑
- `constants.ts` - 添加 `INITIAL_GROUPS`
- `components/Sidebar.tsx` - 两级结构 UI（群组可展开，显示对话列表）
- `App.tsx` - 群组管理 handlers，成员管理作用于群组

**共享 vs 独立：**
| 功能 | 归属 |
|------|------|
| 成员列表 | Group (共享) |
| 场景设定 | Group (共享) |
| 记忆配置 | Group (共享) |
| 消息记录 | Session (独立) |
| 记忆摘要 | Session (独立) |
| 管理员笔记 | Session (独立) |
| 禁言列表 | Session (独立) |

**数据迁移：**
- Dexie 版本2自动为每个旧 session 创建一个同名 group
- 旧数据的 memberIds/scenario/memoryConfig 迁移到 group

### 6. 图片自动压缩 (已完成)

- `types.ts` - `GlobalSettings.compressImages`, `maxImageSizeMB`
- `services/fileParser.ts` - Canvas 压缩逻辑
- `components/Sidebar.tsx` - 设置页开关和阈值滑动条

### 7. Gemini 原生 Google 搜索 (已完成)

**功能：** Gemini 模型可使用内置 Google Search Grounding，无需额外 API Key。

**相关文件：**
- `types.ts` - `Agent.enableGoogleSearch?: boolean`
- `services/geminiService.ts` - 传入 `tools: [{ googleSearch: {} }]`
- `components/Sidebar.tsx` - 仅 Gemini 供应商的角色显示开关

**与 searchConfig 的区别：**
- `searchConfig`: 第三方搜索 (Serper/Tavily)，需 API Key，结果作为单独消息
- `enableGoogleSearch`: Gemini 原生，无需 API Key，结果融入回复

### 8. 流式占位符对 AI 不可见 (已完成)

**问题：** AI 生成时的占位符（空内容）会让其他 AI 困惑。

**解决：**
- `types.ts` - `Message.isStreaming?: boolean`
- `App.tsx` - 创建占位符时 `isStreaming: true`，完成后清除
- 三个 Service 文件 - 过滤掉 `isStreaming` 的消息

### 9. 群组级别管理员 (已完成)

**改动：** 管理员权限从 Agent 级别移到 Group 级别。

**相关文件：**
- `types.ts` - `ChatGroup.adminIds?: string[]`
- `components/RightSidebar.tsx` - 成员卡片加管理员徽章和切换按钮
- `components/Sidebar.tsx` - 移除角色编辑器里的管理员开关
- `App.tsx` - `handleToggleAdmin` 函数，传 `groupAdminIds` 给 services
- 三个 Service 文件 - 用 `groupAdminIds?.includes(agent.id)` 替代 `agent.role === ADMIN`

**效果：** 同一个角色在不同群组可以有不同权限。

---

## 注意事项

### 代码风格
- 使用中文注释和 UI 文本
- Tailwind 类名保持一致的暗黑模式支持 (`dark:xxx`)
- 三个 API 服务文件的系统提示词结构相似，改一个要同步改其他两个

### 容易踩的坑
1. **Tailwind CDN** - 不是 PostCSS 编译，是运行时 CDN，配置在 index.html
2. **拖拽冲突** - 整个卡片 draggable 会影响内部输入框，要限制到手柄
3. **draft 状态** - 编辑角色用 draft，启用/停用用真实 agent 数据
4. **图片 MIME 类型** - 浏览器 file.type 不可信，要检测 magic bytes
5. **useCallback 闭包** - triggerAgentReply 内部要重新计算 sessionMembers

### 文件结构
```
D:\ai-chat-observer\
├── App.tsx              # 主组件
├── components/
│   ├── Sidebar.tsx      # 左侧边栏（角色/供应商/设置）
│   ├── RightSidebar.tsx # 右侧边栏（群聊成员管理）
│   └── ChatBubble.tsx   # 消息气泡
├── services/
│   ├── openaiService.ts
│   ├── anthropicService.ts
│   ├── geminiService.ts
│   ├── searchService.ts  # 搜索服务
│   ├── modelFetcher.ts
│   └── fileParser.ts
├── types.ts
├── constants.ts
├── src/
│   ├── main.tsx
│   └── index.css
├── public/logos/        # AI 头像 SVG
└── mofalajidui/         # 你现在在这里 :)
```

---

## 用户偏好

- 喜欢简洁的 UI，不要太花哨
- 中文界面
- 喜欢渐进式开发，先做简单版再迭代
- 会观察 AI 群聊并反馈问题

---

祝你好运！
