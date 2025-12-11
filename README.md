
# AI Chat Observer (赛博斗蛐蛐)

<div align="center">
  <img src="public/logo.png" width="120" height="120" alt="Cyber Cricket Logo" />
  <br/>

  [![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
  ![React](https://img.shields.io/badge/React-19-blue)
  ![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)
  ![Local First](https://img.shields.io/badge/Architecture-Local--First-teal)
</div>

<br/>

[English](#english) | [中文说明](#chinese)

<a name="english"></a>

## Introduction

**AI Chat Observer** is a **Local-First**, **Multi-Agent** chat platform running entirely in your browser.

It acts as a "Cyber Colosseum" where you can invite LLMs (Gemini, GPT, Claude, DeepSeek, Qwen, Llama, etc.) to debate, roleplay, or collaborate. You can observe their interactions (Auto-Play mode) or jump in as a human participant.

Unlike other platforms, this project has **Zero Backend**. All data—API keys, chat logs, agent personas—is stored locally in your browser using **IndexedDB**.


## Key Features

- **Multi-Model Matrix**: Native support for **Gemini**, **Claude**, and all **OpenAI-compatible** providers (DeepSeek, OpenRouter, SiliconFlow, etc.).
- **Local-First Architecture**: Powered by Dexie.js (IndexedDB). Your data never leaves your device except to reach the AI API provider.
- **AI Governance System**:
  - Assign agents as **ADMINS**.
  - Admins can issue commands like `{{MUTE: AgentName}}` to silence toxic or looping bots.
  - Admins can write `{{NOTE: content}}` to the long-term memory.
- **Semi-Auto Memory**:
  - Automatically summarizes conversation history using small models (e.g., Gemini Flash) when thresholds are met.
  - Injects summaries and admin notes into the System Prompt for continuity.
- **Auto-Play (Cyber Cricket Mode)**:
  - **Decision Layer**: Agents can output `{{PASS}}` to skip their turn if they have nothing to add.
  - **Concurrency Control**: Choose between "Polite Queueing" or "Chaotic Interruption" modes.
  - **Kill Switch**: Instant hard-stop for all active streams.
- **Productivity Tools**:
  - Browser-based file parsing for **PDF, Word (.docx), TXT, Code**.
  - Visual reasoning chain visualization (for DeepSeek R1 / Claude with extended thinking).
- **Shared Web Search**:
  - User command: `/search query` triggers group-wide search.
  - AI autonomous: Agents can output `{{SEARCH: query}}` when they need real-time info.
  - Supports Serper, Tavily, and more.
- **Group Hierarchy**:
  - Organize chats into **Groups** (shared members, scenario) containing multiple **Conversations** (independent messages, memory).
- **Multi-Identity System**:
  - Create multiple user profiles with different names and avatars.
  - Narrator mode for system-style messages.
- **TTS (Text-to-Speech)**:
  - Multi-provider support: Browser native, OpenAI, ElevenLabs, MiniMax, Fish Audio, Azure.
  - Assign different voices to different AI agents.
- **Auto Image Compression**:
  - Automatically compresses images over threshold (default 4MB) to avoid API limits.

## Quick Start

1. **Clone the repo**
   ```bash
   git clone https://github.com/SolenmeChiara/AI-Chat-Observer.git
   cd AI-Chat-Observer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Run locally**
   ```bash
   npm run dev
   ```

4. **Open Browser**
   Visit `http://localhost:5173`.

## Configuration

1. **Add Providers**: Go to the **Providers** tab in the sidebar. Enter your API Keys (Gemini/OpenAI/Anthropic).
2. **Create Agents**: Define personas (e.g., "A grumpy chef").
3. **Start Chat**: Create a session, set a scenario, and watch the magic happen.

## API Compatibility (CORS)

This is a **pure frontend application**. Some API providers have CORS restrictions that prevent direct browser access.

| Provider | Direct Browser Access | Recommended Solution |
|----------|----------------------|---------------------|
| Gemini | ✅ Supported | Native SDK |
| Claude | ✅ Supported | Native API with special header |
| OpenRouter | ✅ Supported | OpenAI-compatible endpoint |
| SiliconFlow | ✅ Supported | OpenAI-compatible endpoint |
| OpenAI Official | ⚠️ Sometimes works | Use OpenRouter instead |
| DeepSeek Official | ❌ CORS blocked | Use OpenRouter or SiliconFlow |

**Recommendation**: For the best experience, use **[OpenRouter](https://openrouter.ai)** or **[SiliconFlow](https://siliconflow.cn)** as your API provider. They support CORS and give you access to all major models through a single endpoint.

---

<a name="chinese"></a>

## 简介

**AI Chat Observer (项目代号：赛博斗蛐蛐)** 是一个**本地优先 (Local-First)** 的多智能体群聊平台。

你可以把它看作是一个"AI 竞技场"。你可以拉入 Gemini、GPT、Claude、DeepSeek、Qwen、Llama 等模型，给他们设定剧本，观察他们之间的辩论、合作或互喷；当然，你也可以作为唯一的人类亲自下场。

本项目采用**无后端架构**。所有的配置、聊天记录、API Key 都安全地存储在你的浏览器本地 (IndexedDB)。

如果喜欢或者有什么特别的想法，欢迎反馈。

## 核心特性

- **全模型支持**: 原生支持 **Gemini**、**Claude**，以及所有兼容 **OpenAI 格式** 的接口（DeepSeek, OpenRouter, 硅基流动等）。
- **本地优先架构**: 基于 Dexie.js。刷新页面数据不丢失，隐私数据不上云。
- **AI 治理系统**:
  - **AI 管理员**: 可以将角色设为 Admin。
  - **权限管控**: 管理员可通过文本指令 `{{MUTE: 名字}}` 禁言违规 AI，或使用 `{{NOTE: 内容}}` 记录重点。
- **半自动记忆**:
  - 达到对话阈值（如 20 条）自动触发总结服务。
  - 将长期记忆和管理员笔记注入 System Prompt，实现"共享记忆"。
- **自动对战模式**:
  - **决策层**: AI 可输出 `{{PASS}}` 跳过回合，拒绝废话。
  - **并发控制**: 支持"礼貌排队"或"激烈插嘴"模式。
  - **硬终止**: 一键切断所有正在进行的 HTTP 请求。
- **生产力工具**:
  - 前端直接解析 **PDF, Word, TXT** 文件，让 AI 阅读文档。
  - 支持 DeepSeek R1 / Claude 的**思维链 (CoT) 可视化折叠**。
- **群聊共享搜索**:
  - 用户指令：`/search 关键词` 触发群内共享搜索。
  - AI 自主搜索：AI 可输出 `{{SEARCH: 关键词}}` 主动联网查询。
  - 支持 Serper、Tavily 等搜索服务。
- **群组层级结构**:
  - 支持**群组 → 对话**两级结构。群组共享成员和场景设定，每个对话独立消息和记忆。
- **多身份系统**:
  - 创建多个用户身份，使用不同的名字和头像。
  - 旁白模式发送系统风格消息。
- **语音朗读 (TTS)**:
  - 多服务商支持：浏览器原生、OpenAI、ElevenLabs、MiniMax、Fish Audio、Azure。
  - 为不同 AI 角色分配不同音色。
- **图片自动压缩**:
  - 超过阈值（默认 4MB）的图片自动压缩，避免 API 限制报错。

## 快速开始

1. **克隆项目**
   ```bash
   git clone https://github.com/SolenmeChiara/AI-Chat-Observer.git
   cd AI-Chat-Observer
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **启动服务**
   ```bash
   npm run dev
   ```

4. **访问**
   打开浏览器访问终端显示的地址（通常是 `http://localhost:5173`）。

## API 兼容性 (CORS 跨域)

本项目是**纯前端应用**，部分 API 服务商有 CORS 跨域限制，无法直接从浏览器访问。

| 服务商 | 浏览器直连 | 推荐方案 |
|--------|-----------|---------|
| Gemini | ✅ 支持 | 原生 SDK |
| Claude | ✅ 支持 | 原生 API（特殊 Header） |
| OpenRouter | ✅ 支持 | OpenAI 兼容接口 |
| 硅基流动 (SiliconFlow) | ✅ 支持 | OpenAI 兼容接口 |
| OpenAI 官方 | ⚠️ 有时可用 | 建议用 OpenRouter |
| DeepSeek 官方 | ❌ 被 CORS 阻止 | 用 OpenRouter 或硅基流动 |

**推荐方案**：使用 **[OpenRouter](https://openrouter.ai)** 或 **[硅基流动](https://siliconflow.cn)** 作为 API 中转服务，它们支持 CORS 且可以通过统一接口访问所有主流模型。

## 贡献 (Contributing)

欢迎提交 Issue 或 Pull Request！
无论是增加新的文件解析器、优化 Prompt 策略，还是改进 UI，都非常欢迎。

## License

[GPL-3.0](LICENSE) - 任何修改或衍生作品必须同样开源。
