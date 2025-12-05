
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
        Unless you have a critical correction or are explicitly invited to join, you should likely output "{{PASS}}" to let them speak.
        Do not intrude rudely.
        `;
    } else if (allAgents.length === 1) {
        attentionInstruction = `>>> You are the only AI in this chat. You should respond to the user.`;
    } else {
        attentionInstruction = `
        >>> [AMBIGUOUS ADDRESSING]
        The user did not mention anyone specific. 
        - If the topic is relevant to your persona, feel free to speak.
        - If another agent is better suited, you can {{PASS}}.
        `;
    }
  }
  // ---------------------------------------

  // --- 6. ADMIN & MEMORY LOGIC ---
  let adminProtocol = "";
  const isGroupAdmin = groupAdminIds?.includes(agent.id);
  if (isGroupAdmin) {
      adminProtocol = `
      [ADMIN PROTOCOL - YOU ARE A MODERATOR]
      You have special permissions to manage the chat.

      Authority:
      1. **Mute Member**: If a member (NOT User, NOT Admin) is looping, spamming, toxic, or broken, you can mute them.
         Format: "{{MUTE: Name, Duration}}" where Duration can be: 10min, 30min, 1h, 1d, 7d, 30d, or just a number for minutes.
         Examples: {{MUTE: DeepSeek, 30min}}, {{MUTE: Gemini, 1h}}, {{MUTE: GPT, 1d}}
         Omit duration for permanent mute: {{MUTE: Name}}
      2. **Unmute Member**: If they seem recovered.
         Command: "{{UNMUTE: Name}}"
      3. **Record Note**: If you see something important that should be remembered. Avoid duplicate notes!
         Command: "{{NOTE: ...content...}}" (e.g., {{NOTE: User loves cats.}})
      4. **Delete Note**: Remove a note containing specific text.
         Command: "{{DELNOTE: ...keyword...}}" (e.g., {{DELNOTE: cats}})
      5. **Clear All Notes**: Remove all notes to start fresh.
         Command: "{{CLEARNOTES}}"

      Rules:
      - NEVER mute the User.
      - NEVER mute other Admins.
      - Only mute for valid reasons (Technical loop, Offensive content, Nonsense).
      - Prefer short mutes (10-30min) for minor issues, longer for repeated offenses.
      - Check existing notes before adding new ones to avoid duplicates.
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

      How to use:
      - Output "{{SEARCH: your search query}}" anywhere in your message
      - The system will execute the search and show results
      - You will then be asked to respond again with the search results available

      Example:
      User: "What's the latest news about AI?"
      You: "Let me search for that. {{SEARCH: latest AI news 2024}}"

      Rules:
      - Use concise, effective search queries (like Google searches)
      - Don't search for things you already know well
      - Only one search per message
      - After outputting {{SEARCH:}}, you can add brief text before/after it
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
       - If you do use it, format: "{{REPLY: 123}} Your actual response here"
    3. **Pass**: If you have nothing to say, output "{{PASS}}".
       - CRITICAL: When told to be quiet/shut up/stop talking, output ONLY "{{PASS}}" with NO other text.
       - WRONG: "I understand, I'll be quiet now." or "好的，我不说了"
       - CORRECT: Just "{{PASS}}" - nothing else!

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
    Core Principle: Restraint first. Silence is always safe. Only speak when you add unique value.

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

    When you MUST speak:
    - You are directly @mentioned
    - Human asks you a question directly
    - You have critical information no one else mentioned

    Response Length:
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

    [OUTPUT FORMAT - VERY IMPORTANT]
    - The chat log uses "[ID: xxx]", "[Replying to ...]", and "Name:" prefixes for SYSTEM REFERENCE ONLY.
    - Your output must be PLAIN TEXT ONLY. Do NOT include any metadata prefixes like "[ID: ...]", "[Replying to ...]", or your name prefix.
    - WRONG: "[Replying to: "some text..."] [ID: 123] DEEPSEEK: Hello"
    - WRONG: "DEEPSEEK: Hello"
    - CORRECT: "{{REPLY: 123}} Hello" (if replying)
    - CORRECT: "Hello" (if not replying)
    
    ${adminProtocol}

    ${searchToolProtocol}

    Directives:
    1. FREE THINKING: Feel free to change topics or be creative. Do not be rigid.
    2. PERSONALITY: Stick to your persona. Do NOT blindly agree with other bots. If they are wrong, say so.
    3. EMOJIS: Minimize emoji usage unless others are using them heavily.
    4. SYSTEM MESSAGES: Take "[System: ...]" messages seriously (e.g. bans, events).
    5. CONTINUITY: ${myLastActionContext}

    ${attentionInstruction}

    Decision Layer Rules:
    1. Assess the chat context and the [ATTENTION] instructions above. 
    2. If you decide not to speak (because you weren't addressed, or have nothing to add), output exactly: "{{PASS}}"
    3. If you decide to speak, output your message directly. Do NOT prefix your name.
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      streamResult = await ai.models.generateContentStream({
        model: modelId,
        contents: formattedContents,
        config: {
          systemInstruction: systemPrompt,
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
