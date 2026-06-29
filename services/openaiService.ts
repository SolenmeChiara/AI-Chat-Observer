
import { Agent, Message, StreamChunk, AgentRole, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Format timestamp for display in chat history (e.g., "01-15 14:30")
function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

// Helper: Check if model requires max_completion_tokens instead of max_tokens
// This applies to: o1, o3, gpt-4.5+, and other newer reasoning models
function useMaxCompletionTokens(modelId: string): boolean {
  const lowerModel = modelId.toLowerCase();

  // o-series reasoning models (o1, o3, o4-mini, etc.)
  if (/^o[134](-|$)/.test(lowerModel)) return true;

  // gpt-4.5 and above
  if (lowerModel.includes('gpt-4.5') || lowerModel.includes('gpt-5')) return true;

  // chatgpt-4o-latest and similar new models
  if (lowerModel.includes('chatgpt-4o')) return true;

  return false;
}

// Helper: Map reasoningBudget to OpenAI reasoning_effort level
// reasoning_effort: "low" | "medium" | "high"
function mapBudgetToEffort(budget: number): 'low' | 'medium' | 'high' {
  if (budget < 4000) return 'low';
  if (budget < 16000) return 'medium';
  return 'high';
}

// Helper: Check if model is a DeepSeek model (for thinking mode support)
function isDeepSeekModel(modelId: string, baseUrl?: string): boolean {
  const lowerModel = modelId.toLowerCase();
  const lowerUrl = baseUrl?.toLowerCase() || '';

  // Check model ID patterns
  if (lowerModel.includes('deepseek')) return true;

  // Check baseUrl for DeepSeek API endpoint
  if (lowerUrl.includes('deepseek')) return true;

  return false;
}

// Helper: Check if using OpenRouter API
function isOpenRouterAPI(baseUrl?: string): boolean {
  const lowerUrl = baseUrl?.toLowerCase() || '';
  return lowerUrl.includes('openrouter');
}

export async function* streamOpenAIReply(
  agent: Agent,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  messages: Message[],
  allAgents: Agent[],
  visibilityMode: 'OPEN' | 'BLIND',
  contextLimit: number,
  scenario: string,
  summary?: string,
  adminNotes?: string[],
  userName?: string,
  userPersona?: string,
  hasSearchTool?: boolean,
  groupAdminIds?: string[],
  entertainmentConfig?: EntertainmentConfig,
  agentVisibility?: Record<string, string[]>,
  humanDisguise?: string[],
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>
): AsyncGenerator<StreamChunk> {
  
  if (!apiKey || !baseUrl) throw new Error("Missing Config");

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

  // 3. Find Last Action
  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage 
    ? `Recall that your LAST message was: "${myLastMessage.text.substring(0, 100)}...".` 
    : "";

  // 4. Build Group Member List
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

  // System Prompt Injection
  const systemInstruction = `
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

  const formattedMessages = [
    { role: 'system', content: systemInstruction },
    ...visibleMessages.map(m => {
       // Search results: inject as labeled context, not as a chat message
       if (m.isSearchResult) {
         const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
         return { role: 'user' as const, content: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` };
       }

       const senderName = m.senderId === USER_ID ? (userName || "User") : (m.senderId === 'SYSTEM' || m.isSystem ? "System" : allAgents.find(a => a.id === m.senderId)?.name || "Unknown");

       const timeStr = formatMessageTime(m.timestamp);
       const pmLabel = m.pmTargetId ? ' [PM]' : '';
       const isAI = !m.isSystem && m.senderId !== USER_ID && m.senderId !== 'SYSTEM' && m.senderId !== 'narrator';
       const displayText = isAI ? `{{RESPONSE: ${m.text}}}` : m.text;
       let textContent = `[${timeStr}] [ID: ${m.id}]${pmLabel} ${senderName}: ${displayText}`;
       
       // Handle Quote/Reply
       if (m.replyToId) {
          const replyTarget = messages.find(msg => msg.id === m.replyToId);
          if (replyTarget) {
              textContent = `[Replying to: "${replyTarget.text.substring(0, 50)}..."]\n${textContent}`;
          }
       }

       // Handle Document Attachments (multiple)
       if (m.attachments) {
         m.attachments.filter(att => att.type === 'document' && att.textContent).forEach((att, idx) => {
           textContent += `\n\n[Attached File ${idx + 1}: ${att.fileName}]\n${att.textContent}\n[End of File]`;
         });
       }

       // Handle Multimodal (Images - multiple)
       const imageAttachments = m.attachments?.filter(att => att.type === 'image') || [];
       if (imageAttachments.length > 0) {
         const contentParts: any[] = [{ type: "text", text: textContent }];
         imageAttachments.forEach(att => {
           contentParts.push({
             type: "image_url",
             image_url: { url: att.content } // data:image/png;base64,...
           });
         });
         return { role: 'user', content: contentParts };
       }

       return { role: 'user', content: textContent };
    }),
    { role: 'user', content: `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.` }
  ];

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Build request body with correct token parameter based on model
      const isNewModel = useMaxCompletionTokens(modelId);
      const isOpenAIReasoningModel = /^o[134](-|$)/.test(modelId.toLowerCase());
      const isDeepSeek = isDeepSeekModel(modelId, baseUrl);
      const isDeepSeekThinking = isDeepSeek && agent.config.enableReasoning;

      const requestBody: any = {
        model: modelId,
        messages: formattedMessages,
        stream: true,
        stream_options: { include_usage: true },
      };

      // o1/o3/o4 and DeepSeek thinking mode don't support temperature/top_p
      if (!isOpenAIReasoningModel && !isDeepSeekThinking) {
        if (agent.config.temperature !== null) requestBody.temperature = agent.config.temperature;
        if (agent.config.topP !== null) requestBody.top_p = agent.config.topP;
      }

      // Use max_completion_tokens for newer models (o1, o3, gpt-4.5+)
      if (isNewModel) {
        requestBody.max_completion_tokens = agent.config.maxTokens;
      } else {
        requestBody.max_tokens = agent.config.maxTokens;
      }

      // Add reasoning_effort for o-series reasoning models
      if (isOpenAIReasoningModel && agent.config.enableReasoning) {
        const effort = agent.config.effort;
        if (effort === 'low' || effort === 'medium' || effort === 'high') {
          requestBody.reasoning_effort = effort;
        } else {
          requestBody.reasoning_effort = mapBudgetToEffort(agent.config.reasoningBudget || 8000);
        }
      }

      // Add thinking/reasoning parameter for DeepSeek models when reasoning is enabled
      if (isDeepSeekThinking) {
        const isOpenRouter = isOpenRouterAPI(baseUrl);
        if (isOpenRouter) {
          // OpenRouter uses "reasoning" parameter
          requestBody.reasoning = { enabled: true };
          console.log(`[OpenAI] 🧠 DeepSeek thinking mode enabled via OpenRouter for ${modelId}`);
        } else {
          // DeepSeek official API uses "thinking" parameter
          requestBody.thinking = { type: "enabled" };
          console.log(`[OpenAI] 🧠 DeepSeek thinking mode enabled for ${modelId}`);
        }
      }

      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      console.log(`[OpenAI] 📡 Response received: status=${response.status}`);

      // Handle Rate Limits and Server Errors
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
            if (attempt < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(`[OpenAI] ⚠️ API Error ${response.status}. Retrying in ${delay}ms...`);
                await wait(delay);
                continue;
            }
        }
        // Try to get error details from response body
        let errorDetail = response.statusText;
        try {
            const errBody = await response.json();
            errorDetail = errBody.error?.message || errBody.message || JSON.stringify(errBody);
        } catch { /* ignore parse error */ }
        console.error(`[OpenAI] ❌ API Error: ${response.status} - ${errorDetail}`);
        throw new Error(`API ${response.status}: ${errorDetail}`);
      }

      if (!response.body) throw new Error("No response body");

      console.log(`[OpenAI] ✅ Connection established, starting stream...`);
      // Success, break retry loop
      break;

    } catch (error: any) {
        const isHttpError = error.message?.startsWith('API ');
        if (!isHttpError && attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`[OpenAI] ⚠️ Network Error: ${error.message}. Retrying in ${delay}ms...`);
            await wait(delay);
            continue;
        }
        console.error("[OpenAI] ❌ Error (max retries reached or non-retryable):", error.message);
        throw error;
    }
  }

  if (!response || !response.body) {
    throw new Error("No response received from OpenAI API");
  }

  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let capturedUsage = { input: 0, output: 0 };

    // State for parsing raw <think> tags in content
    let insideThinkTag = false;
    let receivedDone = false;
    let hasReceivedContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) continue;
        
        const dataStr = trimmed.slice(6);
        if (dataStr === "[DONE]") {
          receivedDone = true;
          continue;
        }

        try {
          const json = JSON.parse(dataStr);

          // Check for error in stream (some APIs return 200 with error in body)
          if (json.error) {
            const errMsg = json.error.message || json.error.code || JSON.stringify(json.error);
            console.error("[OpenAI Stream] Error in response:", errMsg);
            throw new Error(errMsg);
          }

          const delta = json.choices?.[0]?.delta;

          if (delta) {
             // 1. Explicit Reasoning Content (multiple formats)
             // - DeepSeek official API: delta.reasoning_content
             // - OpenRouter: delta.reasoning or delta.reasoning_details
             if (delta.reasoning_content) {
                 yield { reasoning: delta.reasoning_content, isComplete: false };
             } else if (delta.reasoning) {
                 // OpenRouter format
                 yield { reasoning: delta.reasoning, isComplete: false };
             } else if (delta.reasoning_details && Array.isArray(delta.reasoning_details)) {
                 // OpenRouter detailed format
                 for (const detail of delta.reasoning_details) {
                     if (detail.text) {
                         yield { reasoning: detail.text, isComplete: false };
                     } else if (detail.summary) {
                         yield { reasoning: detail.summary, isComplete: false };
                     }
                 }
             }

             // 2. Standard Content (check for <think> tags if not using dedicated field)
             if (delta.content) {
                let text = delta.content;

                // Very basic streaming parser for <think>...</think>
                if (text.includes('<think>')) {
                    insideThinkTag = true;
                    text = text.replace('<think>', '');
                }

                if (text.includes('</think>')) {
                    const parts = text.split('</think>');
                    if (parts[0]) yield { reasoning: parts[0], isComplete: false };
                    insideThinkTag = false;
                    if (parts[1]) yield { text: parts[1], isComplete: false };
                    continue;
                }

                if (insideThinkTag) {
                    yield { reasoning: text, isComplete: false };
                } else {
                    hasReceivedContent = true;
                    yield { text: text, isComplete: false };
                }
             }
          }

          if (json.usage) {
            capturedUsage = {
              input: json.usage.prompt_tokens || 0,
              output: json.usage.completion_tokens || 0
            };
          }
        } catch (e: any) {
          // Re-throw actual errors, only ignore JSON parse errors for malformed chunks
          if (e.message && !e.message.includes('JSON')) {
            throw e;
          }
          // Log unexpected parse issues for debugging
          if (dataStr.length > 10) {
            console.warn("[OpenAI Stream] Parse issue on chunk:", dataStr.substring(0, 200));
          }
        }
      }
    }

    // Stream ended without [DONE] - this is an abnormal termination
    if (!receivedDone && hasReceivedContent) {
      console.warn("[OpenAI] ⚠️ Stream ended without [DONE] - connection may have been interrupted");
      throw new Error("连接中断：响应未完成");
    }

    console.log(`[OpenAI] ✅ Stream finished normally (usage: ${capturedUsage.input}/${capturedUsage.output} tokens)`);
    yield { isComplete: true, usage: capturedUsage };

  } catch (error: any) {
    console.error("[OpenAI] ❌ Stream Reading Error:", error.message);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
