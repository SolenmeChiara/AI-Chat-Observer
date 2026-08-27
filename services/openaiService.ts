
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
  formatReplyPreview,
  appendDocumentAttachments
} from './shared';
import { renderToolSchemas, getCommandMode, type CapabilityCall } from './capabilities';
import { safeTruncate, wellFormedStringify } from './textUtils';

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
  hidePreJoinMessages?: Record<string, boolean>,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // Command mode: native function calling by default; explicit 'text' opts into
  // the legacy text protocol (older models / tool-stripping proxies).
  const commandMode = getCommandMode(agent);

  // 1-3. Filter messages by visibility rules
  const visibleMessages = filterVisibleMessages(
    messages, agent, visibilityMode, contextLimit,
    agentVisibility, agentJoinedAt, hidePreJoinMessages
  );

  // 3. Find Last Action
  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage
    ? `Recall that your LAST message was: "${safeTruncate(myLastMessage.text, 100)}...".`
    : "";

  // 4. Build Group Member List
  const memberList = buildMemberList(allAgents, agent, groupAdminIds, humanDisguise, mentionOnlyIds);

  // 5. Attention / Addressing Logic
  const attentionInstruction = buildAttentionInstruction(visibleMessages, agent, allAgents, commandMode);

  // 6-8. Build Protocols (Admin, Search, Entertainment, PM, Split)
  const protocols = buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName, commandMode);

  // Memory Context
  const memoryContext = buildMemoryContext(summary, adminNotes);

  // System Prompt Injection
  const systemInstruction = buildSystemPrompt(
    scenario, memoryContext, agent, memberList,
    userName, userPersona, myLastActionContext,
    attentionInstruction, protocols, commandMode
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
       let textContent = formatMessageText(m, agent, allAgents, userName, false, true, commandMode);

       // Handle Quote/Reply
       if (m.replyToId) {
          const replyTarget = messages.find(msg => msg.id === m.replyToId);
          if (replyTarget) {
              textContent = `${formatReplyPreview(replyTarget, allAgents, userName)}\n${textContent}`;
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
    { role: 'user', content: commandMode === 'native'
      ? `[END OF LOG]\nIt is now your turn, ${agent.name}. Output your reply directly, or output {{PASS}} to stay silent.`
      : `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.` }
  ];

  // Native track: assemble Chat Completions tool schemas once (omitted when empty).
  const nativeTools = commandMode === 'native'
    ? renderToolSchemas({ agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName }, 'openai-chat')
    : [];

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
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

      // Native track: attach function tools (default tool_choice 'auto' — model may still
      // just talk). Omitted entirely in text mode / when no capability is available.
      if (nativeTools.length > 0) {
        requestBody.tools = nativeTools;
      }

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
        body: wellFormedStringify(requestBody),
        signal
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
        // Aborted requests must never be retried — propagate immediately
        if (error.name === 'AbortError' || signal?.aborted) throw error;
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

    // Native tool_calls accumulation, keyed by delta.tool_calls[].index. `name` usually
    // arrives once (first fragment) and `arguments` streams as a string we concatenate.
    // Some relays deliver the whole arguments string in a single (often final) delta —
    // append-based accumulation handles both. Parsed after the stream ends.
    const toolCallAccum: Record<number, { name: string; args: string; id: string }> = {};
    let sawToolCalls = false;

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

             // 3. Native tool call fragments (accumulate; parsed after the stream ends).
             if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const idx = typeof tc.index === 'number' ? tc.index : 0;
                    if (!toolCallAccum[idx]) toolCallAccum[idx] = { name: '', args: '', id: '' };
                    const slot = toolCallAccum[idx];
                    if (tc.id) slot.id = tc.id;
                    if (tc.function?.name) slot.name = tc.function.name;
                    if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
                    sawToolCalls = true;
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

    // Native tool calls: parse each accumulated group and yield as CapabilityCalls.
    // A group whose arguments fail to JSON.parse warns and is dropped — never throws.
    if (sawToolCalls) {
      const calls: CapabilityCall[] = [];
      for (const idx of Object.keys(toolCallAccum).map(Number).sort((a, b) => a - b)) {
        const slot = toolCallAccum[idx];
        if (!slot.name) continue;
        try {
          const args = slot.args.trim() ? JSON.parse(slot.args) : {};
          calls.push({ capability: slot.name, args: (args && typeof args === 'object') ? args as Record<string, unknown> : {} });
        } catch {
          console.warn(`[OpenAI] ⚠️ Dropped tool call '${slot.name}' — bad JSON args:`, slot.args);
        }
      }
      if (calls.length > 0) yield { toolCalls: calls, isComplete: false };
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
  hidePreJoinMessages?: Record<string, boolean>,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // Command mode: native function calling by default; explicit 'text' opts into the legacy protocol.
  const commandMode = getCommandMode(agent);

  const visibleMessages = filterVisibleMessages(
    messages, agent, visibilityMode, contextLimit,
    agentVisibility, agentJoinedAt, hidePreJoinMessages
  );

  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage
    ? `Recall that your LAST message was: "${safeTruncate(myLastMessage.text, 100)}...".`
    : "";

  const memberList = buildMemberList(allAgents, agent, groupAdminIds, humanDisguise, mentionOnlyIds);
  const attentionInstruction = buildAttentionInstruction(visibleMessages, agent, allAgents, commandMode);
  const protocols = buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName, commandMode);
  const memoryContext = buildMemoryContext(summary, adminNotes);
  const systemInstruction = buildSystemPrompt(
    scenario, memoryContext, agent, memberList,
    userName, userPersona, myLastActionContext,
    attentionInstruction, protocols, commandMode
  );

  // Build input items (Responses API accepts messages-style input)
  const inputItems: any[] = visibleMessages.map(m => {
    if (m.isSearchResult) {
      const searchLabel = m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]';
      return { role: 'user', content: `${searchLabel}\n${m.text}\n[End of search results. Now respond based on the above.]` };
    }

    let textContent = formatMessageText(m, agent, allAgents, userName, false, true, commandMode);

    if (m.replyToId) {
      const replyTarget = messages.find(msg => msg.id === m.replyToId);
      if (replyTarget) {
        textContent = `${formatReplyPreview(replyTarget, allAgents, userName)}\n${textContent}`;
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
    content: commandMode === 'native'
      ? `[END OF LOG]\nIt is now your turn, ${agent.name}. Output your reply directly, or output {{PASS}} to stay silent.`
      : `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.`
  });

  // Native track: Responses function tools (top-level `{type:'function', name, ...}` shape),
  // assembled once. Merged with image_generation below so both can be offered together.
  // Pure image-gen models (gpt-image / dall-e) are excluded: they don't do function
  // calling, and sending function tools makes some proxies 404 the model entirely.
  const nativeTools = commandMode === 'native' && !isImageGenModel(modelId)
    ? renderToolSchemas({ agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName }, 'openai-responses')
    : [];

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
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

      // Assemble tools: native function tools (if any) coexist with image_generation
      // in a single array. The image tool attaches when the agent opts in via
      // enableImageTool (mainline gpt-5.x on Responses), or defensively for any
      // pure image-gen model that somehow reaches this path.
      const responsesTools: any[] = [...nativeTools];
      if (agent.config.enableImageTool || isImageGenModel(modelId)) {
        const imageTool: any = { type: 'image_generation', quality: agent.config.imageQuality || 'auto' };
        if (agent.config.imageSize && agent.config.imageSize !== 'auto') {
          imageTool.size = agent.config.imageSize;
        }
        responsesTools.push(imageTool);
      }
      if (responsesTools.length > 0) {
        requestBody.tools = responsesTools;
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
        body: wellFormedStringify(requestBody),
        signal
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
      // Aborted requests must never be retried — propagate immediately
      if (error.name === 'AbortError' || signal?.aborted) throw error;
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

    // Native function-call accumulation, keyed by output_index (falling back to item_id).
    // Arguments stream as function_call_arguments.delta; finalized on
    // function_call_arguments.done (authoritative full string), with output_item.done as a
    // fallback. `finalized` guards against the two finalize points double-emitting.
    const fnCallAccum: Record<string, { name: string; args: string; finalized: boolean }> = {};
    const fnKey = (j: any): string => String(j.output_index ?? j.item_id ?? j.item?.id ?? '');
    const buildFnCall = (name: string, argStr: string): CapabilityCall | null => {
      try {
        const parsed = argStr.trim() ? JSON.parse(argStr) : {};
        return { capability: name, args: (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {} };
      } catch {
        console.warn(`[OpenAI Responses] ⚠️ Dropped function call '${name}' — bad JSON args:`, argStr);
        return null;
      }
    };

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

          // Image generation output
          if (eventType === 'response.image_generation_call.partial_image') {
            const b64 = json.partial_image_b64;
            if (b64) {
              yield { image: b64, isComplete: false };
            }
          }

          // Native function call: output item opens (skeleton with name).
          if (eventType === 'response.output_item.added' && json.item?.type === 'function_call') {
            fnCallAccum[fnKey(json)] = { name: json.item.name || '', args: '', finalized: false };
          }

          // Native function call: arguments stream as string fragments.
          if (eventType === 'response.function_call_arguments.delta') {
            const slot = fnCallAccum[fnKey(json)];
            if (slot && typeof json.delta === 'string') slot.args += json.delta;
          }

          // Native function call: arguments complete — authoritative full string, finalize.
          if (eventType === 'response.function_call_arguments.done') {
            const slot = fnCallAccum[fnKey(json)];
            if (slot && !slot.finalized) {
              slot.finalized = true;
              const call = buildFnCall(slot.name, typeof json.arguments === 'string' ? json.arguments : slot.args);
              if (call) yield { toolCalls: [call], isComplete: false };
            }
          }

          // Native function call: item done — fallback finalize for servers that skip
          // function_call_arguments.done (or never emitted output_item.added).
          if (eventType === 'response.output_item.done' && json.item?.type === 'function_call') {
            const key = fnKey(json);
            const slot = fnCallAccum[key];
            const argStr = typeof json.item.arguments === 'string' ? json.item.arguments : (slot?.args || '');
            if (slot && !slot.finalized) {
              slot.finalized = true;
              const call = buildFnCall(slot.name || json.item.name || '', argStr);
              if (call) yield { toolCalls: [call], isComplete: false };
            } else if (!slot && json.item.name) {
              fnCallAccum[key] = { name: json.item.name, args: '', finalized: true };
              const call = buildFnCall(json.item.name, argStr);
              if (call) yield { toolCalls: [call], isComplete: false };
            }
          }

          // Response completed (may contain final image)
          if (eventType === 'response.completed') {
            const output = json.response?.output;
            if (Array.isArray(output)) {
              for (const item of output) {
                if (item.type === 'image_generation_call' && item.result) {
                  yield { image: item.result, isComplete: false };
                }
              }
            }
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

// Decode a base64 data URL into a Blob without going through fetch(). Works in both
// the browser and Node 18+ (atob / Blob / Uint8Array are all global). Kept fetch-free
// on purpose so the /images/edits multipart path issues exactly one network call.
function dataUrlToBlob(dataUrl: string, fallbackMime: string): Blob {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = (mimeMatch ? mimeMatch[1] : '') || fallbackMime || 'image/png';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export async function* streamImageGeneration(
  agent: Agent,
  baseUrl: string,
  apiKey: string,
  modelId: string,
  prompt: string,
  size?: string,
  quality?: string,
  referenceImages?: { dataUrl: string; mimeType: string }[],
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {

  if (!apiKey || !baseUrl) throw new Error("Missing Config");

  // Reference images route the request to /images/edits (multipart). Cap at 4 (API limit);
  // extras are dropped with a warning. Empty/undefined → behave exactly like before.
  let refs = referenceImages ?? [];
  if (refs.length > 4) {
    console.warn(`[ImageGen] ⚠️ ${refs.length} reference images provided, truncating to 4`);
    refs = refs.slice(0, 4);
  }
  const useEdits = refs.length > 0;
  const suffix = useEdits ? '/images/edits' : '/images/generations';

  // Derive image API endpoint from base URL
  let endpoint = baseUrl;
  if (endpoint.endsWith('/chat/completions')) {
    endpoint = endpoint.replace(/\/chat\/completions$/, suffix);
  } else if (endpoint.endsWith('/responses')) {
    endpoint = endpoint.replace(/\/responses$/, suffix);
  } else if (endpoint.endsWith('/v1')) {
    endpoint += suffix;
  } else {
    endpoint = endpoint.replace(/\/?$/, suffix);
  }

  console.log(`[ImageGen] 🎨 ${useEdits ? `Editing with ${refs.length} reference image(s)` : 'Generating image'} with ${modelId}: "${prompt.substring(0, 100)}..."`);
  yield { reasoning: `${useEdits ? 'Editing' : 'Generating'}: ${prompt}`, isComplete: false };

  const isGptImage = /gpt-image/i.test(modelId);

  try {
    let response: Response;

    if (useEdits) {
      // /images/edits is a multipart endpoint: build FormData. Do NOT set Content-Type
      // manually — the browser adds the multipart boundary. Only Authorization is sent.
      const form = new FormData();
      form.append('model', modelId);
      form.append('prompt', prompt);
      if (size && size !== 'auto') form.append('size', size);
      if (quality && quality !== 'auto') form.append('quality', quality);
      if (isGptImage) form.append('output_format', 'png');
      else form.append('response_format', 'b64_json');
      refs.forEach((ref, i) => {
        const ext = (ref.mimeType?.split('/')[1] || 'png').split('+')[0];
        form.append('image[]', dataUrlToBlob(ref.dataUrl, ref.mimeType), `reference_${i}.${ext}`);
      });

      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`
        },
        body: form,
        signal
      });
    } else {
      const requestBody: any = {
        model: modelId,
        prompt: prompt,
        n: 1,
        ...(isGptImage ? { output_format: 'png' } : { response_format: 'b64_json' }),
      };

      if (size && size !== 'auto') requestBody.size = size;
      if (quality && quality !== 'auto') requestBody.quality = quality;

      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: wellFormedStringify(requestBody),
        signal
      });
    }

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
