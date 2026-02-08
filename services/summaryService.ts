
import { ApiProvider, Message, AgentType, GeminiMode } from '../types';
import { GoogleGenAI } from "@google/genai";
import { USER_ID } from '../constants';

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

// Helper to find the best model for summarization (Prefer Qwen/Small models)
const findSummaryAgent = (providers: ApiProvider[]) => {
  // Filter to only providers with valid credentials
  const validProviders = providers.filter(hasValidCredentials);

  if (validProviders.length === 0) {
    console.warn('[findSummaryAgent] No providers with valid credentials found');
    return null;
  }

  // 1. Try to find a model with 'qwen' in id
  for (const p of validProviders) {
    const qwenModel = p.models.find(m => m.id.toLowerCase().includes('qwen'));
    if (qwenModel) return { provider: p, modelId: qwenModel.id };
  }

  // 2. Try to find a model with 'flash' or 'mini' or '7b' or 'haiku' (fast models)
  for (const p of validProviders) {
    const fastModel = p.models.find(m =>
      m.id.toLowerCase().includes('flash') ||
      m.id.toLowerCase().includes('mini') ||
      m.id.toLowerCase().includes('7b') ||
      m.id.toLowerCase().includes('haiku')
    );
    if (fastModel) return { provider: p, modelId: fastModel.id };
  }

  // 3. Fallback to first available with credentials
  if (validProviders[0].models.length > 0) {
    const result = { provider: validProviders[0], modelId: validProviders[0].models[0].id };
    console.log('[findSummaryAgent] Using fallback:', result.provider.name, result.modelId);
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
    Generate a short, concise title for this chat group (max 10 Chinese characters).
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

      if (!response.ok) return null;
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
            max_tokens: 20
          })
        },
        15000, // 15 second timeout
        2 // 2 retries
      );

      if (!response.ok) return null;
      const json = await response.json();
      return json.choices?.[0]?.message?.content?.trim() || null;
    }

  } catch (e) {
    console.error("Auto-rename failed", e);
    return null;
  }
};

export const updateSessionSummary = async (
  currentSummary: string | undefined,
  adminNotes: string[] | undefined,
  recentMessages: Message[],
  provider: ApiProvider,
  modelId: string,
  allAgents: any[] // to resolve names
): Promise<string | null> => {

  const transcript = recentMessages.map(m => {
     const sender = allAgents.find((a:any) => a.id === m.senderId);
     const name = sender ? sender.name : (m.senderId === USER_ID ? 'User' : 'System');
     return `${name}: ${m.text}`;
  }).join('\n');

  const notesText = adminNotes && adminNotes.length > 0 
    ? adminNotes.join('\n') 
    : 'None';

  const prompt = `
    [CONVERSATION CHRONICLE TASK]
    You are the archivist for a group chat, responsible for maintaining a detailed conversation record.
    Your goal is to merge new dialogue into the existing archive, creating a comprehensive timeline.

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
       - Maintain narrative coherence and readability

    [OUTPUT]
    Output ONLY the updated complete archive with no additional commentary.
    The archive should be thorough and well-organized, allowing readers to fully understand the conversation's context and progression.

    IMPORTANT: Keep the total length under 800 words (approximately 1500 Chinese characters). If the archive grows too long, prioritize recent events and condense older content into brief summaries while preserving key character details and turning points.
  `;

  try {
     if (provider.type === AgentType.GEMINI) {
        const ai = getGeminiClient(provider);
        const res = await ai.models.generateContent({
           model: modelId,
           contents: prompt,
           config: { maxOutputTokens: 2000 }
        });
        return res.text?.trim() || null;
     } else if (provider.type === AgentType.ANTHROPIC) {
        // Anthropic uses different endpoint and headers
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
                    max_tokens: 2000,
                    messages: [{ role: 'user', content: prompt }]
                })
            },
            30000,
            1
        );
        if (!res.ok) return null;
        const json = await res.json();
        return json.content?.[0]?.text?.trim() || null;
     } else {
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
                    max_tokens: 2000
                })
            },
            30000, // 30 second timeout (longer for summary updates)
            1 // 1 retry
        );
        if (!res.ok) return null;
        const json = await res.json();
        return json.choices?.[0]?.message?.content?.trim() || null;
     }
  } catch (e) {
      console.error("Summary update failed", e);
      return null;
  }
};
