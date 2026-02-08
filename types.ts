
export enum AgentType {
  GEMINI = 'GEMINI',
  OPENAI_COMPATIBLE = 'OPENAI_COMPATIBLE',
  ANTHROPIC = 'ANTHROPIC'
}

export enum AgentRole {
  MEMBER = 'MEMBER',
  ADMIN = 'ADMIN'
}

// Gemini Mode: AI Studio (simple API key) or Vertex AI (project-based)
export type GeminiMode = 'aistudio' | 'vertex';

// 1. Define the API Provider (The "Supplier")
export interface ApiProvider {
  id: string;
  name: string; // e.g., "DeepSeek", "OpenRouter", "Official OpenAI"
  type: AgentType;
  baseUrl?: string;
  apiKey?: string; // API Key for most providers, or Gemini AI Studio
  models: ModelConfig[]; // Presets defined under this provider

  // Gemini-specific fields
  geminiMode?: GeminiMode; // 'aistudio' or 'vertex'
  vertexProject?: string;  // Google Cloud Project ID (for Vertex AI)
  vertexLocation?: string; // e.g., 'us-central1' (for Vertex AI)
}

// 2. Define a Model Config (Pricing & ID)
export interface ModelConfig {
  id: string; // e.g., 'gpt-4o', 'deepseek-chat'
  name: string; // Display name
  inputPricePer1M: number;
  outputPricePer1M: number;
}

export interface AgentConfig {
  temperature: number;      // 0.0 - 2.0
  maxTokens: number;        // e.g. 100 - 8192
  enableReasoning: boolean; // For DeepSeek R1 or Claude 3.7 Thinking
  reasoningBudget: number;  // Token budget for thinking (1024 - 32000)

  // Vision Proxy: Let text-only models "see" images via a vision model
  visionProxyEnabled?: boolean;
  visionProxyProviderId?: string;
  visionProxyModelId?: string;
}

// 搜索引擎类型
export type SearchEngine = 'serper' | 'brave' | 'tavily' | 'metaso';

// 角色搜索配置
export interface SearchConfig {
  enabled: boolean;
  engine: SearchEngine;
  apiKey: string;
}

// 3. The Agent (The "Persona")
export interface Agent {
  id: string;
  name: string;
  avatar: string;
  providerId: string; // Links to ApiProvider
  modelId: string;    // Links to specific model string ID
  systemPrompt: string;
  color: string;
  config: AgentConfig; // Independent parameters
  role: AgentRole;    // MEMBER or ADMIN
  isActive?: boolean; // If false, agent won't participate in chat until manually activated
  searchConfig?: SearchConfig; // 搜索工具配置
  enableGoogleSearch?: boolean; // Gemini 原生 Google 搜索 (仅 Gemini 模型可用)
  voiceId?: string;      // TTS voice ID for this agent
  voiceProviderId?: string; // TTS provider ID for this agent
}

export interface Attachment {
  type: 'image' | 'document';
  content: string; // Base64 string for images, or just filename/placeholder for docs
  textContent?: string; // The parsed text from the document
  visionDescription?: string; // Cached description from vision proxy model
  mimeType: string; // e.g. image/png, application/pdf
  fileName?: string;
}

export interface Message {
  id: string;
  senderId: string;
  text: string;
  reasoningText?: string; // The "Thought Chain" content
  reasoningSignature?: string; // Anthropic thinking signature (required for multi-turn)
  reasoningDuration?: number; // Time spent on reasoning in milliseconds
  timestamp: number;
  cost?: number; // Cost of this specific message
  tokens?: { input: number; output: number };
  isError?: boolean;

  // New Features
  isSystem?: boolean; // System notification (e.g. "User muted Agent A")
  attachments?: Attachment[]; // Multiple images/documents
  replyToId?: string; // ID of the message being replied to

  // 搜索结果
  isSearchResult?: boolean; // 是否为搜索结果消息
  searchQuery?: string; // 搜索查询词

  // 流式生成中 (占位符，对其他AI不可见)
  isStreaming?: boolean;
}

export interface MemoryConfig {
  enabled: boolean;
  threshold: number; // e.g. 20 messages
  summaryModelId: string; // e.g. 'gemini-flash'
  summaryProviderId: string;
}

export interface MuteInfo {
  agentId: string;
  muteUntil: number; // Timestamp when mute expires (0 = permanent)
  mutedBy: string;   // Name of who muted this agent
}

// 娱乐功能配置（骰子、塔罗等）
export interface EntertainmentConfig {
  enableDice: boolean;    // 启用骰子 {{ROLL: XdY+Z}}
  enableTarot: boolean;   // 启用塔罗牌 {{TAROT: N}}
}

// 群组：包含多个对话，共享成员和场景
export interface ChatGroup {
  id: string;
  name: string;
  memberIds: string[];        // 共享的成员列表
  adminIds?: string[];        // 该群的管理员列表
  scenario?: string;          // 共享的场景设定
  memoryConfig: MemoryConfig; // 共享的记忆配置
  entertainmentConfig?: EntertainmentConfig; // 娱乐功能配置
  createdAt: number;
}

export interface ChatSession {
  id: string;
  groupId: string;            // 属于哪个群组
  name: string;
  messages: Message[];
  lastUpdated: number;
  isAutoRenamed?: boolean; // Prevents overwriting if already named by AI
  mutedAgentIds: string[]; // Legacy: simple list (kept for compatibility)
  mutedAgents: MuteInfo[]; // New: detailed mute info with expiry
  yieldedAgentIds: string[]; // List of agents who PASSED recently (Immunity list)
  yieldedAtCount?: number; // Message count when first agent yielded (for 5-message cooldown)

  // Memory System (独立于群组)
  summary?: string; // Long term memory text
  adminNotes?: string[]; // Temporary notes from Admins
}

// User Profile for multi-identity support
export interface UserProfile {
  id: string;
  name: string;
  avatar: string;
  persona: string;      // User's backstory/bio
  isDefault?: boolean;  // Mark default profile
}

export interface GlobalSettings {
  breathingTime: number; // ms to wait after a message before next agent starts
  visibilityMode: 'OPEN' | 'BLIND'; // OPEN: Agents see all; BLIND: Agents see only User + Self
  contextLimit: number; // Max messages to send to history

  // User Profiles (multi-identity)
  userProfiles: UserProfile[];
  activeProfileId: string | 'narrator'; // 'narrator' = narrator mode (system messages)

  // Legacy fields (kept for migration, will use first profile)
  userName: string;
  userAvatar: string;
  userPersona: string;

  // Stability & Concurrency
  enableConcurrency: boolean; // If true, multiple agents can speak at once. If false, they queue/block.
  timeoutDuration: number; // Milliseconds before killing a stuck request (e.g. 30000)

  // Image Compression (Anthropic has 5MB limit)
  compressImages: boolean;
  maxImageSizeMB: number; // Default 5MB

  // Appearance
  darkMode: boolean;
  expandAllReasoning: boolean; // If true, all reasoning chains are expanded by default

  // TTS (Text-to-Speech)
  ttsSettings: TTSSettings;
}

export interface StreamChunk {
  text?: string;
  reasoning?: string; // Chunk of reasoning text
  reasoningSignature?: string; // Anthropic thinking signature
  usage?: { input: number; output: number };
  isComplete: boolean;
}

// TTS Configuration
export type TTSEngineType = 'browser' | 'openai' | 'elevenlabs' | 'minimax' | 'fishaudio' | 'azure' | 'google' | 'cartesia' | 'playht' | 'custom';

export interface TTSVoice {
  id: string;        // Voice identifier (e.g., 'en-US-Standard-A' or 'alloy')
  name: string;      // Display name
  lang?: string;     // Language code
  gender?: 'male' | 'female' | 'neutral';
  isCustom?: boolean; // User-added custom voice
}

// TTS Provider (like ApiProvider for LLMs)
export interface TTSProvider {
  id: string;
  name: string;      // Display name (e.g., "ElevenLabs", "MiniMax")
  type: TTSEngineType;
  apiKey?: string;
  baseUrl?: string;  // Custom endpoint URL
  voices: TTSVoice[]; // Available voices for this provider
  // Pricing info
  pricePer1MChars?: number; // Cost per 1M characters (USD)
  freeQuota?: string; // e.g., "10k chars/month"
  isCustom?: boolean; // User-defined custom provider
  description?: string; // Provider description/notes
}

export interface TTSSettings {
  enabled: boolean;
  activeProviderId?: string;  // Currently selected provider
  rate: number;               // Speech rate (0.5 - 2.0)
  volume: number;             // Volume (0 - 1)
  autoPlayNewMessages: boolean;
}

// Legacy compatibility alias
export type TTSEngine = TTSEngineType;
