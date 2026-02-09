
import { GoogleGenAI } from "@google/genai";
import { Message, Agent, StreamChunk, AgentRole, GeminiMode, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Detect Gemini 3+ models (use thinking_level instead of thinkingBudget)
function isGemini3Model(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes('gemini-3') || lower.includes('gemini3');
}

// Helper: Map reasoningBudget to Gemini 3 thinking_level
// LOW: minimizes latency/cost, HIGH: maximizes reasoning depth
function mapBudgetToThinkingLevel(budget: number): 'LOW' | 'HIGH' {
  // If budget is low (< 8000), use LOW level for faster responses
  // Otherwise use HIGH for deeper reasoning
  return budget < 8000 ? 'LOW' : 'HIGH';
}

// Format timestamp for display in chat history (e.g., "01-15 14:30")
function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

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
  groupAdminIds?: string[],
  entertainmentConfig?: EntertainmentConfig,
  agentVisibility?: Record<string, string[]>,
  humanDisguise?: string[]
): AsyncGenerator<StreamChunk> {
  const ai = getClient(geminiConfig);
  
  // 1. Context Limit Slicing (exclude streaming placeholders - they're invisible to other AIs)
  const effectiveMessages = messages
    .filter(m => !m.isStreaming)  // 过滤掉正在生成中的占位符消息
    .slice(-Math.max(2, contextLimit));

  // 2. Visibility Logic
  const visibleMessages = effectiveMessages.filter(m => {
    if (m.isSystem) return true; // Everyone sees system messages
    // PM：仅 sender 和 target 可见（最高优先级，包括用户发的 PM）
    if (m.pmTargetId) {
      if (m.senderId === agent.id) return true; // sender sees own PM
      return m.pmTargetId === agent.id; // only target can see
    }
    if (m.senderId === USER_ID) return true; // Always see user
    if (m.senderId === agent.id) return true; // Always see self
    // 单向屏蔽
    const blocked = agentVisibility?.[agent.id];
    if (blocked?.includes(m.senderId)) return false;
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
      const isDisguised = humanDisguise?.includes(a.id) && a.id !== agent.id;
      const typeLabel = isDisguised ? "(Human)" : "(AI Robot)";
      return `- ${a.name} ${typeLabel}${roleBadge}`;
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

  // --- 8. ENTERTAINMENT TOOLS (Dice, Tarot) ---
  let entertainmentProtocol = "";
  if (entertainmentConfig?.enableDice || entertainmentConfig?.enableTarot) {
    const tools: string[] = [];

    if (entertainmentConfig.enableDice) {
      tools.push(`
      **Dice Roll**
      Use {{ROLL: expression}} to roll dice. The system will display results automatically.
      Format: XdY+Z (X dice with Y sides, plus/minus Z modifier)
      Examples:
      - {{ROLL: d20}} - Roll a 20-sided die
      - {{ROLL: 2d6+3}} - Roll two 6-sided dice, add 3 to result
      - {{ROLL: d100}} - Roll a percentile die

      Use cases: TRPG sessions, skill checks, random decisions`);
    }

    if (entertainmentConfig.enableTarot) {
      tools.push(`
      **Tarot Cards**
      Use {{TAROT: N}} to draw N tarot cards. System shows upright/reversed positions.
      Examples:
      - {{TAROT: 1}} - Draw one card
      - {{TAROT: 3}} - Draw three cards (Past/Present/Future spread)

      Use cases: Divination, plot progression, character fate decisions`);
    }

    entertainmentProtocol = `
    [ENTERTAINMENT TOOLS]
    This chat has the following entertainment features enabled. Use inside {{RESPONSE:}}:
    ${tools.join('\n')}

    Usage examples:
    {{RESPONSE: Let me roll the dice {{ROLL: d20}}}}
    {{RESPONSE: Drawing a tarot card for you {{TAROT: 1}}}}
    `;
  }

  // --- PM (Private Message) PROTOCOL ---
  let pmProtocol = "";
  if (entertainmentConfig?.enablePM && agent.enablePM) {
    const otherAgentNames = allAgents.filter(a => a.id !== agent.id).map(a => a.name);
    const pmTargetNames = [...otherAgentNames, userName || 'User'].join(', ');
    pmProtocol = `
    [PRIVATE MESSAGE (PM) - 私讯功能]
    You can send a private message visible only to a specific member (including the Human user "${userName || 'User'}").
    Use {{RES_PM_Name: your private message}} to send a PM.
    You CAN use both {{RESPONSE:}} and {{RES_PM_Name:}} in the same turn to speak publicly AND send a PM.

    Available targets: ${pmTargetNames}

    Examples (PM only):
    {{RES_PM_${allAgents.find(a => a.id !== agent.id)?.name || 'Alice'}: 这条消息只有你能看到}}

    Examples (public + PM in same turn):
    {{RESPONSE: 大家好，今天天气不错}}{{RES_PM_${allAgents.find(a => a.id !== agent.id)?.name || 'Alice'}: 悄悄告诉你一个秘密}}

    Rules:
    - Only one PM target per turn
    - Do NOT wrap PM inside {{RESPONSE:}} - keep them separate
    - The Human user can always see all PMs
    - Use PM for secrets, strategy, private advice, etc.
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

    ${entertainmentProtocol}

    ${pmProtocol}

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
${entertainmentConfig?.enablePM ? `
    3. To SEND PRIVATE MESSAGE: {{RES_PM_TargetName: your private message}}
       Example: {{RES_PM_Alice: 这条只有你能看到}}
    4. To SPEAK publicly AND send PM in the same turn: use BOTH {{RESPONSE:}} and {{RES_PM_Name:}}
` : ''}
    2. To STAY SILENT: {{PASS}}

    ⚠️ REMEMBER: Anything not wrapped in {{RESPONSE: ...}}${entertainmentConfig?.enablePM ? ' or {{RES_PM_Name: ...}}' : ''} will be silently discarded!
  `;

  const formattedContents: any[] = [];

  formattedContents.push({
    role: 'user',
    parts: [{ text: `[START OF CHAT LOG]` }]
  });

  // Detect if we're using Gemini 3 (needs thought signatures for multi-turn)
  const isGemini3 = isGemini3Model(modelId);

  // Check if any of agent's messages have incomplete thinking (has reasoning but no signature)
  // For Gemini 3, this would cause errors, so we need to handle it
  const hasIncompleteThinking = isGemini3 && visibleMessages.some(m =>
    m.senderId === agent.id && m.reasoningText && !m.reasoningSignature
  );

  for (const m of visibleMessages) {
    const isSelf = m.senderId === agent.id;
    const role = isSelf ? 'model' : 'user';
    const senderName = m.senderId === USER_ID ? (userName || "User") : (m.senderId === 'SYSTEM' || m.isSystem ? "System" : allAgents.find(a => a.id === m.senderId)?.name || "Unknown");

    const parts: any[] = [];

    // For Gemini 3: Include thought signature in model's own messages (required for multi-turn)
    if (isGemini3 && isSelf && m.reasoningText && m.reasoningSignature && !hasIncompleteThinking) {
      parts.push({
        thought: true,
        text: m.reasoningText,
        thoughtSignature: m.reasoningSignature
      });
    }

    // Text Part WITH ID AND TIMESTAMP INJECTION
    const timeStr = formatMessageTime(m.timestamp);
    let textContent = isSelf ? m.text : `[${timeStr}] [ID: ${m.id}] ${senderName}: ${m.text}`;

    if (m.replyToId) {
        const replyTarget = messages.find(msg => msg.id === m.replyToId);
        if (replyTarget) {
            textContent = `[Replying to ${replyTarget.text.substring(0,20)}...] ` + textContent;
        }
    }

    // Document Attachments (multiple)
    if (m.attachments) {
      m.attachments.filter(att => att.type === 'document' && att.textContent).forEach((att, idx) => {
        textContent += `\n\n[Attached File ${idx + 1}: ${att.fileName}]\n${att.textContent}\n[End of File]`;
      });
    }

    parts.push({ text: textContent });

    // Image Parts (multiple)
    if (m.attachments) {
      m.attachments.filter(att => att.type === 'image').forEach(att => {
        const base64Data = att.content.split(',')[1];
        parts.push({
          inlineData: {
            mimeType: att.mimeType,
            data: base64Data
          }
        });
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
      // Detect Gemini 3 model
      const isGemini3 = isGemini3Model(modelId);

      // Build config object
      // Note: Gemini 3 recommends using default temperature (1.0) for thinking mode
      const apiConfig: any = {
        systemInstruction: supportsSystemInstruction ? systemPrompt : undefined,
        temperature: isGemini3 && agent.config.enableReasoning ? 1.0 : agent.config.temperature,
        maxOutputTokens: agent.config.maxTokens,
        // Gemini 原生 Google 搜索 (Grounding)
        tools: enableGoogleSearch ? [{ googleSearch: {} }] : undefined,
      };

      // Add thinkingConfig based on model version
      // For Gemini 3: skip if there's incomplete thinking in history (missing signatures)
      if (agent.config.enableReasoning && !(isGemini3 && hasIncompleteThinking)) {
        if (isGemini3) {
          // Gemini 3: use thinking_level (LOW/HIGH), NOT thinkingBudget
          // includeThoughts: true enables visible thought summaries
          apiConfig.thinkingConfig = {
            thinkingLevel: mapBudgetToThinkingLevel(agent.config.reasoningBudget || 8000),
            includeThoughts: true  // Required to see thinking output
          };
        } else {
          // Gemini 2.5 and earlier: use thinkingBudget
          // thinkingBudget: -1 = dynamic, 0 = disabled, >0 = specific budget
          // includeThoughts: true enables visible thought summaries
          apiConfig.thinkingConfig = {
            thinkingBudget: agent.config.reasoningBudget || -1,  // Default to dynamic
            includeThoughts: true  // Required to see thinking output
          };
        }
      }

      streamResult = await ai.models.generateContentStream({
        model: modelId,
        contents: finalContents,
        config: apiConfig
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
    let capturedThoughtSignature: string | undefined;

    // Check if thinking might be enabled (thinking model OR enableReasoning config)
    const isThinkingModel = modelId.toLowerCase().includes('thinking');
    const isGemini3 = isGemini3Model(modelId);
    const mayHaveThinking = isThinkingModel || agent.config.enableReasoning;

    if (streamResult) {
      for await (const chunk of streamResult) {
        // For thinking-enabled models, parse parts to separate thought from response
        if (mayHaveThinking && chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            if (part.text) {
              if (part.thought) {
                // This is thinking/reasoning content
                yield { reasoning: part.text, isComplete: false };
              } else {
                // This is regular response content
                totalText += part.text;
                yield { text: part.text, isComplete: false };
              }
            }
            // Capture thought signature for Gemini 3 (required for multi-turn)
            if (part.thoughtSignature) {
              capturedThoughtSignature = part.thoughtSignature;
            }
          }
        } else {
          // Non-thinking model or fallback: use simple text extraction
          const text = chunk.text;
          if (text) {
            totalText += text;
            yield { text: text, isComplete: false };
          }
        }

        // Also check for thought signature at candidate level (Gemini 3)
        const candidate = chunk.candidates?.[0] as any;
        if (candidate?.thoughtSignature) {
          capturedThoughtSignature = candidate.thoughtSignature;
        }

        if (chunk.usageMetadata) {
          capturedUsage = chunk.usageMetadata;
        }
      }
    }

    yield {
      isComplete: true,
      reasoningSignature: capturedThoughtSignature,  // Gemini 3 thought signature
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
