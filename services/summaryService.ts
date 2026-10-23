
import { ApiProvider, Message, AgentType, GeminiMode } from '../types';
import { GoogleGenAI } from "@google/genai";
import { USER_ID } from '../constants';
import { formatMessageTime } from './shared';

// Helper function for fetch with timeout and retry
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 15000,
  retries: number = 2
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      return response;
    } catch (error: any) {
      clearTimeout(timeoutId);
      lastError = error;

      // If aborted (timeout), log and retry
      if (error.name === 'AbortError') {
        console.warn(`[fetchWithTimeout] Request timed out (attempt ${attempt + 1}/${retries + 1})`);
      } else {
        console.warn(`[fetchWithTimeout] Request failed (attempt ${attempt + 1}/${retries + 1}):`, error.message);
      }

      // Don't retry on last attempt
      if (attempt < retries) {
        // Wait a bit before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError || new Error('Request failed after retries');
}

// Helper to create Gemini client based on provider config
const getGeminiClient = (provider: ApiProvider) => {
  const { apiKey, geminiMode, vertexProject, vertexLocation } = provider;

  // Vertex AI Mode
  if (geminiMode === 'vertex') {
    if (!vertexProject || !vertexLocation) {
      throw new Error("Vertex AI requires Project ID and Location");
    }
    if (apiKey) {
      return new GoogleGenAI({
        vertexai: true,
        project: vertexProject,
        location: vertexLocation,
        apiKey: apiKey
      });
    }
    return new GoogleGenAI({
      vertexai: true,
      project: vertexProject,
      location: vertexLocation
    });
  }

  // AI Studio Mode (default)
  if (!apiKey) {
    throw new Error("Gemini AI Studio requires an API Key");
  }
  return new GoogleGenAI({ apiKey });
};

// Helper to check if a provider has valid credentials
const hasValidCredentials = (provider: ApiProvider): boolean => {
  // Gemini requires API key (or Vertex config)
  if (provider.type === AgentType.GEMINI) {
    if (provider.geminiMode === 'vertex') {
      return !!(provider.vertexProject && provider.vertexLocation);
    }
    return !!provider.apiKey;
  }
  // Anthropic requires baseUrl and apiKey
  if (provider.type === AgentType.ANTHROPIC) {
    return !!(provider.baseUrl && provider.apiKey);
  }
  // OpenAI-compatible requires baseUrl and apiKey
  return !!(provider.baseUrl && provider.apiKey);
};

// Reasoning models are unsuitable for simple tasks like naming — they waste tokens on <think> tags
const isReasoningModel = (modelId: string): boolean => {
  const id = modelId.toLowerCase();
  // Match reasoning model patterns: r1, o1, o3, o4-mini, thinking, reasoner, etc.
  return /\b(r1|o1|o3|o4)\b/.test(id) || id.includes('thinking') || id.includes('reasoner');
};

// Helper to find the best model for summarization (Prefer Qwen/Small models, exclude reasoning)
const findSummaryAgent = (providers: ApiProvider[]) => {
  // Filter to only providers with valid credentials
  const validProviders = providers.filter(hasValidCredentials);

  if (validProviders.length === 0) {
    console.warn('[findSummaryAgent] No providers with valid credentials found');
    return null;
  }

  // 1. Try to find a non-reasoning model with 'qwen' in id
  for (const p of validProviders) {
    const qwenModel = p.models.find(m => m.id.toLowerCase().includes('qwen') && !isReasoningModel(m.id));
    if (qwenModel) return { provider: p, modelId: qwenModel.id };
  }

  // 2. Try to find a non-reasoning model with 'flash' or 'mini' or '7b' or 'haiku' (fast models)
  for (const p of validProviders) {
    const fastModel = p.models.find(m => {
      const id = m.id.toLowerCase();
      return !isReasoningModel(m.id) && (
        id.includes('flash') ||
        id.includes('mini') ||
        id.includes('7b') ||
        id.includes('haiku')
      );
    });
    if (fastModel) return { provider: p, modelId: fastModel.id };
  }

  // 3. Fallback to first non-reasoning model with credentials
  for (const p of validProviders) {
    const nonReasoningModel = p.models.find(m => !isReasoningModel(m.id));
    if (nonReasoningModel) {
      console.log('[findSummaryAgent] Using fallback:', p.name, nonReasoningModel.id);
      return { provider: p, modelId: nonReasoningModel.id };
    }
  }

  // 4. Last resort: use any model (even reasoning), but warn
  if (validProviders[0].models.length > 0) {
    const result = { provider: validProviders[0], modelId: validProviders[0].models[0].id };
    console.warn('[findSummaryAgent] ⚠️ Only reasoning models available, using:', result.provider.name, result.modelId);
    return result;
  }

  console.warn('[findSummaryAgent] Valid providers found but none have models:', validProviders.map(p => p.name));
  return null;
};

export const generateSessionName = async (
  messages: Message[],
  providers: ApiProvider[],
  allAgents: any[] = []
): Promise<string | null> => {

  const target = findSummaryAgent(providers);
  if (!target) {
    console.warn('[Auto-Rename] No suitable provider/model found for auto-naming. Providers:', providers.map(p => `${p.name}(${p.type}, key=${!!p.apiKey}, url=${!!p.baseUrl}, models=${p.models.length})`));
    return null;
  }

  const { provider, modelId } = target;
  console.log('[Auto-Rename] Using provider:', provider.name, 'model:', modelId);

  // Prepare simple context with agent names
  const transcript = messages.slice(-5).map(m => {
    const sender = allAgents.find((a: any) => a.id === m.senderId);
    const name = sender ? sender.name : (m.senderId === USER_ID ? 'User' : (m.senderId === 'SYSTEM' || m.isSystem ? 'System' : 'Unknown'));
    return `${name}: ${m.text}`;
  }).join('\n');

  const prompt = `
    [TASK]
    Read the following group chat conversation.
    Generate a short, concise title for this chat group, written in the SAME language the conversation itself is (mainly) written in — do not translate it into another language.
    Keep it short: at most ~10 characters for CJK languages, at most ~5 words for alphabetic languages.
    Directly output the title. Do NOT add quotation marks or extra explanation.
    
    [CONVERSATION]
    ${transcript}
  `;

  try {
    // 1. Gemini Implementation
    if (provider.type === AgentType.GEMINI) {
      const ai = getGeminiClient(provider);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: prompt
      });
      return response.text?.trim() || null;
    }

    // 2. Anthropic Implementation
    else if (provider.type === AgentType.ANTHROPIC) {
      if (!provider.baseUrl || !provider.apiKey) return null;
      const baseUrl = provider.baseUrl.replace(/\/+$/, '');

      const response = await fetchWithTimeout(
        `${baseUrl}/messages`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': provider.apiKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
          },
          body: JSON.stringify({
            model: modelId,
            max_tokens: 50,
            messages: [{ role: 'user', content: prompt }]
          })
        },
        15000,
        2
      );

      if (!response.ok) {
        console.warn('[Auto-Rename] Anthropic API error:', response.status, await response.text().catch(() => ''));
        return null;
      }
      const json = await response.json();
      return json.content?.[0]?.text?.trim() || null;
    }

    // 3. OpenAI Compatible Implementation
    else {
      if (!provider.baseUrl || !provider.apiKey) return null;

      const baseUrl = provider.baseUrl.replace(/\/+$/, '');

      const response = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${provider.apiKey}`
          },
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 50
          })
        },
        15000, // 15 second timeout
        2 // 2 retries
      );

      if (!response.ok) {
        console.warn('[Auto-Rename] OpenAI API error:', response.status, await response.text().catch(() => ''));
        return null;
      }
      const json = await response.json();
      const result = json.choices?.[0]?.message?.content?.trim() || null;
      if (!result) {
        console.warn('[Auto-Rename] API returned empty content:', JSON.stringify(json.choices?.[0]?.message));
      }
      return result;
    }

  } catch (e) {
    console.error("Auto-rename failed", e);
    return null;
  }
};

/**
 * 归档调用的返回形状。
 *
 * HEAD 只返回文本，三条分支都不读 usage，于是总结（归档后是 1+k 次调用）完全不入账。
 * 归档比 HEAD 贵得多，费用必须可见，所以这里把 usage 一起带出来交给调用方记账。
 * usage 取不到就不带（不同网关对 usage 字段的支持参差不齐），不影响文本本身。
 */
export interface SummaryResult {
  text: string;
  usage?: { input: number; output: number };
}

/**
 * 把一段 prompt 发给总结模型，返回文本 + usage。
 * 三条分支（Gemini / Anthropic / OpenAI-compatible）的超时与重试参数沿用 HEAD 的总结路径。
 * 抛错交给调用方 catch —— 调用方据此判定「本轮归档失败、不推进边界」。
 */
const runSummaryCompletion = async (
  prompt: string,
  provider: ApiProvider,
  modelId: string,
  outputTokens: number
): Promise<SummaryResult | null> => {
  if (provider.type === AgentType.GEMINI) {
    const ai = getGeminiClient(provider);
    const res = await ai.models.generateContent({
      model: modelId,
      contents: prompt,
      config: { maxOutputTokens: outputTokens }
    });
    const text = res.text?.trim();
    if (!text) return null;
    const meta: any = (res as any).usageMetadata;
    const usage = meta && (typeof meta.promptTokenCount === 'number' || typeof meta.candidatesTokenCount === 'number')
      ? { input: meta.promptTokenCount || 0, output: meta.candidatesTokenCount || 0 }
      : undefined;
    return { text, usage };
  }

  if (provider.type === AgentType.ANTHROPIC) {
    if (!provider.baseUrl || !provider.apiKey) return null;
    const baseUrl = provider.baseUrl.replace(/\/+$/, '');
    const res = await fetchWithTimeout(
      `${baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: outputTokens,
          messages: [{ role: 'user', content: prompt }]
        })
      },
      30000,
      1
    );
    if (!res.ok) return null;
    const json = await res.json();
    const text = json.content?.[0]?.text?.trim();
    if (!text) return null;
    const u = json.usage;
    const usage = u && (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number')
      ? { input: u.input_tokens || 0, output: u.output_tokens || 0 }
      : undefined;
    return { text, usage };
  }

  // OpenAI-compatible
  if (!provider.baseUrl || !provider.apiKey) return null;
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const res = await fetchWithTimeout(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        // HEAD 这里写死 2000，忽略了 outputTokens 参数——summaryMaxTokens 设置对 OpenAI 供应商无效。
        max_tokens: outputTokens
      })
    },
    30000, // 30 second timeout (longer for summary updates)
    1 // 1 retry
  );
  if (!res.ok) return null;
  const json = await res.json();
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) return null;
  const u = json.usage;
  const usage = u && (typeof u.prompt_tokens === 'number' || typeof u.completion_tokens === 'number')
    ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0 }
    : undefined;
  return { text, usage };
};

export const updateSessionSummary = async (
  currentSummary: string | undefined,
  adminNotes: string[] | undefined,
  recentMessages: Message[],
  provider: ApiProvider,
  modelId: string,
  allAgents: any[], // to resolve names
  excludePM?: boolean,
  maxTokens?: number
): Promise<SummaryResult | null> => {
  const outputTokens = maxTokens || 2000;

  // 每行带上时间戳（与发给 agent 的历史行同一格式 MM-DD HH:mm，见 services/shared.ts formatMessageTime）。
  // 归档 prompt 明确要求 "Chronological Order / clear temporal segments"，若 transcript 零时间信息，
  // 模型只能凭空编造时间线，而这份摘要会被注入每个 agent 的记忆。
  const transcript = recentMessages.map(m => {
     const sender = allAgents.find((a:any) => a.id === m.senderId);
     const name = sender ? sender.name : (m.senderId === USER_ID ? 'User' : 'System');
     return `[${formatMessageTime(m.timestamp)}] ${name}: ${m.text}`;
  }).join('\n');

  const notesText = adminNotes && adminNotes.length > 0 
    ? adminNotes.join('\n') 
    : 'None';

  const prompt = `
    [CONVERSATION CHRONICLE TASK]
    You are the archivist for a group chat, responsible for maintaining a detailed conversation record.
    Your goal is to merge new dialogue into the existing archive, creating a comprehensive timeline.
    This archive REPLACES the messages it covers: once merged, the participants can no longer read the
    original text — this record is all they will have. Facts, decisions, relationships between
    characters, and unresolved threads MUST survive the merge, or they are lost for good.

    [EXISTING ARCHIVE]
    ${currentSummary || "No previous records."}

    [ADMIN NOTES (Priority Highlights)]
    ${notesText}

    [RECENT CONVERSATION LOG]
    ${transcript}

    [RECORDING PRINCIPLES]
    1. Chronological Order: Record events in the order they occurred, maintaining a clear timeline.
    2. Character Portrayal: Document each participant's speaking style, tone, personality traits, and behavioral patterns.
    3. Detail Preservation:
       - Retain important dialogue content and viewpoints
       - Record interesting interactions and conflicts
       - Preserve key decisions and conclusions
       - Note emotional shifts and relationship developments
    4. Admin Notes: These are manually highlighted priorities - must be fully preserved.
    5. Content Continuity: Do NOT discard important content from the existing archive. Naturally integrate new content into it.
    6. Format Guidelines:
       - Use clear temporal segments
       - Brief headings to summarize each phase are welcome
       - Maintain narrative coherence and readability${excludePM ? `
    7. PRIVACY RULE: This summary is shared with ALL participants. You MUST completely remove any private message (PM/私讯) content from the archive. Strip all references to private conversations, whispered messages, or any content marked as PM/私讯. If the existing archive contains PM content, remove it during this merge. Only record publicly visible group conversation.` : ''}

    [OUTPUT]
    Output ONLY the updated complete archive with no additional commentary.
    The archive should be thorough and well-organized, allowing readers to fully understand the conversation's context and progression.

    IMPORTANT: Keep the total length under 800 words (approximately 1500 Chinese characters). If the archive grows too long, prioritize recent events and condense older content into brief summaries while preserving key character details and turning points.
  `;

  try {
     return await runSummaryCompletion(prompt, provider, modelId, outputTokens);
  } catch (e) {
      console.error("Summary update failed", e);
      return null;
  }
};

/**
 * 私人记忆归档：把一批私讯合并进某个 agent 自己的私人记忆。
 *
 * 只在 `excludePM` 为真时调用（PM 不进公共总结，改由这里各自归档）。
 * 输入 = 该 agent 已有私人记忆 + 本批 PM 行 + 刚生成的公共总结（只读背景，防止复述）。
 * transcript 行格式 `[MM-DD HH:mm] A → B: text`，人类一律显示为 User。
 *
 * prompt 里的 `[PRIVATE MEMORY TASK]` 是这条路径的标识（公共总结那条是 `[CONVERSATION CHRONICLE TASK]`）。
 */
export const updatePrivateSummary = async (
  existingPrivate: string | undefined,
  pmMessages: Message[],
  publicSummary: string | undefined,
  agentName: string,
  provider: ApiProvider,
  modelId: string,
  allAgents: any[], // to resolve names
  maxTokens?: number
): Promise<SummaryResult | null> => {
  const outputTokens = maxTokens || 2000;

  const nameOf = (id?: string): string => {
    if (!id) return 'Unknown';
    if (id === USER_ID) return 'User';
    const found = allAgents.find((a: any) => a.id === id);
    return found ? found.name : (id === 'SYSTEM' ? 'System' : 'Unknown');
  };

  const transcript = pmMessages.map(m => {
    const from = m.senderId === USER_ID ? 'User' : nameOf(m.senderId);
    const to = m.pmTargetId === USER_ID ? 'User' : nameOf(m.pmTargetId);
    return `[${formatMessageTime(m.timestamp)}] ${from} → ${to}: ${m.text}`;
  }).join('\n');

  const prompt = `
    [PRIVATE MEMORY TASK]
    You maintain the PRIVATE memory of one participant of a group chat: ${agentName}.
    This memory records only what ${agentName} learned through private messages (PM/私讯).
    Nobody else can read it, and the messages it covers are about to be dropped from the visible history —
    once merged, ${agentName} can no longer read the original private messages, only this record.

    [EXISTING PRIVATE MEMORY]
    ${existingPrivate || "No previous private records."}

    [NEW PRIVATE MESSAGES]
    ${transcript}

    [PUBLIC SUMMARY — READ-ONLY BACKGROUND]
    ${publicSummary || "None"}

    [RECORDING PRINCIPLES]
    1. Record ONLY private-message content. The public summary above is background for context only —
       never restate or copy it into the private memory.
    2. Preserve promises, secrets, agreements, requests, and anything ${agentName} was asked to keep quiet.
    3. Say clearly who told ${agentName} what, and who ${agentName} said what to.
    4. Merge the new private messages into the existing private memory; do NOT discard earlier private records.
    5. Keep a rough chronological order.
    6. Write in the same language the private messages are (mainly) written in.

    [OUTPUT]
    Output ONLY the updated complete private memory, with no additional commentary.
    Keep it under 400 words (approximately 700 Chinese characters); condense older entries if needed.
  `;

  try {
    return await runSummaryCompletion(prompt, provider, modelId, outputTokens);
  } catch (e) {
    console.error("Private summary update failed", e);
    return null;
  }
};

// ---- 群组共同往事（GROUP_MEMORY_PLAN.md） ----

/**
 * 共同往事的目标长度上限（中文字数；英文约 GROUP_MEMORY_MAX_WORDS 词）。只写进 prompt 约束模型，
 * 不在客户端截断：截断会切在半句话上，而手写内容本来就允许更长（硬上限见 actionContract 的
 * ACTION_LIMITS.groupMemory，那是请求体能装下的量）。
 */
export const GROUP_MEMORY_MAX_CHARS = 1500;
export const GROUP_MEMORY_MAX_WORDS = 800;
/** 提炼结果超过这个长度视为模型失控（复述了整段对话），丢弃不写。 */
export const GROUP_MEMORY_REJECT_CHARS = 16000;
/** 模型认为「没有任何值得跨会话记住的东西」且原来也是空的时候，约定输出这个词。 */
const GROUP_MEMORY_EMPTY_SENTINEL = 'NONE';

/** 提炼的输出 token 下限：1500 中文字约 1500–2250 token，再给思考模型留余量。 */
export const GROUP_MEMORY_MIN_OUTPUT_TOKENS = 6000;

/**
 * 把一批**公开**消息提炼进群组共同往事，返回更新后的全文。
 *
 * 输入只有：该群现有的共同往事 + 本批公开消息（可选再加一份「本会话的公开总结」作背景，
 * 仅手动提炼用，且调用方保证它不含私讯）。**私讯与私人记忆一律不进来**：调用方负责先把
 * `pmTargetId` 消息滤掉，这里再滤一遍兜底。
 *
 * 返回：
 *   - `{ text }`：新的共同往事（可能与原文相同）；
 *   - `{ text: '' }`：原来为空、这批也没有值得记的内容；
 *   - `null`：调用失败 / 输出异常。调用方必须保持原有共同往事不动。
 *
 * prompt 里的 `[GROUP MEMORY TASK]` 是这条路径的标识。
 */
export const distillGroupMemory = async (
  existingMemory: string | undefined,
  publicMessages: Message[],
  provider: ApiProvider,
  modelId: string,
  allAgents: any[], // to resolve names
  maxTokens?: number,
  sessionSummary?: string
): Promise<SummaryResult | null> => {
  // 共同往事跨会话累积，被截断的输出会整段覆盖旧记忆；给一个不低于 GROUP_MEMORY_MIN_OUTPUT_TOKENS 的下限（含思考模型的思考预算）。
  const outputTokens = Math.max(maxTokens || 2000, GROUP_MEMORY_MIN_OUTPUT_TOKENS);

  // 兜底：就算调用方忘了滤，私讯也不能进群组共享记忆
  const msgs = publicMessages.filter(m => !m.pmTargetId && !m.isStreaming);
  const bg = sessionSummary && sessionSummary.trim() ? sessionSummary.trim() : '';
  if (msgs.length === 0 && !bg) return null;

  const transcript = msgs.map(m => {
    const sender = allAgents.find((a: any) => a.id === m.senderId);
    const name = sender ? sender.name : (m.senderId === USER_ID ? 'User' : 'System');
    return `[${formatMessageTime(m.timestamp)}] ${name}: ${m.text}`;
  }).join('\n');

  const existing = existingMemory && existingMemory.trim() ? existingMemory.trim() : '';
  const bgBlock = bg ? `
    [CURRENT SESSION SUMMARY (BACKGROUND)]
    ${bg}
` : '';

  const prompt = `
    [GROUP MEMORY TASK]
    You maintain the long-term GROUP MEMORY of a group chat. The group has many separate conversation
    sessions; this memory is the only thing carried from one session to the next. Every member sees it.

    [EXISTING GROUP MEMORY]
    ${existing || "None yet."}
${bgBlock}
    [NEW CONVERSATION]
    ${transcript || "None"}

    [WHAT BELONGS HERE]
    Only things that should still be true or relevant in a FUTURE, separate session:
    - Lasting facts about members (habits, preferences, quirks, appearance, possessions), e.g. "Astra wears a glove when eating so feathers don't fall in".
    - Running jokes, nicknames, catchphrases, recurring bits.
    - Relationship developments between members, and between members and the User.
    - Shared history worth referring back to (memorable events, decisions, promises, unresolved plans).
    Do NOT include: the moment-to-moment plot of this conversation, small talk, one-off details,
    anything said in private messages (PM/私讯), or instructions to the members.

    [RULES]
    1. Merge the new conversation into the existing memory. Keep every existing item that is still valid;
       update items that changed; drop items only if they were explicitly contradicted.
    2. De-duplicate: one item per fact. Rephrase rather than repeat.
    3. Format: a short bullet list, one fact per line, each line starting with "- ". Name who each item is about.
    4. Write in the language the conversation is (mainly) written in.
    5. Keep the whole memory under ${GROUP_MEMORY_MAX_WORDS} words (approximately ${GROUP_MEMORY_MAX_CHARS} Chinese characters).
       If it would grow longer, merge or shorten the least important items.

    [OUTPUT]
    Output ONLY the complete updated group memory, with no additional commentary.
    If the existing memory is empty AND nothing in the new conversation is worth keeping, output exactly: ${GROUP_MEMORY_EMPTY_SENTINEL}
  `;

  try {
    const res = await runSummaryCompletion(prompt, provider, modelId, outputTokens);
    if (!res || !res.text) return null;
    let text = res.text.trim();
    if (text === GROUP_MEMORY_EMPTY_SENTINEL) {
      // 原来有内容却回了 NONE：等于要清空，不可信，当失败处理，原文不动
      if (existing) return null;
      text = '';
    }
    if (text.length > GROUP_MEMORY_REJECT_CHARS) {
      console.warn(`[GroupMemory] distill output too long (${text.length} chars), discarded`);
      return null;
    }
    return { text, usage: res.usage };
  } catch (e) {
    console.error("Group memory distill failed", e);
    return null;
  }
};
