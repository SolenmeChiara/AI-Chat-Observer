
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
import { renderToolSchemas, getCommandMode, type CapabilityCall } from './capabilities';

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
    ? `You previously said: "${myLastMessage.text.substring(0, 100)}...".`
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
  const endOfLogText = commandMode === 'native'
    ? `[END OF LOG]\nIt is now your turn, ${agent.name}. Output your reply directly, or output {{PASS}} to stay silent.`
    : `[END OF LOG]\nIt is now your turn, ${agent.name}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.`;
  const endOfLogBlock = { type: "text", text: endOfLogText };
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
          thinkingConfig = { type: "adaptive", display: "summarized" };
          if (agent.config.effort) {
              outputConfig = { effort: agent.config.effort };
          }
      } else {
          thinkingConfig = {
              type: "enabled",
              budget_tokens: agent.config.reasoningBudget || 2048,
              display: "summarized"
          };
          if (maxTokensConfig <= (thinkingConfig.budget_tokens || 0)) {
              maxTokensConfig = (thinkingConfig.budget_tokens || 2048) + 1024;
          }
      }
  }

  // Native track: assemble the tool schemas once (stable order → stable cache prefix).
  // Empty in text mode or when no capability is available → the `tools` field is omitted.
  const nativeTools = commandMode === 'native'
    ? renderToolSchemas({ agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName }, 'anthropic')
    : [];

  const MAX_RETRIES = 3;
  let response: Response | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
        // Add cache breakpoint to the second-to-last message content block
        if (formattedMessages.length >= 2) {
          const target = formattedMessages[formattedMessages.length - 2];
          if (Array.isArray(target.content) && target.content.length > 0) {
            const lastBlock = target.content[target.content.length - 1];
            if (!lastBlock.cache_control) lastBlock.cache_control = { type: 'ephemeral' };
          }
        }

        const body: any = {
            model: modelId,
            max_tokens: maxTokensConfig,
            system: [{ type: 'text', text: systemInstruction, cache_control: { type: 'ephemeral' } }],
            messages: formattedMessages,
            stream: true
        };

        if (nativeTools.length > 0) {
            body.tools = nativeTools;
        }

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
            body: JSON.stringify(body),
            signal
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
        // Aborted requests must never be retried — propagate immediately
        if (error.name === 'AbortError' || signal?.aborted) throw error;
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
    // Native tool_use accumulation, keyed by content-block index (a reply may carry
    // several tool_use blocks alongside text/thinking blocks). Each block streams its
    // arguments as `input_json_delta` fragments that we concatenate, then JSON.parse
    // on content_block_stop. A parse failure warns and drops that one call — never
    // throws, so a malformed tool argument can't take down the whole reply.
    const toolUseBlocks: Record<number, { name: string; id: string; jsonBuf: string }> = {};

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
                    const cacheRead = json.message.usage.cache_read_input_tokens || 0;
                    const cacheWrite = json.message.usage.cache_creation_input_tokens || 0;
                    if (cacheRead > 0 || cacheWrite > 0) {
                      console.log(`[Anthropic] 💾 Cache: ${cacheRead} read, ${cacheWrite} written, ${capturedUsage.input} uncached`);
                    }
                }

                // Native tool_use block opens: record its name/id and open an argument buffer.
                if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
                    const idx = json.index;
                    if (typeof idx === 'number') {
                        toolUseBlocks[idx] = {
                            name: json.content_block.name || '',
                            id: json.content_block.id || '',
                            jsonBuf: '',
                        };
                    }
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
                    // Native tool arguments stream as input_json_delta fragments.
                    if (json.delta?.type === 'input_json_delta' && typeof json.index === 'number' && toolUseBlocks[json.index]) {
                        toolUseBlocks[json.index].jsonBuf += (json.delta.partial_json || '');
                    }
                }

                // content_block_stop: finalize a native tool_use block if this index is one.
                if (json.type === 'content_block_stop' && typeof json.index === 'number' && toolUseBlocks[json.index]) {
                    const block = toolUseBlocks[json.index];
                    delete toolUseBlocks[json.index];
                    try {
                        const args = block.jsonBuf.trim() ? JSON.parse(block.jsonBuf) : {};
                        const call: CapabilityCall = {
                            capability: block.name,
                            args: (args && typeof args === 'object') ? args as Record<string, unknown> : {},
                        };
                        hasReceivedContent = true;
                        yield { toolCalls: [call], isComplete: false };
                    } catch (e) {
                        console.warn(`[Anthropic] ⚠️ Dropped tool_use '${block.name}' — bad JSON args:`, block.jsonBuf);
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
