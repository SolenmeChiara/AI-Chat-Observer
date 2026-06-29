
import { Agent, Message, StreamChunk, AgentRole, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';

// Detect actual image format from base64 data (magic bytes)
function detectImageFormat(base64Data: string): string {
  // Check first few characters of base64 which encode magic bytes
  if (base64Data.startsWith('iVBOR')) return 'image/png';      // PNG: 89 50 4E 47
  if (base64Data.startsWith('/9j/')) return 'image/jpeg';      // JPEG: FF D8 FF
  if (base64Data.startsWith('R0lG')) return 'image/gif';       // GIF: 47 49 46 38
  if (base64Data.startsWith('UklGR')) return 'image/webp';     // WebP: 52 49 46 46 ... 57 45 42 50
  // Fallback
  return 'image/png';
}

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

export async function* streamAnthropicReply(
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
  const effectiveMessages = messages
    .filter(m => !m.isStreaming)  // 过滤掉正在生成中的占位符消息
    .slice(-Math.max(2, contextLimit));

  // 2. Join-time filtering: hide messages before agent's join point
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
    ? `You previously said: "${myLastMessage.text.substring(0, 100)}...".` 
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

  // 6. System Prompt Injection
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
${adminProtocol}${searchToolProtocol}${entertainmentProtocol}${pmProtocol}
  `;

  // Anthropic Format Prep
  const formattedMessages: any[] = [];

  // Thinking mode: always enable if configured. Messages without thinking data are
  // downgraded to user-role notes so they don't break Anthropic's thinking block requirement.
  const shouldEnableThinking = !!agent.config.enableReasoning;

  for (const m of visibleMessages) {
    const isSelf = m.senderId === agent.id;
    const hasThinking = !!(m.reasoningText && m.reasoningSignature);

    // For own messages without thinking data (PM or old messages from when thinking was disabled):
    // Convert to user-role recall note instead of assistant, to avoid breaking thinking mode
    if (isSelf && shouldEnableThinking && !hasThinking) {
      const pmNote = m.pmTargetId
        ? ` (私讯→${m.pmTargetId === USER_ID ? (userName || 'User') : (allAgents.find(a => a.id === m.pmTargetId)?.name || '未知')})`
        : '';
      const recallText = `[你之前说过${pmNote}: ${m.text}]`;
      const recallBlock = [{ type: "text", text: recallText }];
      if (formattedMessages.length > 0 && formattedMessages[formattedMessages.length - 1].role === 'user') {
        (formattedMessages[formattedMessages.length - 1].content as any[]).push(...recallBlock);
      } else {
        formattedMessages.push({ role: 'user', content: recallBlock });
      }
      continue;
    }

    // Search results should appear as system context, not as the agent's own speech
    if (m.isSearchResult) {
      const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
      const block = [{ type: "text", text: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` }];
      if (formattedMessages.length > 0 && formattedMessages[formattedMessages.length - 1].role === 'user') {
        (formattedMessages[formattedMessages.length - 1].content as any[]).push(...block);
      } else {
        formattedMessages.push({ role: 'user', content: block });
      }
      continue;
    }

    const senderName = m.senderId === USER_ID ? (userName || "User") : (m.senderId === 'SYSTEM' || m.isSystem ? "System" : allAgents.find(a => a.id === m.senderId)?.name || "Unknown");

    const timeStr = formatMessageTime(m.timestamp);
    const pmLabel = m.pmTargetId ? ' [PM]' : '';
    const isAI = !m.isSystem && m.senderId !== USER_ID && m.senderId !== 'SYSTEM' && m.senderId !== 'narrator';
    const wrappedText = isAI ? `{{RESPONSE: ${m.text}}}` : m.text;
    let textContent = isSelf ? wrappedText : `[${timeStr}] [ID: ${m.id}]${pmLabel} ${senderName}: ${wrappedText}`;

    // Handle Reply Reference
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

    const role = isSelf ? 'assistant' : 'user';

    // Build Content Block (Text + Images)
    const contentBlocks: any[] = [];

    // For assistant messages when thinking is enabled: add thinking block FIRST (required by Anthropic)
    if (isSelf && shouldEnableThinking && hasThinking) {
      contentBlocks.push({
        type: "thinking",
        thinking: m.reasoningText,
        signature: m.reasoningSignature
      });
    }

    // Images First (Anthropic best practice often puts images first) - multiple supported
    if (m.attachments) {
      m.attachments.filter(att => att.type === 'image').forEach(att => {
        // Extract base64 data from data URL
        const dataUrlMatch = att.content.match(/^data:[^;]+;base64,(.+)$/);
        if (dataUrlMatch) {
          const base64Data = dataUrlMatch[1];
          // Detect actual image format from magic bytes (more reliable than URL header)
          const actualMediaType = detectImageFormat(base64Data);
          contentBlocks.push({
            type: "image",
            source: {
              type: "base64",
              media_type: actualMediaType,
              data: base64Data
            }
          });
        }
      });
    }

    // Only push text block if content is non-empty (Anthropic requires non-empty text)
    if (textContent && textContent.trim()) {
      contentBlocks.push({ type: "text", text: textContent });
    }

    // Skip if no content blocks at all
    if (contentBlocks.length === 0) continue;

    // Merge consecutive messages
    if (formattedMessages.length > 0 && formattedMessages[formattedMessages.length - 1].role === role) {
      const prevMsg = formattedMessages[formattedMessages.length - 1];
      if (typeof prevMsg.content === 'string') {
        prevMsg.content = [{ type: 'text', text: prevMsg.content }];
      }
      prevMsg.content.push(...contentBlocks);
    } else {
      formattedMessages.push({ role, content: contentBlocks });
    }
  }

  // Add end-of-log format reminder as the last thing the model sees
  const endOfLogBlock = { type: "text", text: `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.` };
  if (formattedMessages.length > 0 && formattedMessages[formattedMessages.length - 1].role === 'user') {
    const lastMsg = formattedMessages[formattedMessages.length - 1];
    if (typeof lastMsg.content === 'string') {
      lastMsg.content = [{ type: 'text', text: lastMsg.content }, endOfLogBlock];
    } else {
      lastMsg.content.push(endOfLogBlock);
    }
  } else {
    formattedMessages.push({ role: 'user', content: [endOfLogBlock] });
  }

  // Ensure first message is user
  if (formattedMessages.length > 0 && formattedMessages[0].role === 'assistant') {
    formattedMessages.unshift({ role: 'user', content: '[System: Conversation Continued]' });
  }

  // Handle Reasoning Configuration
  let thinkingConfig: any = undefined;
  let outputConfig: any = undefined;
  let temperatureConfig = agent.config.temperature;
  let maxTokensConfig = agent.config.maxTokens;

  if (shouldEnableThinking) {
      temperatureConfig = 1.0;

      const useAdaptive = agent.config.reasoningMode === 'adaptive';

      if (useAdaptive) {
          thinkingConfig = { type: "adaptive" };
          if (agent.config.effort) {
              outputConfig = { effort: agent.config.effort };
          }
      } else {
          thinkingConfig = {
              type: "enabled",
              budget_tokens: agent.config.reasoningBudget || 2048
          };
          if (maxTokensConfig <= (thinkingConfig.budget_tokens || 0)) {
              maxTokensConfig = (thinkingConfig.budget_tokens || 2048) + 1024;
          }
      }
  }

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
        const body: any = {
            model: modelId,
            max_tokens: maxTokensConfig,
            system: systemInstruction,
            messages: formattedMessages,
            stream: true
        };

        if (thinkingConfig) {
            body.thinking = thinkingConfig;
        } else {
            if (temperatureConfig !== null) body.temperature = temperatureConfig;
            if (agent.config.topP !== null) body.top_p = agent.config.topP;
        }
        if (outputConfig) {
            body.output_config = outputConfig;
        }

        response = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true'
            },
            body: JSON.stringify(body)
        });

        console.log(`[Anthropic] 📡 Response received: status=${response.status}`);

        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_RETRIES) {
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`[Anthropic] ⚠️ API Error ${response.status}. Retrying in ${delay}ms...`);
                    await wait(delay);
                    continue;
                }
            }
            // Try to get structured error message
            const statusText = response.statusText;
            const statusCode = response.status;
            let errorDetail = statusText;
            try {
                const errBody = await response.json();
                errorDetail = errBody.error?.message || errBody.message || JSON.stringify(errBody);
            } catch {
                errorDetail = await response.text().catch(() => statusText);
            }
            console.error(`[Anthropic] ❌ API Error: ${statusCode} - ${errorDetail}`);
            throw new Error(`Anthropic ${statusCode}: ${errorDetail}`);
        }
        if (!response.body) throw new Error("No response body");

        console.log(`[Anthropic] ✅ Connection established, starting stream...`);
        break;
    } catch (error: any) {
        const isHttpError = error.message?.startsWith('Anthropic ');
        if (!isHttpError && attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`[Anthropic] ⚠️ Network Error: ${error.message}. Retrying in ${delay}ms...`);
            await wait(delay);
            continue;
        }
        console.error("[Anthropic] ❌ Error (max retries reached or non-retryable):", error.message);
        throw error;
    }
  }

  if (!response || !response.body) {
    throw new Error("No response received from Anthropic API");
  }

  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let capturedUsage = { input: 0, output: 0 };
    let capturedSignature: string | undefined;
    let receivedMessageStop = false;
    let hasReceivedContent = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("event: ") && !trimmed.startsWith("data: ")) continue;

        if (line.startsWith("data: ")) {
            const dataStr = line.slice(6);
            try {
                const json = JSON.parse(dataStr);

                // Capture usage from message_start
                if (json.type === 'message_start' && json.message?.usage) {
                    capturedUsage.input = json.message.usage.input_tokens || 0;
                }

                // Parsing Content vs Thinking Delta
                if (json.type === 'content_block_delta') {
                    if (json.delta?.type === 'text_delta' && json.delta.text) {
                        hasReceivedContent = true;
                        yield { text: json.delta.text, isComplete: false };
                    }
                    if (json.delta?.type === 'thinking_delta' && json.delta.thinking) {
                        hasReceivedContent = true;
                        yield { reasoning: json.delta.thinking, isComplete: false };
                    }
                    // Capture signature delta (Anthropic streams signature in thinking block)
                    if (json.delta?.type === 'signature_delta' && json.delta.signature) {
                        capturedSignature = (capturedSignature || '') + json.delta.signature;
                    }
                }

                // Capture signature from content_block_stop (alternative location)
                if (json.type === 'content_block_stop' && json.content_block?.signature) {
                    capturedSignature = json.content_block.signature;
                }

                // Capture output usage from message_delta
                if (json.type === 'message_delta' && json.usage) {
                    capturedUsage.output = json.usage.output_tokens || 0;
                }

                if (json.type === 'message_stop') {
                    receivedMessageStop = true;
                    yield { isComplete: true, usage: capturedUsage, reasoningSignature: capturedSignature };
                    return;
                }
            } catch (e) {
                // ignore
            }
        }
      }
    }

    // Stream ended without message_stop - this is an abnormal termination
    if (!receivedMessageStop && hasReceivedContent) {
      console.warn("[Anthropic] ⚠️ Stream ended without message_stop - connection may have been interrupted");
      throw new Error("连接中断：响应未完成");
    }

    console.log(`[Anthropic] ✅ Stream finished normally (usage: ${capturedUsage.input}/${capturedUsage.output} tokens)`);
    yield { isComplete: true, usage: capturedUsage, reasoningSignature: capturedSignature };

  } catch (error: any) {
    console.error("[Anthropic] ❌ Stream Reading Error:", error.message);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
