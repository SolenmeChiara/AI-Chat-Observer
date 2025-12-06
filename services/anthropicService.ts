
import { Agent, Message, StreamChunk, AgentRole } from '../types';
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
  groupAdminIds?: string[]
): AsyncGenerator<StreamChunk> {
  
  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // 1. Context Limit Slicing (exclude streaming placeholders - they're invisible to other AIs)
  const effectiveMessages = messages
    .filter(m => !m.isStreaming)  // 过滤掉正在生成中的占位符消息
    .slice(-Math.max(2, contextLimit));

  // 2. Visibility Logic
  const visibleMessages = effectiveMessages.filter(m => {
    if (m.isSystem) return true;
    if (m.senderId === USER_ID) return true;
    if (m.senderId === agent.id) return true;
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

  // 6. System Prompt Injection
  const systemInstruction = `
    [GLOBAL SCENARIO]
    ${scenario || "A general group chat environment."}

    ${memoryContext}

    [SYSTEM INFO]
    Date: ${new Date().toLocaleString()}

    You are participating in a group chat environment.
    
    Current Group Members:
    - ${userName || 'User'} (Human): ${userPersona || 'A human user'}
    ${memberList}

    Your Identity: ${agent.name}
    Your Role: ${agent.role}
    Your Persona: ${agent.systemPrompt}
    
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
    - IDENTITY CONFUSION WARNING: You may encounter others with similar names (e.g., another Claude bot).
      Do NOT assume every mention of "Claude" or similar names refers to you.
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
    - Think freely. Change topics if you wish.
    - Be strict about your personality. Don't blindly agree.
    - Minimal Emoji usage.
    - ${myLastActionContext}

    ${attentionInstruction}

    [FINAL DECISION - READ CAREFULLY]
    After considering all the above, you MUST output in ONE of these formats:

    1. To SPEAK: {{RESPONSE: your message here}}
       Example: {{RESPONSE: 这个观点很有意思，我觉得...}}

    2. To STAY SILENT: {{PASS}}

    ⚠️ REMEMBER: Anything not wrapped in {{RESPONSE: ...}} will be silently discarded!
  `;

  // Anthropic Format Prep
  const formattedMessages: any[] = [];
  
  for (const m of visibleMessages) {
    const isSelf = m.senderId === agent.id;
    const senderName = m.senderId === USER_ID ? (userName || "User") : (m.isSystem ? "SYSTEM" : allAgents.find(a => a.id === m.senderId)?.name || "Bot");
    
    // INJECT ID INTO CONTENT
    let textContent = isSelf ? m.text : `[ID: ${m.id}] ${senderName}: ${m.text}`;

    // Handle Reply Reference
    if (m.replyToId) {
        const replyTarget = messages.find(msg => msg.id === m.replyToId);
        if (replyTarget) {
            textContent = `[Replying to: "${replyTarget.text.substring(0, 50)}..."]\n${textContent}`;
        }
    }
    
    // Handle Document Attachment
    if (m.attachment && m.attachment.type === 'document' && m.attachment.textContent) {
        textContent += `\n\n[Attached File: ${m.attachment.fileName}]\n${m.attachment.textContent}\n[End of File]`;
    }

    const role = isSelf ? 'assistant' : 'user';

    // Build Content Block (Text + Image)
    const contentBlocks: any[] = [];

    // For assistant messages when thinking is enabled: add thinking block FIRST (required by Anthropic)
    // Must include signature if available (required for multi-turn conversations)
    if (isSelf && agent.config.enableReasoning && m.reasoningText && m.reasoningSignature) {
      contentBlocks.push({
        type: "thinking",
        thinking: m.reasoningText,
        signature: m.reasoningSignature
      });
    }

    // Image First (Anthropic best practice often puts image first)
    if (m.attachment && m.attachment.type === 'image') {
        // Extract base64 data from data URL
        const dataUrlMatch = m.attachment.content.match(/^data:[^;]+;base64,(.+)$/);
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

  // Ensure first message is user
  if (formattedMessages.length > 0 && formattedMessages[0].role === 'assistant') {
    formattedMessages.unshift({ role: 'user', content: '[System: Conversation Continued]' });
  }

  // Handle Reasoning Configuration for Claude 3.7
  let thinkingConfig = undefined;
  let temperatureConfig = agent.config.temperature;
  let maxTokensConfig = agent.config.maxTokens;

  // Check if all assistant messages with reasoningText have signatures
  // If any is missing, we cannot safely enable thinking mode
  const hasIncompleteThinking = visibleMessages.some(m =>
    m.senderId === agent.id && m.reasoningText && !m.reasoningSignature
  );

  if (agent.config.enableReasoning && !hasIncompleteThinking) {
      // Claude 3.7 Thinking mode requires temperature to be 1.0 (or not sent, defaulting to 1)
      temperatureConfig = 1.0;

      thinkingConfig = {
          type: "enabled",
          budget_tokens: agent.config.reasoningBudget || 2048
      };

      // Safety: max_tokens must be > budget_tokens
      if (maxTokensConfig <= (thinkingConfig.budget_tokens || 0)) {
          maxTokensConfig = (thinkingConfig.budget_tokens || 2048) + 1024;
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
            // Do not send temperature if thinking is enabled, or send 1.0
            // body.temperature = 1.0; 
        } else {
            body.temperature = temperatureConfig;
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

        if (!response.ok) {
            if (response.status === 429 || response.status >= 500) {
                if (attempt < MAX_RETRIES) {
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`Anthropic API Error ${response.status}. Retrying in ${delay}ms...`);
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
            throw new Error(`Anthropic ${statusCode}: ${errorDetail}`);
        }
        if (!response.body) throw new Error("No response body");

        break;
    } catch (error: any) {
        if (attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`Anthropic Network/Retryable Error. Retrying in ${delay}ms...`);
            await wait(delay);
            continue;
        }
        console.error("Anthropic Stream Error", error);
        throw error;
    }
  }

  if (!response || !response.body) {
    throw new Error("No response received from Anthropic API");
  }

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let capturedUsage = { input: 0, output: 0 };
    let capturedSignature: string | undefined;

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
                        yield { text: json.delta.text, isComplete: false };
                    }
                    if (json.delta?.type === 'thinking_delta' && json.delta.thinking) {
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
                    yield { isComplete: true, usage: capturedUsage, reasoningSignature: capturedSignature };
                    return;
                }
            } catch (e) {
                // ignore
            }
        }
      }
    }

    yield { isComplete: true, usage: capturedUsage, reasoningSignature: capturedSignature };

  } catch (error) {
    console.error("Anthropic Stream Reading Error", error);
    throw error;
  }
}
