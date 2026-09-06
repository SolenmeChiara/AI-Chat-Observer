
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

> **免责声明 / Disclaimer**
> - 本项目仅供学习交流，AI 生成内容不代表开发者观点
> - 用户需自行承担使用风险，请勿用于违法用途
> - This project is for learning purposes only. AI-generated content does not represent the developer's views
> - Users bear their own risks. Do not use for illegal purposes

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
- **Local File Storage**: Data is also persisted to human-readable JSON files under `data/` — survives IndexedDB clears, browser switches, and port changes. One-click JSON backup export/import. See [Storage](#storage) below.
- **Phone Viewer Mode**: Watch the desktop session live from your phone's browser (streaming text, thinking chains, images) and send text messages back, over Tailscale or your LAN, protected by a shared access token. See [Phone Viewer](#phone-viewer) below.
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
- **Entertainment Tools (TRPG/Roleplay)**:
  - **Dice Rolling**: AI outputs `{{ROLL: 2d6+3}}` for dice rolls with breakdown.
  - **Tarot Cards**: AI outputs `{{TAROT: 3}}` to draw cards with upright/reversed positions.
  - Per-group toggles in settings.
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

<a name="storage"></a>

### Storage

Your data lives in the `data/` directory next to the project (override with the `ACO_DATA_DIR` environment variable), as plain JSON files — one file per chat session, plus `agents.json`, `providers.json`, `groups.json`, and `settings.json`. `providers.json` contains your API keys in plaintext, so `data/` is already listed in `.gitignore` — never commit it or share it as-is.

On first launch, any existing IndexedDB data is automatically migrated into `data/` (IndexedDB itself is left untouched as a fallback). Use the **Export JSON Backup** button in the sidebar any time to save a full snapshot you can restore later or store outside git.

## Configuration

1. **Add Providers**: Go to the **Providers** tab in the sidebar. Enter your API Keys (Gemini/OpenAI/Anthropic).
2. **Create Agents**: Define personas (e.g., "A grumpy chef").
3. **Start Chat**: Create a session, set a scenario, and watch the magic happen.

<a name="phone-viewer"></a>

## Phone Viewer

Watch the desktop session live from your phone's browser — streaming text, thinking chains, and images — and send text messages back into the active session.

**Start it one of three ways:**

1. **Recommended — Tailscale + HTTPS**: run `npm run dev:tsserve` (binds only to `127.0.0.1`), then on the desktop run `tailscale serve https / http://127.0.0.1:5173`. Open `https://<machine>.<tailnet>.ts.net/viewer?token=...` on your phone.
2. **Tailscale IP**: run `npm run dev:lan` and open `http://100.x.y.z:5173/viewer?token=...` using the desktop's Tailscale IP.
3. **Plain LAN IP**: also via `npm run dev:lan`, using the desktop's regular LAN IP — only do this on a network you trust (never on public/guest Wi-Fi).

Click **📱 Phone Viewer** in the sidebar for a QR code and the ready-to-use URL for whichever mode is currently active. The access token lives in `data/lan-token.txt` — delete it and restart the server to rotate it.

From the phone you can also start and pause the desktop's auto-play with the button in the status bar (it only works while the desktop is online and on the same session), and pick your own light/dark theme independently of the desktop.

**Security notes**: the server only listens on localhost by default; LAN/Tailscale access must be opted into explicitly (`npm run dev:lan` / `dev:tsserve`). A phone (LAN role) can only view sessions and send messages — it never gets `/api/db/*` or any API key, ever. Every request is checked against the Host header, the Origin header, and the access token (constant-time comparison) before it's served. In the QR modal, ignore addresses like `172.x.x.x` — those are virtual adapters (e.g. Hyper-V) your phone can't actually reach. Your phone also needs outbound access to `cdn.tailwindcss.com` (the app loads Tailwind from that CDN).

## API Compatibility (CORS)

This is a **pure frontend application**. Some API providers have CORS restrictions that prevent direct browser access.

| Provider | Direct Browser Access | Recommended Solution |
|----------|----------------------|---------------------|
| Gemini | ✅ Supported | Native SDK |
| Claude | ✅ Supported | Native API with special header |
| OpenRouter | ✅ Supported | OpenAI-compatible endpoint |
| SiliconFlow | ✅ Supported | OpenAI-compatible endpoint |
| OpenAI Official | ✅ Supported | OpenAI-compatible endpoint |
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
- **本地文件存储**: 数据同时落盘到 `data/` 目录下的 JSON 文件，换浏览器、清站点数据、端口漂移都不再丢数据；支持一键导出/导入 JSON 备份。详见下方[数据存放](#数据存放)。
- **手机观众模式**: 通过 Tailscale 或局域网，在手机浏览器上实时观看电脑端会话并发消息，访问受共享 token 保护。详见下方[手机观看](#手机观看)。
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
- **娱乐工具 (TRPG/剧本杀)**:
  - **骰子**: AI 输出 `{{ROLL: 2d6+3}}` 进行投骰，显示明细。
  - **塔罗牌**: AI 输出 `{{TAROT: 3}}` 抽牌，支持正逆位。
  - 可在群组设置中单独开关。
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

### 数据存放

数据保存在项目旁的 `data/` 目录（可用环境变量 `ACO_DATA_DIR` 改到别处），是人类可读的 JSON 文件——每个会话一个文件，另有 `agents.json`、`providers.json`、`groups.json`、`settings.json`。`providers.json` 里是明文 API key，`data/` 已加入 `.gitignore`，千万不要提交或原样分享给别人。

首次启动会自动把已有的 IndexedDB 数据搬到 `data/`（IndexedDB 本身原样保留作为回退）。侧栏的「导出 JSON 备份」按钮可以随时导出一份完整快照，方便恢复或存到 git 之外的地方。

## 手机观看

在手机浏览器上实时观看电脑端正在跑的会话——包括流式打字机效果、思考链、图片——还能发文字消息进当前会话。

**三种启动方式：**

1. **推荐：Tailscale + HTTPS**：电脑执行 `npm run dev:tsserve`（只监听 `127.0.0.1`），再执行 `tailscale serve https / http://127.0.0.1:5173`；手机打开 `https://<机器名>.<tailnet>.ts.net/viewer?token=…`。
2. **Tailscale IP 直连**：电脑执行 `npm run dev:lan`，手机打开 `http://100.x.y.z:5173/viewer?token=…`（Tailscale 分配的 IP）。
3. **普通局域网 IP**：同样用 `npm run dev:lan`，手机打开电脑的局域网 IP——只在可信网络下使用，不要在公共/访客 WiFi 上开。

点侧栏的「📱 手机观看」按钮，会显示当前可用方式的二维码和完整 URL，扫码即可。访问 token 存在 `data/lan-token.txt`，删掉这个文件重启服务即可换一把新钥匙。

手机上还能用状态条里的按钮直接开关电脑端的自动播放（需要电脑在线且停在同一个会话），深浅色也可以自己选，不跟着电脑走。

**安全要点**：服务默认只监听本机；局域网/Tailscale 访问需要显式开启（`npm run dev:lan` / `dev:tsserve`）。手机（局域网角色）只能看会话、发消息，永远碰不到 `/api/db/*` 或任何 API key。每个请求都会校验 Host、Origin 与 token（常数时间比较）三重身份。弹窗里如果出现 `172.x.x.x` 之类的地址，那是虚拟网卡（比如 Hyper-V），手机扫不通，忽略即可。手机所在网络还需要能访问 `cdn.tailwindcss.com`（页面样式走这个 CDN 加载）。

## API 兼容性 (CORS 跨域)

本项目是**纯前端应用**，部分 API 服务商有 CORS 跨域限制，无法直接从浏览器访问。

| 服务商 | 浏览器直连 | 推荐方案 |
|--------|-----------|---------|
| Gemini | ✅ 支持 | 原生 SDK |
| Claude | ✅ 支持 | 原生 API（特殊 Header） |
| OpenRouter | ✅ 支持 | OpenAI 兼容接口 |
| 硅基流动 (SiliconFlow) | ✅ 支持 | OpenAI 兼容接口 |
| OpenAI 官方 | ✅ 支持 | OpenAI 兼容接口 |
| DeepSeek 官方 | ❌ 被 CORS 阻止 | 用 OpenRouter 或硅基流动 |

**推荐方案**：使用 **[OpenRouter](https://openrouter.ai)** 或 **[硅基流动](https://siliconflow.cn)** 作为 API 中转服务，它们支持 CORS 且可以通过统一接口访问所有主流模型。

## 贡献 (Contributing)

欢迎提交 Issue 或 Pull Request！
无论是增加新的文件解析器、优化 Prompt 策略，还是改进 UI，都非常欢迎。

## License
[GPL-3.0](LICENSE) - 任何修改或衍生作品必须同样开源。