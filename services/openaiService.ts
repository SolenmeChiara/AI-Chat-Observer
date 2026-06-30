
import { Agent, Message, StreamChunk, AgentRole, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';
import {
  formatMessageTime,
  buildMemberList,
  buildAttentionInstruction,
  buildProtocols,
  buildSystemPrompt,
  buildMemoryContext,
  filterVisibleMessages,
  formatMessageText,
  appendDocumentAttachments
} from './shared';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  mentionOnlyIds?: string[],
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // 1-3. Filter messages by visibility rules
  const visibleMessages = filterVisibleMessages(
    messages, agent, visibilityMode, contextLimit,
    agentVisibility, agentJoinedAt, hidePreJoinMessages
  );

  // 3. Find Last Action
  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage
    ? `Recall that your LAST message was: "${myLastMessage.text.substring(0, 100)}...".`
    : "";

  // 4. Build Group Member List
  const memberList = buildMemberList(allAgents, agent, groupAdminIds, humanDisguise, mentionOnlyIds);

  // 5. Attention / Addressing Logic
  const attentionInstruction = buildAttentionInstruction(visibleMessages, agent, allAgents);

  // 6-8. Build Protocols (Admin, Search, Entertainment, PM, Split)
  const protocols = buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName);

  // Memory Context
  const memoryContext = buildMemoryContext(summary, adminNotes);

  // System Prompt Injection
  const systemInstruction = buildSystemPrompt(
    scenario, memoryContext, agent, memberList,
    userName, userPersona, myLastActionContext,
    attentionInstruction, protocols
  );

  const formattedMessages = [
    { role: 'system', content: systemInstruction },
    ...visibleMessages.map(m => {
       // Search results: inject as labeled context, not as a chat message
       if (m.isSearchResult) {
         const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
         return { role: 'user' as const, content: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` };
       }

       // OpenAI: all messages get timestamp (addTimestampToSelf=true)
       let textContent = formatMessageText(m, agent, allAgents, userName, false, true);

       // Handle Quote/Reply
       if (m.replyToId) {
          const replyTarget = messages.find(msg => msg.id === m.replyToId);
          if (replyTarget) {
              textContent = `[Replying to: "${replyTarget.text.substring(0, 50)}..."]\n${textContent}`;
          }
       }

       // Handle Document Attachments (multiple)
       textContent = appendDocumentAttachments(textContent, m);

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

      // Add reasoning_effort for o-series reasoning models (Chat Completions supports low/medium/high)
      if (isOpenAIReasoningModel && agent.config.enableReasoning) {
        const effort = agent.config.effort;
        if (effort === 'low' || effort === 'medium' || effort === 'high') {
          requestBody.reasoning_effort = effort;
        } else if (effort === 'none' || effort === 'minimal') {
          requestBody.reasoning_effort = 'low';
        } else if (effort === 'xhigh' || effort === 'max') {
          requestBody.reasoning_effort = 'high';
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

// ============================================================================
// OpenAI Responses API (POST /v1/responses)
// ============================================================================

export async function* streamOpenAIResponsesReply(
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
  mentionOnlyIds?: string[],
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  const visibleMessages = filterVisibleMessages(
    messages, agent, visibilityMode, contextLimit,
    agentVisibility, agentJoinedAt, hidePreJoinMessages
  );

  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage
    ? `Recall that your LAST message was: "${myLastMessage.text.substring(0, 100)}...".`
    : "";

  const memberList = buildMemberList(allAgents, agent, groupAdminIds, humanDisguise, mentionOnlyIds);
  const attentionInstruction = buildAttentionInstruction(visibleMessages, agent, allAgents);
  const protocols = buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName);
  const memoryContext = buildMemoryContext(summary, adminNotes);
  const systemInstruction = buildSystemPrompt(
    scenario, memoryContext, agent, memberList,
    userName, userPersona, myLastActionContext,
    attentionInstruction, protocols
  );

  // Build input items (Responses API accepts messages-style input)
  const inputItems: any[] = visibleMessages.map(m => {
    if (m.isSearchResult) {
      const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
      return { role: 'user', content: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` };
    }

    let textContent = formatMessageText(m, agent, allAgents, userName, false, true);

    if (m.replyToId) {
      const replyTarget = messages.find(msg => msg.id === m.replyToId);
      if (replyTarget) {
        textContent = `[Replying to: "${replyTarget.text.substring(0, 50)}..."]\n${textContent}`;
      }
    }

    textContent = appendDocumentAttachments(textContent, m);

    const imageAttachments = m.attachments?.filter(att => att.type === 'image') || [];
    if (imageAttachments.length > 0) {
      const contentParts: any[] = [{ type: "input_text", text: textContent }];
      imageAttachments.forEach(att => {
        contentParts.push({
          type: "input_image",
          image_url: att.content
        });
      });
      return { role: 'user', content: contentParts };
    }

    return { role: 'user', content: textContent };
  });

  inputItems.push({
    role: 'user',
    content: `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.`
  });

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const requestBody: any = {
        model: modelId,
        instructions: systemInstruction,
        input: inputItems,
        stream: true,
        store: false,
      };

      if (agent.config.maxTokens) {
        requestBody.max_output_tokens = agent.config.maxTokens;
      }

      // Reasoning config: Responses API supports reasoning on any model (not just o-series)
      if (agent.config.enableReasoning) {
        const effort = agent.config.effort || 'medium';
        const reasoning: any = { effort, summary: 'auto' };
        requestBody.reasoning = reasoning;
      } else {
        if (agent.config.temperature !== null) requestBody.temperature = agent.config.temperature;
        if (agent.config.topP !== null) requestBody.top_p = agent.config.topP;
      }

      // Derive endpoint: replace /chat/completions or /v1/chat/completions with /responses
      let endpoint = baseUrl;
      if (endpoint.endsWith('/chat/completions')) {
        endpoint = endpoint.replace(/\/chat\/completions$/, '/responses');
      } else if (endpoint.endsWith('/v1')) {
        endpoint += '/responses';
      } else {
        endpoint = endpoint.replace(/\/?$/, '/responses');
      }

      console.log(`[OpenAI Responses] 📡 POST ${endpoint}`);

      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) {
          if (attempt < MAX_RETRIES) {
            const delay = 1000 * Math.pow(2, attempt);
            console.warn(`[OpenAI Responses] ⚠️ API Error ${response.status}. Retrying in ${delay}ms...`);
            await wait(delay);
            continue;
          }
        }
        let errorDetail = response.statusText;
        try {
          const errBody = await response.json();
          errorDetail = errBody.error?.message || errBody.message || JSON.stringify(errBody);
        } catch { /* ignore */ }
        console.error(`[OpenAI Responses] ❌ API Error: ${response.status} - ${errorDetail}`);
        throw new Error(`API ${response.status}: ${errorDetail}`);
      }

      if (!response.body) throw new Error("No response body");
      console.log(`[OpenAI Responses] ✅ Connection established, starting stream...`);
      break;

    } catch (error: any) {
      const isHttpError = error.message?.startsWith('API ');
      if (!isHttpError && attempt < MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        console.warn(`[OpenAI Responses] ⚠️ Network Error: ${error.message}. Retrying in ${delay}ms...`);
        await wait(delay);
        continue;
      }
      throw error;
    }
  }

  if (!response || !response.body) {
    throw new Error("No response received from OpenAI Responses API");
  }

  // Parse typed SSE events from Responses API
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let capturedUsage = { input: 0, output: 0 };
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

        // Responses API uses "event: <type>\ndata: <json>" format
        if (trimmed.startsWith("event: ")) continue; // event type line, data follows

        const dataStr = trimmed.slice(6);
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const json = JSON.parse(dataStr);
          const eventType = json.type;

          if (json.error || eventType === 'error' || eventType === 'response.failed') {
            const errMsg = json.error?.message || json.message || JSON.stringify(json);
            console.error("[OpenAI Responses] Error in stream:", errMsg);
            throw new Error(errMsg);
          }

          // Text content delta
          if (eventType === 'response.output_text.delta') {
            const text = json.delta;
            if (text) {
              hasReceivedContent = true;
              yield { text, isComplete: false };
            }
          }

          // Reasoning summary delta
          if (eventType === 'response.reasoning_summary_text.delta') {
            const text = json.delta;
            if (text) {
              yield { reasoning: text, isComplete: false };
            }
          }

          // Response completed
          if (eventType === 'response.completed') {
            const usage = json.response?.usage;
            if (usage) {
              capturedUsage = {
                input: usage.input_tokens || 0,
                output: usage.output_tokens || 0
              };
            }
          }

        } catch (e: any) {
          if (e.message && !e.message.includes('JSON')) throw e;
          if (dataStr.length > 10) {
            console.warn("[OpenAI Responses] Parse issue:", dataStr.substring(0, 200));
          }
        }
      }
    }

    console.log(`[OpenAI Responses] ✅ Stream finished (usage: ${capturedUsage.input}/${capturedUsage.output} tokens)`);
    yield { isComplete: true, usage: capturedUsage };

  } catch (error: any) {
    console.error("[OpenAI Responses] ❌ Stream Error:", error.message);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// ============================================================================
// OpenAI Image Generation (POST /v1/images/generations)
// Standalone image generation agent — no {{RESPONSE:}} parsing needed
// ============================================================================

export function isImageGenModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes('gpt-image') || lower.includes('dall-e') || lower.includes('dalle');
}

export async function* streamImageGeneration(
  agent: Agent,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  prompt: string,
  size?: string,
  quality?: string
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // Derive image API endpoint from base URL
  let endpoint = baseUrl;
  if (endpoint.endsWith('/chat/completions')) {
    endpoint = endpoint.replace(/\/chat\/completions$/, '/images/generations');
  } else if (endpoint.endsWith('/responses')) {
    endpoint = endpoint.replace(/\/responses$/, '/images/generations');
  } else if (endpoint.endsWith('/v1')) {
    endpoint += '/images/generations';
  } else {
    endpoint = endpoint.replace(/\/?$/, '/images/generations');
  }

  console.log(`[ImageGen] 🎨 Generating image with ${modelId}: "${prompt.substring(0, 100)}..."`);
  yield { reasoning: `Generating: ${prompt}`, isComplete: false };

  const isGptImage = /gpt-image/i.test(modelId);
  const requestBody: any = {
    model: modelId,
    prompt: prompt,
    n: 1,
    ...(isGptImage ? { output_format: 'png' } : { response_format: 'b64_json' }),
  };

  if (size && size !== 'auto') requestBody.size = size;
  if (quality && quality !== 'auto') requestBody.quality = quality;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      let errorDetail = response.statusText;
      try {
        const errBody = await response.json();
        errorDetail = errBody.error?.message || JSON.stringify(errBody);
      } catch { /* ignore */ }
      throw new Error(`API ${response.status}: ${errorDetail}`);
    }

    const result = await response.json();
    const imageData = result.data?.[0];

    if (!imageData?.b64_json) {
      throw new Error("No image data in response");
    }

    const revisedPrompt = imageData.revised_prompt || '';
    if (revisedPrompt) {
      console.log(`[ImageGen] 💭 Revised prompt: ${revisedPrompt.substring(0, 200)}`);
    }

    yield {
      image: imageData.b64_json,
      revisedPrompt: revisedPrompt,
      isComplete: true,
      usage: { input: 0, output: 0 }
    };

  } catch (error: any) {
    console.error("[ImageGen] ❌ Error:", error.message);
    throw error;
  }
}
