
import { Agent, ApiProvider, GlobalSettings, AgentType, ChatSession, ChatGroup, AgentRole, MemoryConfig } from './types';

export const USER_ID = 'user';

// Minimalist Grey "No User" Avatar (SVG Base64)
const DEFAULT_USER_AVATAR = "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23F3F4F6'%3E%3Crect width='24' height='24' rx='12' fill='%23E5E7EB'/%3E%3Cpath fill='%239CA3AF' d='M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z'/%3E%3C/svg%3E";

export const DEFAULT_SETTINGS: GlobalSettings = {
  breathingTime: 2000,
  visibilityMode: 'OPEN',
  contextLimit: 20,
  userName: 'User',
  userAvatar: DEFAULT_USER_AVATAR,
  userPersona: '一位充满好奇心的人类观察者。', // Default Persona
  enableConcurrency: false, // Default to sequential (polite)
  timeoutDuration: 30000,   // Default 30s timeout
  compressImages: true,     // Default ON (Anthropic has 5MB limit)
  maxImageSizeMB: 4,        // Default 4MB (safe margin below 5MB)
  darkMode: false,          // Default to light mode
  expandAllReasoning: false, // Default to collapsed reasoning chains
  ttsSettings: {
    enabled: false,
    engine: 'browser',
    rate: 1.0,
    volume: 1.0,
    autoPlayNewMessages: false
  }
};

// Brand Logos (GitHub avatars for official full-color logos + local fallback)
export const AVATAR_MAP: Record<string, string> = {
  gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_v002_d4735304ff6292a690345.svg',
  openai: 'https://avatars.githubusercontent.com/u/14957082?s=200&v=4',
  claude: '/logos/claude-logo-6FGW382926.webp',
  deepseek: 'https://avatars.githubusercontent.com/u/148330874?s=200&v=4',
  meta: '/logos/ollama-logo_svgstack_com_71401764879779.png',
  grok: '/logos/GROK.png',
  perplexity: 'https://avatars.githubusercontent.com/u/79275775?s=200&v=4',
  qwen: '/logos/qwen-color.png',
  mistral: '/logos/mistral-ai-logo-1N5p386073.webp',
  yi: 'https://avatars.githubusercontent.com/u/147706647?s=200&v=4',
  microsoft: '/logos/copilot-app-logo-Tm0T382925.webp',
  cohere: 'https://avatars.githubusercontent.com/u/54850923?s=200&v=4',
  kimi: '/logos/kimi-logo-png_seeklogo-611650.png',
  glm: '/logos/GLM-Zai.svg',
  nvidia: '/logos/nvidia-logo-pv5D386076.webp',
  poe: '/logos/black-poe-logo-0RwU386078.webp',
  notion: '/logos/notion-logo-c5Kq386075.webp',
  default: '/logos/default.svg'
};

export const getAvatarForModel = (modelId: string, providerName: string): string => {
  const lowerId = modelId.toLowerCase();
  const lowerName = providerName.toLowerCase();
  
  if (lowerId.includes('gemini') || lowerId.includes('gemma') || lowerName.includes('google')) return AVATAR_MAP.gemini;
  if (lowerId.includes('gpt') || lowerId.includes('o1') || lowerId.includes('o3') || lowerName.includes('openai')) return AVATAR_MAP.openai;
  if (lowerId.includes('claude') || lowerName.includes('anthropic')) return AVATAR_MAP.claude;
  if (lowerId.includes('deepseek') || lowerName.includes('deepseek')) return AVATAR_MAP.deepseek;
  if (lowerId.includes('llama') || lowerName.includes('meta') || lowerName.includes('facebook')) return AVATAR_MAP.meta;
  if (lowerId.includes('qwen') || lowerId.includes('qwq') || lowerId.includes('tongyi') || lowerName.includes('alibaba') || lowerName.includes('qwen') || lowerId.includes('dashscope')) return AVATAR_MAP.qwen;
  if (lowerId.includes('mistral') || lowerId.includes('mixtral') || lowerId.includes('codestral') || lowerName.includes('mistral')) return AVATAR_MAP.mistral;
  if (lowerId.includes('yi-') || lowerId.includes('01-ai') || lowerName.includes('01.ai') || lowerName.includes('零一万物')) return AVATAR_MAP.yi;
  if (lowerId.includes('phi') || lowerId.includes('wizard') || lowerName.includes('microsoft')) return AVATAR_MAP.microsoft;
  if (lowerId.includes('grok') || lowerName.includes('x.ai')) return AVATAR_MAP.grok;
  if (lowerId.includes('sonar') || lowerId.includes('pplx') || lowerName.includes('perplexity')) return AVATAR_MAP.perplexity;
  if (lowerId.includes('command') || lowerId.includes('cohere') || lowerName.includes('cohere')) return AVATAR_MAP.cohere;
  if (lowerId.includes('kimi') || lowerId.includes('moonshot') || lowerName.includes('moonshot') || lowerName.includes('月之暗面')) return AVATAR_MAP.kimi;
  if (lowerId.includes('glm') || lowerId.includes('chatglm') || lowerName.includes('zhipu') || lowerName.includes('智谱') || lowerName.includes('bigmodel')) return AVATAR_MAP.glm;
  if (lowerId.includes('nemotron') || lowerId.includes('nvidia') || lowerName.includes('nvidia')) return AVATAR_MAP.nvidia;
  if (lowerName.includes('poe')) return AVATAR_MAP.poe;
  if (lowerName.includes('notion')) return AVATAR_MAP.notion;

  return AVATAR_MAP.default;
};

export const INITIAL_PROVIDERS: ApiProvider[] = [
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    type: AgentType.GEMINI,
    geminiMode: 'aistudio',
    apiKey: '',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', inputPricePer1M: 0.075, outputPricePer1M: 0.30 },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', inputPricePer1M: 1.25, outputPricePer1M: 5.00 }
    ]
  },
  {
    id: 'openai-official',
    name: 'OpenAI Official',
    type: AgentType.OPENAI_COMPATIBLE,
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', inputPricePer1M: 5.00, outputPricePer1M: 15.00 },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', inputPricePer1M: 0.15, outputPricePer1M: 0.60 }
    ]
  },
  {
    id: 'anthropic-official',
    name: 'Anthropic Official',
    type: AgentType.ANTHROPIC,
    baseUrl: 'https://api.anthropic.com/v1', 
    apiKey: '',
    models: [
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', inputPricePer1M: 3.00, outputPricePer1M: 15.00 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', inputPricePer1M: 3.00, outputPricePer1M: 15.00 }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: AgentType.OPENAI_COMPATIBLE,
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    models: [
      { id: 'anthropic/claude-3.5-sonnet', name: 'OR-Claude 3.5', inputPricePer1M: 3, outputPricePer1M: 15 },
      { id: 'deepseek/deepseek-r1', name: 'OR-DeepSeek R1', inputPricePer1M: 0.55, outputPricePer1M: 2.19 }
    ]
  },
  {
    id: 'deepseek-official',
    name: 'DeepSeek Official',
    type: AgentType.OPENAI_COMPATIBLE,
    baseUrl: 'https://api.deepseek.com',
    apiKey: '', 
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', inputPricePer1M: 0.14, outputPricePer1M: 0.28 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', inputPricePer1M: 0.55, outputPricePer1M: 2.19 }
    ]
  },
  {
    id: 'silicon-flow',
    name: 'SiliconFlow',
    type: AgentType.OPENAI_COMPATIBLE,
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    models: [
      { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen 2.5 7B', inputPricePer1M: 0, outputPricePer1M: 0 },
      { id: 'meta-llama/Meta-Llama-3.1-8B-Instruct', name: 'Llama 3.1 8B', inputPricePer1M: 0, outputPricePer1M: 0 }
    ]
  }
];

export const INITIAL_AGENTS: Agent[] = [
  {
    id: 'agent-1',
    name: 'Gemini',
    avatar: AVATAR_MAP.gemini,
    providerId: 'google-gemini',
    modelId: 'gemini-2.5-flash',
    systemPrompt: '你代表 Google Gemini。你的回答通常信息量大、有条理且富有创造力。',
    color: 'bg-blue-600',
    config: {
      temperature: 0.7,
      maxTokens: 1000,
      enableReasoning: false,
      reasoningBudget: 0
    },
    role: AgentRole.MEMBER
  },
  {
    id: 'agent-2',
    name: 'DeepSeek',
    avatar: AVATAR_MAP.deepseek,
    providerId: 'deepseek-official',
    modelId: 'deepseek-reasoner',
    systemPrompt: '你代表 DeepSeek R1。你非常擅长推理、编码和深入的逻辑分析。',
    color: 'bg-indigo-600',
    config: {
      temperature: 0.6,
      maxTokens: 4000,
      enableReasoning: true,
      reasoningBudget: 0 
    },
    role: AgentRole.MEMBER
  }
];

// 默认记忆配置
const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
  threshold: 20,
  summaryModelId: '',
  summaryProviderId: ''
};

// 初始群组
export const INITIAL_GROUPS: ChatGroup[] = [
  {
    id: 'group-1',
    name: '默认群组',
    memberIds: ['agent-1', 'agent-2'],
    scenario: '这是一个轻松的聊天室。大家可以自由讨论科技、生活或任何感兴趣的话题。',
    memoryConfig: DEFAULT_MEMORY_CONFIG,
    createdAt: Date.now()
  }
];

export const INITIAL_SESSIONS: ChatSession[] = [
  {
    id: 'session-1',
    groupId: 'group-1',
    name: '默认对话',
    messages: [],
    lastUpdated: Date.now(),
    isAutoRenamed: false,
    mutedAgentIds: [],
    mutedAgents: [],
    yieldedAgentIds: []
  }
];
