
import { Agent, Message, StreamChunk, AgentRole } from '../types';
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

  // o1/o3 series (reasoning models)
  if (/^o[13](-|$)/.test(lowerModel)) return true;

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
    ? `Recall that your LAST message was: "${myLastMessage.text.substring(0, 100)}...".` 
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

  // System Prompt Injection
  const systemInstruction = `
    [GLOBAL SCENARIO]
    ${scenario || "A general group chat environment."}

    ${memoryContext}

    [SYSTEM INFO]
    Time: ${new Date().toLocaleString()}
    
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
    - Be yourself. Do not copy others' style.
    - Avoid emojis unless necessary.
    - Pay attention to the latest messages.
    - ${myLastActionContext}

    ${attentionInstruction}

    [FINAL DECISION - READ CAREFULLY]
    After considering all the above, you MUST output in ONE of these formats:

    1. To SPEAK: {{RESPONSE: your message here}}
       Example: {{RESPONSE: 这个观点很有意思，我觉得...}}

    2. To STAY SILENT: {{PASS}}

    ⚠️ REMEMBER: Anything not wrapped in {{RESPONSE: ...}} will be silently discarded!
  `;

  const formattedMessages = [
    { role: 'system', content: systemInstruction },
    ...visibleMessages.map(m => {
       const senderName = m.senderId === USER_ID ? (userName || "User") : (m.isSystem ? "SYSTEM" : allAgents.find(a => a.id === m.senderId)?.name || "Bot");
       
       // INJECT ID AND TIMESTAMP INTO CONTENT
       const timeStr = formatMessageTime(m.timestamp);
       let textContent = `[${timeStr}] [ID: ${m.id}] ${senderName}: ${m.text}`;
       
       // Handle Quote/Reply
       if (m.replyToId) {
          const replyTarget = messages.find(msg => msg.id === m.replyToId);
          if (replyTarget) {
              textContent = `[Replying to: "${replyTarget.text.substring(0, 50)}..."]\n${textContent}`;
          }
       }

       // Handle Document Attachment (Text Injection)
       if (m.attachment && m.attachment.type === 'document' && m.attachment.textContent) {
           textContent += `\n\n[Attached File: ${m.attachment.fileName}]\n${m.attachment.textContent}\n[End of File]`;
       }

       // Handle Multimodal (Image)
       if (m.attachment && m.attachment.type === 'image') {
         return {
           role: 'user',
           content: [
             { type: "text", text: textContent },
             { 
               type: "image_url", 
               image_url: { url: m.attachment.content } // data:image/png;base64,...
             }
           ]
         };
       }

       return { role: 'user', content: textContent };
    })
  ];

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Build request body with correct token parameter based on model
      const isNewModel = useMaxCompletionTokens(modelId);
      const isReasoningModel = /^o[13](-|$)/.test(modelId.toLowerCase());

      const requestBody: any = {
        model: modelId,
        messages: formattedMessages,
        stream: true,
        stream_options: { include_usage: true },
      };

      // o1/o3 reasoning models don't support temperature (fixed at 1.0)
      if (!isReasoningModel) {
        requestBody.temperature = agent.config.temperature;
      }

      // Use max_completion_tokens for newer models (o1, o3, gpt-4.5+)
      if (isNewModel) {
        requestBody.max_completion_tokens = agent.config.maxTokens;
      } else {
        requestBody.max_tokens = agent.config.maxTokens;
      }

      // Add reasoning_effort for o1/o3 models when reasoning is enabled
      if (isReasoningModel && agent.config.enableReasoning) {
        requestBody.reasoning_effort = mapBudgetToEffort(agent.config.reasoningBudget || 8000);
      }

      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      // Handle Rate Limits and Server Errors
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
            if (attempt < MAX_RETRIES) {
                const delay = 1000 * Math.pow(2, attempt);
                console.warn(`OpenAI API Error ${response.status}. Retrying in ${delay}ms...`);
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
        throw new Error(`API ${response.status}: ${errorDetail}`);
      }
      
      if (!response.body) throw new Error("No response body");

      // Success, break retry loop
      break;

    } catch (error: any) {
        // Handle Network Errors (Fetch failed)
        if (attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`OpenAI Network/Retryable Error. Retrying in ${delay}ms...`);
            await wait(delay);
            continue;
        }
        console.error("OpenAI Stream Error", error);
        throw error;
    }
  }

  if (!response || !response.body) {
    throw new Error("No response received from OpenAI API");
  }

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let capturedUsage = { input: 0, output: 0 };

    // State for parsing raw <think> tags in content
    let insideThinkTag = false;

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
        if (dataStr === "[DONE]") continue;

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
             // 1. Explicit Reasoning Content (DeepSeek standard)
             if (delta.reasoning_content) {
                 yield { reasoning: delta.reasoning_content, isComplete: false };
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

    yield { isComplete: true, usage: capturedUsage };

  } catch (error) {
    console.error("OpenAI Stream Reading Error", error);
    throw error;
  }
}
