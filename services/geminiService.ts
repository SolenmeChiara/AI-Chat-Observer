
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
  humanDisguise?: string[],
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>
): AsyncGenerator<StreamChunk> {
  const ai = getClient(geminiConfig);
  
  // 1. Context Limit Slicing (exclude streaming placeholders - they're invisible to other AIs)
  let effectiveMessages = messages.filter(m => !m.isStreaming);
  if (contextLimit > 0) effectiveMessages = effectiveMessages.slice(-contextLimit);

  // 2. Join-time filtering
  let joinFilteredMessages = effectiveMessages;
  const joinMsgId = agentJoinedAt?.[agent.id];
  if (joinMsgId && hidePreJoinMessages?.[agent.id]) {
    const joinIdx = effectiveMessages.findIndex(m => m.id === joinMsgId);
    if (joinIdx >= 0) joinFilteredMessages = effectiveMessages.slice(joinIdx);
  }

  // 3. Visibility Logic
  const visibleMessages = joinFilteredMessages.filter(m => {
    if (m.isSystem) return true;
    if (m.pmTargetId) {
      if (m.senderId === agent.id) return true;
      return m.pmTargetId === agent.id;
    }
    if (m.senderId === USER_ID) return true;
    if (m.senderId === agent.id) return true;
    const blocked = agentVisibility?.[agent.id];
    if (blocked?.includes(m.senderId)) return false;
    return visibilityMode === 'OPEN';
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
      [ADMIN COMMANDS]
      You are a group admin. Available commands (inside {{RESPONSE:}}):
      {{MUTE: Name, Duration}} (10min/30min/1h/1d) | {{UNMUTE: Name}}
      {{NOTE: content}} | {{DELNOTE: keyword}} | {{CLEARNOTES}}
      Never mute the User or other admins.
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
      [SEARCH TOOL]
      Use {{SEARCH: query}} inside {{RESPONSE:}} to search the web. One search per message.
      Example: {{RESPONSE: {{SEARCH: latest AI news}} Let me look that up}}
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
    [PRIVATE MESSAGE]
    Send a PM visible only to one member: {{RES_PM_Name: message}}
    Can combine with public message: {{RESPONSE: public text}}{{RES_PM_Name: private text}}
    Available targets: ${pmTargetNames}
    One PM target per turn. Do NOT wrap PM inside {{RESPONSE:}}.
    `;
  }
  // -------------------------------

  const splitProtocol = entertainmentConfig?.enableSplit ? `
- Paragraph break: use [SPLIT] anywhere in your message to create a visual paragraph break
` : '';

  // System Instruction
  const systemPrompt = `
${scenario ? `[SCENARIO]\n${scenario}\n` : ''}
${memoryContext}

[GROUP CHAT]
Time: ${new Date().toLocaleString()}
You are ${agent.name} (${agent.role}) in a group chat.
Persona: ${agent.systemPrompt}

Members:
- ${userName || 'User'} (Human)${userPersona ? `: ${userPersona}` : ''}
${memberList}
${myLastActionContext}
${attentionInstruction}

[OUTPUT FORMAT]
You MUST use one of these formats. Unwrapped text is discarded.
- Speak: {{RESPONSE: your message}}
- Stay silent: {{PASS}}
- Mute yourself: {{SILENCE: 10min}} or {{SILENCE: 1h}} or {{SILENCE}} (permanent)
- Quote old message: {{RESPONSE: {{REPLY: message_id}} your message}}
- @mention: use @Name inside {{RESPONSE:}} only when directly addressing someone
${adminProtocol}${searchToolProtocol}${entertainmentProtocol}${pmProtocol}${splitProtocol}
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
    // Search results: inject as labeled user context
    if (m.isSearchResult) {
      const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
      const lastEntry = formattedContents[formattedContents.length - 1];
      const searchPart = { text: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` };
      if (lastEntry?.role === 'user') {
        lastEntry.parts.push(searchPart);
      } else {
        formattedContents.push({ role: 'user', parts: [searchPart] });
      }
      continue;
    }

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
    const pmLabel = m.pmTargetId ? ' [PM]' : '';
    const isAI = !m.isSystem && m.senderId !== USER_ID && m.senderId !== 'SYSTEM' && m.senderId !== 'narrator';
    const wrappedText = isAI ? `{{RESPONSE: ${m.text}}}` : m.text;
    let textContent = isSelf ? wrappedText : `[${timeStr}] [ID: ${m.id}]${pmLabel} ${senderName}: ${wrappedText}`;

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
    parts: [{ text: `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.` }]
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
      const effectiveTemp = isGemini3 && agent.config.enableReasoning ? 1.0 : agent.config.temperature;
      const apiConfig: any = {
        systemInstruction: supportsSystemInstruction ? systemPrompt : undefined,
        maxOutputTokens: agent.config.maxTokens,
        tools: enableGoogleSearch ? [{ googleSearch: {} }] : undefined,
      };
      if (effectiveTemp !== null) apiConfig.temperature = effectiveTemp;
      if (agent.config.topP !== null) apiConfig.topP = agent.config.topP;

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
