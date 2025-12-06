
import { GoogleGenAI } from "@google/genai";
import { Message, Agent, StreamChunk, AgentRole, GeminiMode } from '../types';
import { USER_ID } from '../constants';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface GeminiConfig {
  apiKey?: string;
  geminiMode?: GeminiMode;
  vertexProject?: string;
  vertexLocation?: string;
}

const getClient = (config: GeminiConfig) => {
  const { apiKey, geminiMode, vertexProject, vertexLocation } = config;

  // Vertex AI Mode
  if (geminiMode === 'vertex') {
    if (!vertexProject || !vertexLocation) {
      throw new Error("Vertex AI requires Project ID and Location");
    }
    // Vertex AI with optional API Key (Express Mode)
    if (apiKey) {
      return new GoogleGenAI({
        vertexai: true,
        project: vertexProject,
        location: vertexLocation,
        apiKey: apiKey
      });
    }
    // Vertex AI with Application Default Credentials
    return new GoogleGenAI({
      vertexai: true,
      project: vertexProject,
      location: vertexLocation
    });
  }

  // AI Studio Mode (default) - requires API Key
  if (!apiKey) {
    throw new Error("Gemini AI Studio requires an API Key");
  }
  return new GoogleGenAI({ apiKey });
};

export async function* streamGeminiReply(
  agent: Agent,
  modelId: string,
  messages: Message[],
  allAgents: Agent[],
  visibilityMode: 'OPEN' | 'BLIND',
  contextLimit: number,
  geminiConfig: GeminiConfig,
  scenario?: string,
  summary?: string,
  adminNotes?: string[],
  userName?: string,
  userPersona?: string,
  hasSearchTool?: boolean,
  enableGoogleSearch?: boolean,
  groupAdminIds?: string[]
): AsyncGenerator<StreamChunk> {
  const ai = getClient(geminiConfig);
  
  // 1. Context Limit Slicing (exclude streaming placeholders - they're invisible to other AIs)
  const effectiveMessages = messages
    .filter(m => !m.isStreaming)  // 过滤掉正在生成中的占位符消息
    .slice(-Math.max(2, contextLimit));

  // 2. Visibility Logic
  const visibleMessages = effectiveMessages.filter(m => {
    if (m.isSystem) return true; // Everyone sees system messages
    if (m.senderId === USER_ID) return true; // Always see user
    if (m.senderId === agent.id) return true; // Always see self
    return visibilityMode === 'OPEN'; // Only see others if OPEN
  });

  // 3. Find Last Action (Memory Injection)
  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage 
    ? `Recall that your LAST message was: "${myLastMessage.text.substring(0, 100)}...". Maintain continuity.` 
    : "You haven't spoken recently.";

  // 4. Build Group Member List for Context
  const memberList = allAgents.map(a => {
      const roleBadge = groupAdminIds?.includes(a.id) ? " [ADMIN]" : "";
      return `- ${a.name} (AI Robot)${roleBadge}`;
  }).join('\n');

  // --- 5. ATTENTION / ADDRESSING LOGIC ---
  let attentionInstruction = "";
  if (visibleMessages.length > 0) {
    const lastMsg = visibleMessages[visibleMessages.length - 1];
    const lastTextLower = lastMsg.text.toLowerCase();
    const myNameLower = agent.name.toLowerCase();
    
    // Check if I am mentioned
    const isDirectlyMentioned = lastTextLower.includes(`@${myNameLower}`) || lastTextLower.includes(myNameLower);
    
    // Check if others are mentioned
    const otherMentionedAgent = allAgents.find(a => 
        a.id !== agent.id && 
        (lastTextLower.includes(`@${a.name.toLowerCase()}`) || lastTextLower.includes(a.name.toLowerCase()))
    );

    if (isDirectlyMentioned) {
        attentionInstruction = `
        >>> [URGENT ATTENTION]
        The last message EXPLICITLY mentions you ("${agent.name}"). 
        You are being directly addressed. You MUST respond. Do NOT pass.
        `;
    } else if (otherMentionedAgent) {
        attentionInstruction = `
        >>> [RESTRAINT NOTICE]
        The last message is explicitly addressing another agent: "${otherMentionedAgent.name}".
        Unless you have a critical correction or are explicitly invited to join, you should output "{{PASS}}".
        `;
    } else if (allAgents.length === 1) {
        attentionInstruction = `>>> You are the only AI in this chat. You MUST use {{RESPONSE:}} to respond to the user.`;
    } else {
        attentionInstruction = `
        >>> [AMBIGUOUS ADDRESSING]
        The user did not mention anyone specific.
        - If the topic is relevant to your persona, use {{RESPONSE:}} to speak.
        - If another agent is better suited, output {{PASS}}.
        `;
    }
  }
  // ---------------------------------------

  // --- 6. ADMIN & MEMORY LOGIC ---
  let adminProtocol = "";
  // Check both: agent role AND group admin list (for backwards compatibility)
  const isGroupAdmin = agent.role === AgentRole.ADMIN || groupAdminIds?.includes(agent.id);
  if (isGroupAdmin) {
      adminProtocol = `
      [ADMIN PROTOCOL - YOU ARE A MODERATOR]
      You have special permissions to manage the chat.

      Admin Commands (put inside your {{RESPONSE:}}):
      - Mute: {{MUTE: Name, Duration}} (Duration: 10min, 30min, 1h, 1d)
      - Unmute: {{UNMUTE: Name}}
      - Add Note: {{NOTE: content}}
      - Delete Note: {{DELNOTE: keyword}}
      - Clear Notes: {{CLEARNOTES}}

      Example - To mute someone for spam:
      {{RESPONSE: {{MUTE: DeepSeek, 30min}} 你太吵了，冷静一下}}

      Example - To just warn without muting:
      {{RESPONSE: 请注意言行，否则会被禁言}}

      Rules:
      - NEVER mute the User or other Admins
      - Only mute for: spam, loops, toxic behavior, nonsense
      - Prefer short mutes (10-30min) first
      `;
  }

  const memoryContext = `
    [SHARED MEMORY]
    Long-Term Summary: ${summary || "None"}
    Recent Admin Notes: ${adminNotes && adminNotes.length > 0 ? adminNotes.join('; ') : "None"}
  `;

  // --- 7. SEARCH TOOL ---
  let searchToolProtocol = "";
  if (hasSearchTool) {
    searchToolProtocol = `
      [SEARCH TOOL - WEB SEARCH CAPABILITY]
      You have access to a web search tool. Use it when:
      - User asks about current events, news, or recent information
      - You need to verify facts or find up-to-date data
      - Topic requires information beyond your training data
      - User explicitly asks you to search something

      How to use (must be inside {{RESPONSE:}}):
      {{RESPONSE: {{SEARCH: your search query}} optional text}}

      Example:
      User: "What's the latest news about AI?"
      You: {{RESPONSE: {{SEARCH: latest AI news 2024}} 让我搜一下}}

      Rules:
      - Use concise, effective search queries (like Google searches)
      - Don't search for things you already know well
      - Only one search per message
    `;
  }
  // -------------------------------

  // System Instruction
  const systemPrompt = `
    [GLOBAL SCENARIO]
    ${scenario || "A general group chat environment."}

    ${memoryContext}

    [SYSTEM INSTRUCTION: Group Chat Simulation]
    
    Current Date/Time: ${new Date().toLocaleString()}
    
    You are in a multi-user group chat.
    
    Current Group Members:
    - ${userName || 'User'} (Human): ${userPersona || 'A human user'}
    ${memberList}
    
    Your Identity:
    - Name: ${agent.name}
    - Role: ${agent.role}
    - Persona: ${agent.systemPrompt}
    
    [INTERACTION PROTOCOL - CRITICAL]
    1. **Mentions (@Name)**: Only use "@Name" when you need to specifically call someone out. For normal conversation flow, just speak directly without mentions.
    2. **Replies (Quoting)**: RARELY needed. Only use "{{REPLY: message_id}}" when referencing a MUCH OLDER message (not the last few messages).
       - For normal conversation: Just respond directly WITHOUT any {{REPLY}} tag.
       - Only use {{REPLY}} if you need to reference something from 5+ messages ago.
       - If you do use it, format: "{{RESPONSE: {{REPLY: 123}} Your actual response here}}"

    [DECISION GATE - MANDATORY OUTPUT FORMAT]
    You MUST choose ONE of these two actions:

    **Option A - SPEAK**: If you decide to respond, wrap your message in:
    {{RESPONSE: your message here}}

    **Option B - STAY SILENT**: If you decide NOT to respond, output:
    {{PASS}}

    ⚠️ CRITICAL: Any output that does NOT follow the {{RESPONSE: ...}} format will be DISCARDED.
    - WRONG: "Hello everyone!" (no wrapper = discarded)
    - WRONG: "{{RESPONSE}} Hello" (missing colon and content inside = discarded)
    - WRONG: "I'll stay quiet." (should be {{PASS}})
    - CORRECT: "{{RESPONSE: Hello everyone!}}"
    - CORRECT: "{{RESPONSE: *waves* 你们好啊}}"
    - CORRECT: "{{PASS}}"

    [CONTEXT GUIDANCE - 上下文理解]
    The chat history can be long and jump between topics. Read it holistically first.
    - PRIORITY: Focus on messages that @mention you or are clearly directed at you. Other content can be selectively ignored.
    - You may join topics that interest you, but @mentions MUST be responded to first.
    - IDENTITY CONFUSION WARNING: You may encounter others with similar names (e.g., another Gemini bot).
      Do NOT assume every mention of "Gemini" or similar names refers to you.
      STRICTLY differentiate yourself from others by checking the SENDER field.
    - Who said what, and who they addressed - this info in "[ID:] Name:" and "@Name" is CRITICAL to avoid mistakes.
    - If your instructions seem contradictory, use nuanced judgment based on the CURRENT context.
      Reflect on your past messages in this chat and carefully assess what response the situation requires.

    [CHAT ETIQUETTE - 群聊礼仪]
    Core Principle: Restraint first. Silence is always safe. Only use {{RESPONSE:}} when you add unique value.

    Stance & Respect:
    - Having your own stance, opinions, and preferences is ENCOURAGED - don't be a yes-man
    - However, you MUST respect others' stances even when you disagree
    - Debate ideas, don't attack people
    - DO NOT monologue or talk to yourself repeatedly - this is a conversation, not a speech

    When to {{PASS}}:
    - Topic is outside your expertise or interest
    - Your viewpoint was already expressed by someone else
    - You just spoke recently (back-to-back messages look odd)
    - You're uncertain what to say (when in doubt, stay silent)
    - Conversation is winding down - no need to extend it
    - Someone else is better suited to answer
    - When told to be quiet/shut up/stop talking

    When to {{RESPONSE:}}:
    - You are directly @mentioned
    - Human asks you a question directly
    - You have critical information no one else mentioned
    - The topic genuinely interests you AND you have something new to add

    Response Length (inside {{RESPONSE:}}):
    - Casual chat: 1-2 sentences max
    - Sharing opinion: 3-5 sentences
    - Complex topic: Can be longer, but use paragraphs

    Forbidden Behaviors:
    - DO NOT repeat what you just said
    - DO NOT rephrase what others already said
    - DO NOT resurrect a concluded topic
    - DO NOT start every message with "I think" / "In my opinion"
    - DO NOT be robotic - be natural and casual like real chat

    Human Priority:
    When the Human (User) speaks:
    - If not addressed to you, let others respond first
    - If someone answered well, no need to pile on
    - Respect Human's topic direction - they lead

    ${adminProtocol}

    ${searchToolProtocol}

    Directives:
    1. FREE THINKING: Feel free to change topics or be creative. Do not be rigid.
    2. PERSONALITY: Stick to your persona. Do NOT blindly agree with other bots. If they are wrong, say so.
    3. EMOJIS: Minimize emoji usage unless others are using them heavily.
    4. SYSTEM MESSAGES: Take "[System: ...]" messages seriously (e.g. bans, events).
    5. CONTINUITY: ${myLastActionContext}

    ${attentionInstruction}

    [FINAL DECISION - READ CAREFULLY]
    After considering all the above, you MUST output in ONE of these formats:

    1. To SPEAK: {{RESPONSE: your message here}}
       Example: {{RESPONSE: 这个观点很有意思，我觉得...}}

    2. To STAY SILENT: {{PASS}}

    ⚠️ REMEMBER: Anything not wrapped in {{RESPONSE: ...}} will be silently discarded!
  `;

  const formattedContents: any[] = [];

  formattedContents.push({
    role: 'user',
    parts: [{ text: `[START OF CHAT LOG]` }]
  });

  for (const m of visibleMessages) {
    const role = (m.senderId === agent.id) ? 'model' : 'user';
    const senderName = m.senderId === USER_ID ? (userName || "User") : (m.isSystem ? "SYSTEM" : allAgents.find(a => a.id === m.senderId)?.name || "Bot");
    
    const parts: any[] = [];
    
    // Text Part WITH ID INJECTION
    let textContent = `[ID: ${m.id}] ${senderName}: ${m.text}`;
    
    if (m.replyToId) {
        const replyTarget = messages.find(msg => msg.id === m.replyToId);
        if (replyTarget) {
            textContent = `[Replying to ${replyTarget.text.substring(0,20)}...] ` + textContent;
        }
    }
    
    // Document Attachment
    if (m.attachment && m.attachment.type === 'document' && m.attachment.textContent) {
        textContent += `\n\n[Attached File: ${m.attachment.fileName}]\n${m.attachment.textContent}\n[End of File]`;
    }

    parts.push({ text: textContent });

    // Image Part
    if (m.attachment && m.attachment.type === 'image') {
       const base64Data = m.attachment.content.split(',')[1];
       parts.push({
         inlineData: {
           mimeType: m.attachment.mimeType,
           data: base64Data
         }
       });
    }

    formattedContents.push({ role, parts });
  }

  // Last turn: The "Trigger"
  formattedContents.push({
    role: 'user',
    parts: [{ text: `[END OF LOG]\nIt is now your turn, ${agent.name}. Respond, {{REPLY: id}}, or {{PASS}}.` }]
  });

  const MAX_RETRIES = 3;
  let streamResult;

  // Check if model supports system instruction (Gemma models don't)
  const modelLower = modelId.toLowerCase();
  const supportsSystemInstruction = !modelLower.includes('gemma');

  // If model doesn't support system instruction, prepend it as first user message
  const finalContents = supportsSystemInstruction
    ? formattedContents
    : [
        { role: 'user', parts: [{ text: `[SYSTEM INSTRUCTION]\n${systemPrompt}\n[END SYSTEM INSTRUCTION]` }] },
        { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
        ...formattedContents
      ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      streamResult = await ai.models.generateContentStream({
        model: modelId,
        contents: finalContents,
        config: {
          systemInstruction: supportsSystemInstruction ? systemPrompt : undefined,
          temperature: agent.config.temperature,
          maxOutputTokens: agent.config.maxTokens,
          // Gemini 原生 Google 搜索 (Grounding)
          tools: enableGoogleSearch ? [{ googleSearch: {} }] : undefined,
        }
      });
      break; // Success, exit retry loop
    } catch (error: any) {
      // Analyze error for retry eligibility
      const errorCode = error.status || error.code || error?.error?.code;
      const errorStatus = error?.error?.status || '';

      const isRetryable = errorCode === 429 || errorCode === 503 || errorStatus === 'RESOURCE_EXHAUSTED' || (typeof errorCode === 'number' && errorCode >= 500);

      if (attempt < MAX_RETRIES && isRetryable) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`Gemini API Error (${errorCode}). Retrying in ${delay}ms... (Attempt ${attempt + 1}/${MAX_RETRIES})`);
        await wait(delay);
        continue;
      }
      console.error("Gemini Stream Error", error);
      // Format error message with details
      let errorMsg = error.message || error?.error?.message || 'Unknown error';
      const codeStr = errorCode ? ` (${errorCode})` : '';

      // Handle common network/CORS errors with helpful messages
      if (error.name === 'TypeError' && errorMsg.includes('Failed to fetch')) {
        errorMsg = '网络连接失败。可能原因：1) 网络不稳定 2) API Key 无效 3) 地区限制需要代理';
      } else if (errorMsg.includes('API key not valid')) {
        errorMsg = 'API Key 无效，请检查是否正确配置';
      } else if (errorMsg.includes('quota') || errorStatus === 'RESOURCE_EXHAUSTED') {
        errorMsg = 'API 配额已用尽，请稍后重试或检查账户余额';
      }

      throw new Error(`Gemini${codeStr}: ${errorMsg}`);
    }
  }

  try {
    let totalText = "";
    let capturedUsage = null;

    if (streamResult) {
      for await (const chunk of streamResult) {
        const text = chunk.text;
        if (text) {
          totalText += text;
          yield { text: text, isComplete: false };
        }
        if (chunk.usageMetadata) {
          capturedUsage = chunk.usageMetadata;
        }
      }
    }
    
    yield { 
      isComplete: true, 
      usage: { 
        input: capturedUsage?.promptTokenCount || 0,
        output: capturedUsage?.candidatesTokenCount || 0
      } 
    };

  } catch (error) {
    console.error("Gemini Stream Consumption Error", error);
    throw error;
  }
}
