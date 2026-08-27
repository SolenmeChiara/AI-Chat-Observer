
import { GoogleGenAI } from "@google/genai";
import { Message, Agent, StreamChunk, AgentRole, GeminiMode, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';
import {
  formatMessageTime,
  buildMemberList,
  buildAttentionInstruction,
  buildProtocols,
  buildSystemPromptParts,
  buildCacheableSystemPrompt,
  buildEndOfLogPrompt,
  buildMemoryContext,
  filterVisibleMessages,
  formatMessageText,
  formatReplyPreview,
  appendDocumentAttachments
} from './shared';
import { renderToolSchemas, getCommandMode, type CapabilityCall } from './capabilities';
import { safeTruncate } from './textUtils';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Detect Gemini 3+ models (use thinking_level instead of thinkingBudget)
function isGemini3Model(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.includes('gemini-3') || lower.includes('gemini3');
}

// Helper: Detect Gemini image generation models (can output text + images)
function isGeminiImageModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('-image');
}

// Helper: Map reasoningBudget to Gemini 3 thinking_level
// LOW: minimizes latency/cost, HIGH: maximizes reasoning depth
function mapBudgetToThinkingLevel(budget: number): 'LOW' | 'HIGH' {
  // If budget is low (< 8000), use LOW level for faster responses
  // Otherwise use HIGH for deeper reasoning
  return budget < 8000 ? 'LOW' : 'HIGH';
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
  mentionOnlyIds?: string[],
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk> {
  const ai = getClient(geminiConfig);

  // Command mode: native function calling by default; explicit 'text' opts into
  // the legacy text protocol (older models / tool-stripping proxies).
  const commandMode = getCommandMode(agent);

  // 1-3. Filter messages by visibility rules
  const visibleMessages = filterVisibleMessages(
    messages, agent, visibilityMode, contextLimit,
    agentVisibility, agentJoinedAt, hidePreJoinMessages
  );

  // 3. Find Last Action (Memory Injection)
  const myLastMessage = [...visibleMessages].reverse().find(m => m.senderId === agent.id && !m.isSystem);
  const myLastActionContext = myLastMessage
    ? `Recall that your LAST message was: "${safeTruncate(myLastMessage.text, 100)}...". Maintain continuity.`
    : "You haven't spoken recently.";

  // 4. Build Group Member List for Context
  const memberList = buildMemberList(allAgents, agent, groupAdminIds, humanDisguise, mentionOnlyIds);

  // 5. Attention / Addressing Logic
  const attentionInstruction = buildAttentionInstruction(visibleMessages, agent, allAgents, commandMode);

  // 6-8. Build Protocols (Admin, Search, Entertainment, PM, Split)
  const protocols = buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName, commandMode);

  // Memory Context
  const memoryContext = buildMemoryContext(summary, adminNotes);

  // System Instruction. Gemini's implicit caching matches on the request prefix
  // (systemInstruction first, then contents), so only the cacheable tiers go here:
  // persona/protocols + shared memory. The per-turn lines (time/recall/attention) would
  // change the very first bytes of that prefix every call, so they ride the trigger turn.
  const systemParts = buildSystemPromptParts(
    scenario, memoryContext, agent, memberList,
    userName, userPersona, myLastActionContext,
    attentionInstruction, protocols, commandMode
  );
  const systemPrompt = buildCacheableSystemPrompt(systemParts);

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
    // Search results: inject as labeled user context. Carries the same [ID:]/time header
    // as a normal log line so the model can tell how stale the results are (and quote them).
    if (m.isSearchResult) {
      const searchLabel = `[ID: ${m.id}] [${formatMessageTime(m.timestamp)}] ` +
        (m.searchQuery ? `[Search results for "${m.searchQuery}"]` : '[Search results]');
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

    const parts: any[] = [];

    // For Gemini 3: Include thought signature in model's own messages (required for multi-turn)
    if (isGemini3 && isSelf && m.reasoningText && m.reasoningSignature && !hasIncompleteThinking) {
      parts.push({
        thought: true,
        text: m.reasoningText,
        thoughtSignature: m.reasoningSignature
      });
    }

    // Text Part WITH ID AND TIMESTAMP INJECTION (self messages included — see formatMessageText)
    let textContent = formatMessageText(m, agent, allAgents, userName, commandMode);

    if (m.replyToId) {
        const replyTarget = messages.find(msg => msg.id === m.replyToId);
        if (replyTarget) {
            textContent = `${formatReplyPreview(replyTarget, allAgents, userName)}\n${textContent}`;
        }
    }

    // Document Attachments (multiple)
    textContent = appendDocumentAttachments(textContent, m);

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

  // Last turn: The "Trigger". Also carries the per-turn volatile context (time / recall /
  // attention) that used to sit in systemInstruction and broke the cache prefix on every call.
  const triggerText = buildEndOfLogPrompt(systemParts.perTurn, agent.name, commandMode);
  formattedContents.push({
    role: 'user',
    parts: [{ text: triggerText }]
  });

  const MAX_RETRIES = 3;
  let streamResult;

  // Check if model supports system instruction (Gemma models don't)
  const modelLower = modelId.toLowerCase();
  const supportsSystemInstruction = !modelLower.includes('gemma');

  // If model doesn't support system instruction, prepend it as first user message.
  // systemPrompt is already the cacheable head only (stable + memory), so this fallback
  // keeps the prefix byte-stable too — the per-turn lines are down in triggerText.
  const finalContents = supportsSystemInstruction
    ? formattedContents
    : [
        { role: 'user', parts: [{ text: `[SYSTEM INSTRUCTION]\n${systemPrompt}\n[END SYSTEM INSTRUCTION]` }] },
        { role: 'model', parts: [{ text: 'Understood. I will follow these instructions.' }] },
        ...formattedContents
      ];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError');
      // Detect Gemini 3 model
      const isGemini3 = isGemini3Model(modelId);

      // Build config object
      // Note: Gemini 3 recommends using default temperature (1.0) for thinking mode
      const effectiveTemp = isGemini3 && agent.config.enableReasoning ? 1.0 : agent.config.temperature;
      const isImageModel = isGeminiImageModel(modelId);
      // Assemble tools: googleSearch grounding (if enabled) plus native functionDeclarations
      // (if this agent is in native command mode).
      //
      // Combining built-in tools with function calling requires
      // toolConfig.includeServerSideToolInvocations (otherwise the API 400s with
      // "Please enable tool_config.include_server_side_tool_invocations..."), and per
      // https://ai.google.dev/gemini-api/docs/tool-combination the combination is
      // Gemini 3 only (Preview) and the flag is not supported on Vertex AI.
      // So: G3 + AI Studio → both tools + flag; anywhere else with both enabled →
      // keep functionDeclarations (the agent's whole capability set rides on them)
      // and drop grounding for this request, with a console.warn.
      // Pure image-gen models are excluded from function tools: they don't do
      // function calling, and offering tools can break the request entirely.
      const nativeFnDecls = commandMode === 'native' && !isImageModel
        ? renderToolSchemas(
            { agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName },
            'gemini'
          )
        : [];
      const wantsBoth = enableGoogleSearch && nativeFnDecls.length > 0;
      const canCombine = isGemini3 && geminiConfig.geminiMode !== 'vertex';
      let includeServerSideToolInvocations = false;
      const toolList: any[] = [];
      if (wantsBoth && canCombine) {
        // Official docs shape: built-in tool + function declarations merged into ONE
        // Tool object (separate entries can trip the server-side combination check).
        toolList.push({ googleSearch: {}, functionDeclarations: nativeFnDecls });
        includeServerSideToolInvocations = true;
      } else {
        if (enableGoogleSearch && !wantsBoth) toolList.push({ googleSearch: {} });
        if (nativeFnDecls.length > 0) toolList.push({ functionDeclarations: nativeFnDecls });
      }
      if (wantsBoth && !canCombine) {
        console.warn(`[${agent.name}] ⚠️ googleSearch grounding + function calling requires Gemini 3 on AI Studio; dropping grounding for this request (model: ${modelId}, mode: ${geminiConfig.geminiMode || 'aistudio'})`);
      }

      const apiConfig: any = {
        systemInstruction: supportsSystemInstruction ? systemPrompt : undefined,
        maxOutputTokens: agent.config.maxTokens,
        tools: toolList.length > 0 ? toolList : undefined,
        ...(includeServerSideToolInvocations ? { toolConfig: { includeServerSideToolInvocations: true } } : {}),
        ...(isImageModel ? { responseModalities: ['TEXT', 'IMAGE'] } : {}),
      };
      if (effectiveTemp !== null) apiConfig.temperature = effectiveTemp;
      if (agent.config.topP !== null) apiConfig.topP = agent.config.topP;

      // Add thinkingConfig based on model version
      // Image models have built-in thinking (always on), just need includeThoughts to see it
      // For Gemini 3: skip if there's incomplete thinking in history (missing signatures)
      if (isImageModel) {
        apiConfig.thinkingConfig = {
          ...(isGemini3Model(modelId) ? { thinkingLevel: agent.config.enableReasoning ? 'HIGH' : 'MINIMAL' } : {}),
          includeThoughts: true
        };
      } else if (agent.config.enableReasoning && !(isGemini3 && hasIncompleteThinking)) {
        if (isGemini3) {
          apiConfig.thinkingConfig = {
            thinkingLevel: mapBudgetToThinkingLevel(agent.config.reasoningBudget || 8000),
            includeThoughts: true
          };
        } else {
          apiConfig.thinkingConfig = {
            thinkingBudget: agent.config.reasoningBudget || -1,
            includeThoughts: true
          };
        }
      }

      if (signal) apiConfig.abortSignal = signal;

      streamResult = await ai.models.generateContentStream({
        model: modelId,
        contents: finalContents,
        config: apiConfig
      });
      break; // Success, exit retry loop
    } catch (error: any) {
      // Aborted requests must never be retried — propagate immediately
      if (error.name === 'AbortError' || signal?.aborted) throw error;
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
    const isImageModel = isGeminiImageModel(modelId);
    const mayHaveThinking = isThinkingModel || agent.config.enableReasoning || isImageModel;

    if (streamResult) {
      for await (const chunk of streamResult) {
        // For thinking-enabled models, parse parts to separate thought from response
        if (chunk.candidates?.[0]?.content?.parts) {
          for (const part of chunk.candidates[0].content.parts) {
            // Image part (Gemini image models output inlineData with base64 images)
            if (part.inlineData?.data && part.inlineData?.mimeType?.startsWith('image/')) {
              if (!part.thought) {
                yield { image: part.inlineData.data, isComplete: false };
              }
              continue;
            }

            // Native function-call part → CapabilityCall (Phase 1). The SDK delivers args as an
            // already-parsed object. App.tsx bridges this onto the text-track detected* variables.
            if (part.functionCall) {
              const fc = part.functionCall;
              const call: CapabilityCall = {
                capability: fc.name || '',
                args: (fc.args && typeof fc.args === 'object') ? fc.args as Record<string, unknown> : {},
              };
              yield { toolCalls: [call], isComplete: false };
              continue;
            }

            if (part.text) {
              if (part.thought) {
                yield { reasoning: part.text, isComplete: false };
              } else {
                totalText += part.text;
                yield { text: part.text, isComplete: false };
              }
            }
            if (part.thoughtSignature) {
              capturedThoughtSignature = part.thoughtSignature;
            }
          }
        } else if (!chunk.candidates?.[0]?.content?.parts) {
          // Non-parts fallback: use simple text extraction
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
        // thoughtsTokenCount 是独立字段(不含在 candidatesTokenCount 里),思考 token 按 output 价计费
        output: (capturedUsage?.candidatesTokenCount || 0) + (capturedUsage?.thoughtsTokenCount || 0)
      }
    };

  } catch (error) {
    console.error("Gemini Stream Consumption Error", error);
    throw error;
  }
}
