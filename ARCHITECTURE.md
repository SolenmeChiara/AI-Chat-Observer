# 🏗️ 项目架构文档 (Project Architecture)

本文档详细描述了 **AI 群聊观察会 (V5)** 的代码结构、数据流向及设计理念。旨在帮助开发者快速理解系统，并为后续引入 **向量数据库 (Vector DB)**、**长期记忆 (Long-term Memory)** 或 **后端服务** 提供指导。

---

## 1. 核心设计理念

本项目采用 **Local-First (本地优先)** 与 **Serverless (无后端)** 架构：

*   **状态管理**：React `useState` + `useRef` 控制实时交互与流式响应。
*   **持久化**：使用 **IndexedDB (Dexie.js)** 作为本地数据库，所有数据（API Key、配置、聊天记录）均存储在用户浏览器端。
*   **逻辑分层**：UI 组件只负责渲染，复杂逻辑封装在 `services/` 目录中。
*   **多态适配**：通过适配器模式统一处理 Google Gemini、OpenAI、Anthropic 等不同 API 的输入输出差异。

---

## 2. 目录结构说明

```text
src/
├── components/          # UI 组件层
│   ├── ChatBubble.tsx   # 核心组件：负责渲染消息、Markdown、思维链、附件
│   ├── Sidebar.tsx      # 左侧栏：全局配置、角色编辑、会话切换
│   └── RightSidebar.tsx # 右侧栏：群成员管理、快捷操作
│
├── services/            # 业务逻辑与数据层 (Service Layer)
│   ├── db.ts            # IndexedDB 数据库管理 (CRUD)
│   ├── geminiService.ts # Gemini API 适配器 (含 Prompt 注入)
│   ├── openaiService.ts # OpenAI 兼容接口适配器 (含 Prompt 注入)
│   ├── anthropicService.ts # Claude 原生 API 适配器 (含 Prompt 注入)
│   ├── searchService.ts # 联网搜索服务 (Serper/Tavily/Brave)
│   ├── fileParser.ts    # 前端文件解析 (PDF/Docx -> Text) + 图片压缩
│   ├── modelFetcher.ts  # 远程模型列表获取
│   ├── visionProxyService.ts # 视觉代理 (让纯文本模型"看"图片)
│   └── summaryService.ts# 自动起名与记忆总结服务
│
├── types.ts             # TypeScript 类型定义 (数据契约)
├── constants.ts         # 常量、默认值、Logo 映射
├── App.tsx              # 主控制器 (Controller)
├── main.tsx             # 入口文件
└── index.css            # Tailwind 样式引入
```

---

## 3. 核心数据模型 (`types.ts`)

理解数据模型是扩展系统的关键。

### 3.1 `ChatGroup` (群组) - V5.1 新增
群组是顶层容器，包含多个对话，共享成员和场景设定。
```typescript
interface ChatGroup {
  id: string;
  name: string;
  memberIds: string[];     // 共享的成员列表
  scenario?: string;       // 共享的剧本 (World View)
  memoryConfig: MemoryConfig; // 共享的记忆配置
  createdAt: number;
}
```

### 3.2 `ChatSession` (对话)
存储一个对话的消息记录，归属于某个群组。
```typescript
interface ChatSession {
  id: string;
  groupId: string;         // 所属群组
  name: string;
  messages: Message[];     // 消息列表
  lastUpdated: number;
  mutedAgentIds: string[]; // 禁言名单
  mutedAgents: MuteInfo[]; // 详细禁言信息 (含过期时间)
  yieldedAgentIds: string[]; // PASS 豁免名单

  // 独立记忆 (每个对话单独)
  summary?: string;        // 长期记忆文本
  adminNotes?: string[];   // 管理员临时便签
}
```

### 3.3 `Agent` (智能体/角色)
定义一个 AI 人格。
```typescript
interface Agent {
  id: string;
  name: string;
  providerId: string;      // 关联的供应商
  modelId: string;         // 具体模型 (如 gpt-4o)
  systemPrompt: string;    // 人设
  config: AgentConfig;     // 独立参数 (Temperature, MaxTokens, Reasoning)
  role: AgentRole;         // 'MEMBER' | 'ADMIN'
  isActive?: boolean;      // 是否启用
  searchConfig?: SearchConfig; // 搜索工具配置
}
```

---

## 4. 关键逻辑流 (Logic Flow)

### 4.1 自动对战循环 (Auto-Play Loop)
位于 `App.tsx` 的 `useEffect` 中：
1.  **Check**: 检查并发锁 (`processingAgents`)、暂停状态 (`isAutoPlay`)。
2.  **Select**: 筛选符合条件的 AI（未禁言、未 Yield、非上一轮发言者）。
3.  **Trigger**: 随机选择一个 AI，调用 `triggerAgentReply`。

### 4.2 触发回复 (`triggerAgentReply`)
这是系统的核心调度函数：
1.  **Lock**: 将 AI ID 加入 `processingAgents`。
2.  **Signal**: 创建 `AbortController` 用于超时熔断或手动停止。
3.  **Service Call**: 根据 `provider.type` 路由到对应的 Service (`streamGeminiReply` 等)。
4.  **Stream & Parse**: 
    *   接收流式数据。
    *   **指令解析**：正则扫描 `{{PASS}}`, `{{REPLY:id}}`, `{{MUTE:name}}`, `{{NOTE:content}}`。
5.  **Commit**: 生成完毕，执行管理指令（如禁言），计算 Token 花费，更新状态，释放 Lock。

### 4.3 文本指令协议 (Text Command Protocol)
为了让 AI 能够操作 UI 功能（如禁言、记笔记、搜索），我们定义了一套基于文本的协议，而不是使用复杂的 Function Calling。这保证了跨模型的最大兼容性。

**所有指令列表：**
| 指令 | 权限 | 说明 |
|------|------|------|
| `{{PASS}}` | 所有 | 跳过本轮发言 |
| `{{REPLY: id}}` | 所有 | 引用某条消息 |
| `{{SEARCH: query}}` | 需配置 | AI 主动联网搜索 |
| `{{MUTE: Name, Duration}}` | Admin | 禁言成员 (10min/1h/1d/永久) |
| `{{UNMUTE: Name}}` | Admin | 解除禁言 |
| `{{NOTE: content}}` | Admin | 添加记忆便签 |
| `{{DELNOTE: keyword}}` | Admin | 删除含关键词的便签 |
| `{{CLEARNOTES}}` | Admin | 清空所有便签 |

**执行流程：**
*   **Prompt 注入**: 在 `*Service.ts` 中，我们告知角色可用的指令。
*   **指令拦截**: 在 `App.tsx` 的流式读取循环中，正则匹配到指令后：
    *   UI 层**隐藏**该指令（用户不可见）。
    *   代码层**执行**对应逻辑。

### 4.4 联网搜索流程 (Search Flow) - V5.1 新增
1.  **触发方式**：
    *   用户输入 `/search 关键词`
    *   AI 输出 `{{SEARCH: 关键词}}`（需在角色设置中配置搜索服务）
2.  **执行**: 调用 `searchService.performSearch`，支持 Serper/Tavily/Brave/Metaso。
3.  **结果注入**: 搜索结果作为系统消息插入聊天，并再次触发 AI 回复。
4.  **防循环**: 第二次触发时 `disableSearch=true`，AI 不会再看到搜索工具提示。

### 4.5 记忆与总结系统 (Memory System)
1.  **触发器**: `App.tsx` 监听 `messages.length`。当 `count % threshold === 0` 时触发。
2.  **执行**: 调用 `summaryService.updateSessionSummary`。
3.  **合成**: `Prompt = Old Summary + Admin Notes + Recent Messages`。
4.  **更新**: 生成新的 Summary，存入 DB，清空 Admin Notes。
5.  **闭环**: 新的 Summary 会在下一次 API 调用时作为 System Prompt 注入，实现记忆闭环。

### 4.6 群组层级结构 (Group Hierarchy) - V5.1 新增
```
群组 (Group)           → 共享：成员、场景、记忆配置
├── 对话 1 (Session)   → 独立：消息、摘要、便签、禁言
├── 对话 2 (Session)
└── 对话 3 (Session)
```
*   **UI**: 左侧边栏显示两级折叠列表。
*   **成员管理**: 右侧边栏操作的是群组的 `memberIds`，对该群组下所有对话生效。
*   **数据迁移**: Dexie v2 自动为旧 Session 创建同名 Group。

### 4.7 图片压缩 (Image Compression) - V5.1 新增
Anthropic API 限制图片 5MB，因此在上传时自动压缩：
1.  **检测**: `fileParser.ts` 计算 Base64 大小。
2.  **压缩**: 使用 Canvas 降低质量 (0.9→0.3) 和尺寸 (1.0→0.25)，输出 JPEG。
3.  **配置**: 用户可在设置中关闭或调整阈值 (默认 4MB)。

---

## 5. 扩展指南：构建记忆与后端 (Future Roadmap)

如果您计划引入**向量数据库 (Vector DB)** 或 **后端数据库**，请参考以下重构路径：

### 阶段一：抽离状态逻辑 (Refactor)
目前 `App.tsx` 承担了过多的 Controller 职责。
*   **目标**：将聊天逻辑抽离为 Custom Hook，例如 `useChatEngine`。
*   **好处**：`App.tsx` 只负责布局，逻辑层更清晰，方便接入不同的数据源。

### 阶段二：引入向量数据库 (RAG Integration)
目前的上下文是基于**滑动窗口 (Sliding Window)**。要让 AI 记住 1000 条之前的细节：
1.  **修改点**：`services/*Service.ts`。
2.  **动作**：
    *   在构建 `formattedMessages` 之前，截取用户的 Query。
    *   将 Query 发送到向量数据库 (如 Pinecone, 或浏览器本地的 Transformers.js + Voy)。
    *   检索相关历史记录 (Relevant Memories)。
    *   将检索到的记录插入到 System Prompt 的 `[Relevant History]` 区块中。

### 阶段三：从 IndexedDB 迁移到 PostgreSQL/Supabase
如果要把这是一个单机应用变成多人在线应用：
1.  **替换 `services/db.ts`**：
    *   保持方法名不变 (`loadAllData`, `saveCollection`)。
    *   将内部实现从 `dexie` 替换为 `fetch('/api/...')` 或 `supabase-js` 客户端。

---

## 6. 调试与构建

*   **本地运行**: `npm run dev`
*   **构建生产包**: `npm run build`
