
import { ApiProvider, Message, AgentType, GeminiMode } from '../types';
import { GoogleGenAI } from "@google/genai";
import { USER_ID } from '../constants';

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

// Helper to find the best model for summarization (Prefer Qwen/Small models)
const findSummaryAgent = (providers: ApiProvider[]) => {
  // 1. Try to find a model with 'qwen' in id
  for (const p of providers) {
    const qwenModel = p.models.find(m => m.id.toLowerCase().includes('qwen'));
    if (qwenModel) return { provider: p, modelId: qwenModel.id };
  }
  
  // 2. Try to find a model with 'flash' or 'mini' or '7b' or 'haiku' (fast models)
  for (const p of providers) {
    const fastModel = p.models.find(m => 
      m.id.toLowerCase().includes('flash') || 
      m.id.toLowerCase().includes('mini') || 
      m.id.toLowerCase().includes('7b') ||
      m.id.toLowerCase().includes('haiku')
    );
    if (fastModel) return { provider: p, modelId: fastModel.id };
  }

  // 3. Fallback to first available
  if (providers.length > 0 && providers[0].models.length > 0) {
    return { provider: providers[0], modelId: providers[0].models[0].id };
  }

  return null;
};

export const generateSessionName = async (
  messages: Message[],
  providers: ApiProvider[]
): Promise<string | null> => {
  
  const target = findSummaryAgent(providers);
  if (!target) return null;

  const { provider, modelId } = target;

  // Prepare simple context
  const transcript = messages.slice(-5).map(m => {
    return `${m.senderId === USER_ID ? 'User' : 'Bot'}: ${m.text}`;
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
    
    // 2. OpenAI Compatible Implementation (Covers everything else)
    else {
      if (!provider.baseUrl || !provider.apiKey) return null;

      // Ensure /chat/completions endpoint
      const baseUrl = provider.baseUrl.replace(/\/+$/, '');
      
      const response = await fetch(`${baseUrl}/chat/completions`, {
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
      });

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
     } else {
        if (!provider.baseUrl || !provider.apiKey) return null;
        const baseUrl = provider.baseUrl.replace(/\/+$/, '');
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
            body: JSON.stringify({
                model: modelId,
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 2000
            })
        });
        if (!res.ok) return null;
        const json = await res.json();
        return json.choices?.[0]?.message?.content?.trim() || null;
     }
  } catch (e) {
      console.error("Summary update failed", e);
      return null;
  }
};
