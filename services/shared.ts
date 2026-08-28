
import { Message, Agent, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';
import { renderTextProtocols, type CommandMode } from './capabilities';
import { safeTruncate } from './textUtils';

/**
 * Format a timestamp for display in chat history (e.g., "01-15 14:30")
 */
export function formatMessageTime(timestamp: number): string {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hour}:${minute}`;
}

/**
 * Build the group member list string for inclusion in the system prompt.
 * Each agent gets a line like: "- Name (AI Robot) [ADMIN]"
 * Disguised agents appear as "(Human)" to other agents.
 */
export function buildMemberList(
  allAgents: Agent[],
  currentAgent: Agent,
  groupAdminIds?: string[],
  humanDisguise?: string[],
  mentionOnlyIds?: string[]
): string {
  return allAgents.map(a => {
    const roleBadge = groupAdminIds?.includes(a.id) ? " [ADMIN]" : "";
    const mentionBadge = (mentionOnlyIds || []).includes(a.id) ? " [MENTION-ONLY]" : "";
    const isDisguised = humanDisguise?.includes(a.id) && a.id !== currentAgent.id;
    const typeLabel = isDisguised ? "(Human)" : "(AI Robot)";
    return `- ${a.name} ${typeLabel}${roleBadge}${mentionBadge}`;
  }).join('\n');
}

/**
 * Build the attention/addressing instruction based on the last visible message.
 * Checks @mentions to determine if the agent is being directly addressed,
 * if another agent is addressed, or if addressing is ambiguous.
 */
export function buildAttentionInstruction(
  visibleMessages: Message[],
  agent: Agent,
  allAgents: Agent[],
  mode: CommandMode = 'text'
): string {
  if (visibleMessages.length === 0) return "";

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
    return `
        >>> [URGENT ATTENTION]
        The last message EXPLICITLY mentions you ("${agent.name}").
        You are being directly addressed. You MUST respond. Do NOT pass.
        `;
  } else if (otherMentionedAgent) {
    return `
        >>> [RESTRAINT NOTICE]
        The last message is explicitly addressing another agent: "${otherMentionedAgent.name}".
        Unless you have a critical correction or are explicitly invited to join, you should output "{{PASS}}".
        `;
  } else if (allAgents.length === 1) {
    return mode === 'native'
      ? `>>> You are the only AI in this chat. You MUST reply directly to the user.`
      : `>>> You are the only AI in this chat. You MUST use {{RESPONSE:}} to respond to the user.`;
  } else {
    const ambiguousSpeak = mode === 'native'
      ? '- If the topic is relevant to your persona, reply directly to speak.'
      : '- If the topic is relevant to your persona, use {{RESPONSE:}} to speak.';
    return `
        >>> [AMBIGUOUS ADDRESSING]
        The user did not mention anyone specific.
        ${ambiguousSpeak}
        - If another agent is better suited, output {{PASS}}.
        `;
  }
}

/**
 * Protocols returned by buildProtocols.
 */
export interface ProtocolStrings {
  adminProtocol: string;
  searchToolProtocol: string;
  entertainmentProtocol: string;
  pmProtocol: string;
  splitProtocol: string;
}

/**
 * Build all protocol instruction strings (admin, search, entertainment, PM, split).
 */
export function buildProtocols(
  agent: Agent,
  allAgents: Agent[],
  groupAdminIds?: string[],
  hasSearchTool?: boolean,
  entertainmentConfig?: EntertainmentConfig,
  userName?: string,
  mode: CommandMode = 'text'
): ProtocolStrings {
  return renderTextProtocols({ agent, allAgents, groupAdminIds, hasSearchTool, entertainmentConfig, userName }, mode);
}

/**
 * System prompt split for prompt caching. Three tiers, ordered by how often they change:
 *
 * - stable: persona / members / output format / protocols — byte-identical across
 *   turns as long as group config doesn't change. Safe to put a cache breakpoint after.
 * - memory: the [SHARED MEMORY] block (summary + admin notes) — only changes when the
 *   summary is recomputed (every N messages), so it may stay INSIDE the cached prefix:
 *   one full rewrite per recompute is far cheaper than paying the 1.25x write surcharge
 *   on every single turn.
 * - perTurn: time / recall / attention — changes on EVERY request (the Time line changes
 *   every SECOND). This must sit outside every cache prefix, which means outside the
 *   system block entirely: Anthropic's prefix order is tools → system → messages, so a
 *   volatile system block invalidates not just itself but every breakpoint in the message
 *   history downstream of it. Same for OpenAI/Gemini automatic prefix caching, where the
 *   system message is the very head of the prefix. Callers append perTurn to the tail
 *   [END OF LOG] user turn instead — see buildEndOfLogPrompt.
 */
export interface SystemPromptParts {
  stable: string;
  memory: string;
  perTurn: string;
}

export function buildSystemPromptParts(
  scenario: string | undefined,
  memoryContext: string,
  agent: Agent,
  memberList: string,
  userName: string | undefined,
  userPersona: string | undefined,
  myLastActionContext: string,
  attentionInstruction: string,
  protocols: ProtocolStrings,
  mode: CommandMode = 'text'
): SystemPromptParts {
  const { adminProtocol, searchToolProtocol, entertainmentProtocol, pmProtocol, splitProtocol } = protocols;

  // [OUTPUT FORMAT] differs by track. Native drops the {{RESPONSE:}} wrapper teaching
  // (the raw reply IS the message); {{PASS}} stays a text marker on both tracks.
  // Self-mute is a native tool (set_silence) as of Phase 2, so its {{SILENCE}} text
  // teaching is removed from the native block — text mode keeps it below.
  //
  // Quoting is a native tool too as of 2026-08-27 (`reply`, capabilities.ts), so the
  // native bullet's {{REPLY: id}} syntax lesson moved into that tool's description.
  // What could NOT move is the second half of the old bullet — the ban on reproducing
  // the "[ID: ...] [MM-DD HH:mm] Name:" log header. That ban is about every line the
  // model writes, not about quoting, and it is the only thing standing between the
  // id-first history format (dc69336) and models parroting the header back into their
  // prose. It is kept here verbatim, now on its own bullet. Text mode is untouched:
  // the text track still teaches {{REPLY:}} in its own bullet below.
  const outputFormat = mode === 'native' ? `[OUTPUT FORMAT]
Write your reply directly — no wrapper. Whatever text you output IS your message.
- Stay silent: output only {{PASS}}
- Log header: Every log line begins with a system-added "[ID: ...] [MM-DD HH:mm] Name:" header, your own lines included — never reproduce that header or any part of it in your own output; write only your message body.
- @mention: use @Name only when directly addressing someone` : `[OUTPUT FORMAT]
You MUST use one of these formats. Unwrapped text is discarded.
- Speak: {{RESPONSE: your message}}
- Stay silent: {{PASS}}
- Mute yourself: {{SILENCE: 10min}} or {{SILENCE: 1h}} or {{SILENCE}} (permanent)
- Quote old message: {{RESPONSE: {{REPLY: message_id}} your message}} — message_id is the exact string from that message's [ID: ...] label in the chat log. Every log line begins with a system-added "[ID: ...] [MM-DD HH:mm] Name:" header, your own lines included — never reproduce that header or any part of it in your own output; write only your message body.
- @mention: use @Name inside {{RESPONSE:}} only when directly addressing someone`;

  // Both tracks: members on the legacy text protocol may occasionally leak marker
  // fragments into the chat; without this note, other models tend to imitate or
  // remark on the odd formatting.
  const protocolNote = `[PROTOCOL NOTE]
Members of this chat may run on different communication protocols. If another member's message contains marker fragments like {{...}}, that is formatting residue from their protocol — not something addressed to you. Ignore it, do not imitate it, and do not comment on it.`;

  const stable = `
${scenario ? `[SCENARIO]\n${scenario}\n` : ''}
[GROUP CHAT]
You are ${agent.name} (${agent.role}) in a group chat.
Persona: ${agent.systemPrompt}

Members:
- ${userName || 'User'} (Human)${userPersona ? `: ${userPersona}` : ''}
${memberList}

${outputFormat}
${protocolNote}
${adminProtocol}${searchToolProtocol}${entertainmentProtocol}${pmProtocol}${splitProtocol}
  `;

  // Memory tier: changes only when the summary/admin notes are recomputed, so it is
  // allowed to ride inside the cached prefix. Kept verbatim (buildMemoryContext already
  // supplies its own surrounding whitespace).
  const memory = memoryContext;

  // Per-turn tier: the Time line changes every second, so anything in here poisons any
  // cache prefix it lands in. Empty pieces are dropped so we don't emit blank lines.
  const perTurn = [
    `[NOW]\nTime: ${new Date().toLocaleString()}`,
    myLastActionContext,
    attentionInstruction,
  ].filter(s => s && s.trim()).join('\n');

  return { stable, memory, perTurn };
}

/**
 * The cacheable head of the system prompt: stable + memory, with the per-turn lines
 * deliberately left out. Providers without an explicit cache-block API (OpenAI, Gemini)
 * send exactly this as their system message / systemInstruction, so their automatic
 * prefix caching can match it byte-for-byte across turns.
 */
export function buildCacheableSystemPrompt(parts: SystemPromptParts): string {
  return parts.memory.trim() ? `${parts.stable}\n${parts.memory}` : parts.stable;
}

/**
 * The tail user turn: [END OF LOG] header + per-turn volatile context + trigger sentence.
 *
 * Everything here changes every turn by construction, so it must be the LAST thing in the
 * request and must never sit inside a cached prefix. The trigger sentence stays last so
 * the output-format reminder remains the instruction closest to the model's own output.
 */
export function buildEndOfLogPrompt(
  perTurn: string,
  agentName: string,
  mode: CommandMode = 'text'
): string {
  const trigger = mode === 'native'
    ? `It is now your turn, ${agentName}. Output your reply directly, or output {{PASS}} to stay silent.`
    : `It is now your turn, ${agentName}. You MUST wrap your reply in {{RESPONSE: ...}} or use {{PASS}}. Raw text without wrapper will be discarded.`;
  return ['[END OF LOG]', perTurn, trigger].filter(s => s && s.trim()).join('\n');
}

/**
 * Assemble the full system prompt as one string (stable + memory + perTurn).
 *
 * LEGACY — currently unused by the chat path and kept only for compatibility with any
 * out-of-tree caller. Do NOT use it for a chat request: folding perTurn into the system
 * block is exactly the bug that made every provider's prompt cache miss on every turn.
 * Use buildCacheableSystemPrompt for the system block and buildEndOfLogPrompt for the tail.
 */
export function buildSystemPrompt(
  scenario: string | undefined,
  memoryContext: string,
  agent: Agent,
  memberList: string,
  userName: string | undefined,
  userPersona: string | undefined,
  myLastActionContext: string,
  attentionInstruction: string,
  protocols: ProtocolStrings,
  mode: CommandMode = 'text'
): string {
  const parts = buildSystemPromptParts(
    scenario, memoryContext, agent, memberList, userName, userPersona,
    myLastActionContext, attentionInstruction, protocols, mode
  );
  return [parts.stable, parts.memory, parts.perTurn].filter(s => s && s.trim()).join('\n');
}

/**
 * Build the memory context string from summary and admin notes.
 */
export function buildMemoryContext(summary?: string, adminNotes?: string[]): string {
  return `
    [SHARED MEMORY]
    Long-Term Summary: ${summary || "None"}
    Recent Admin Notes: ${adminNotes && adminNotes.length > 0 ? adminNotes.join('; ') : "None"}
  `;
}

/**
 * Filter messages by visibility rules: context limit, join-time, PM visibility,
 * agent visibility blocks, and open/blind mode.
 *
 * Returns the filtered list of messages visible to the given agent.
 */
export function filterVisibleMessages(
  messages: Message[],
  agent: Agent,
  visibilityMode: 'OPEN' | 'BLIND',
  contextLimit: number,
  agentVisibility?: Record<string, string[]>,
  agentJoinedAt?: Record<string, string>,
  hidePreJoinMessages?: Record<string, boolean>
): Message[] {
  // 1. Exclude streaming placeholders
  let effectiveMessages = messages.filter(m => !m.isStreaming);

  // 2. Context limit slicing — quantized anchor instead of a per-message sliding
  // window. A plain slice(-limit) moves the window head on EVERY new message,
  // which breaks prompt-cache prefix matching (each turn re-reads the whole
  // history at full price). Here the cut point only advances every STRIDE
  // messages; between jumps the window head is byte-stable so providers can
  // serve the shared prefix from cache. Window size floats in [limit, limit+STRIDE).
  if (contextLimit > 0 && effectiveMessages.length > contextLimit) {
    const STRIDE = Math.min(10, Math.max(2, Math.floor(contextLimit / 2)));
    const overflow = effectiveMessages.length - contextLimit;
    const anchor = Math.floor(overflow / STRIDE) * STRIDE;
    effectiveMessages = effectiveMessages.slice(anchor);
  }

  // 3. Join-time filtering
  let joinFilteredMessages = effectiveMessages;
  const joinMsgId = agentJoinedAt?.[agent.id];
  if (joinMsgId && hidePreJoinMessages?.[agent.id]) {
    const joinIdx = effectiveMessages.findIndex(m => m.id === joinMsgId);
    if (joinIdx >= 0) joinFilteredMessages = effectiveMessages.slice(joinIdx);
  }

  // 4. Visibility logic (system messages, PM, user, self, blocked, open/blind)
  return joinFilteredMessages.filter(m => {
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
}

/**
 * Format a single message's text content for inclusion in the chat history
 * sent to an AI model. Adds ID/timestamp labels; on the text track, AI messages
 * are additionally wrapped in {{RESPONSE:}} as a format demonstration. The native
 * track skips the wrapper — those models never emit it, and replaying it in
 * history teaches them to imitate a format the parser no longer expects.
 *
 * Line shape: `[ID: <id>] [MM-DD HH:mm][ [PM]] <Sender>: <text>`
 *
 * EVERY message carries the full header, the viewing agent's own messages included.
 * Gemini/Anthropic used to replay self messages as bare text (they ride the model/
 * assistant role, so the speaker is implicit), but that cost the model the two things
 * the header exists for: it could not quote its own past message ({{REPLY:}} needs an
 * id it can only read off the label) and it could not tell how long ago it spoke.
 * The price is that an id/time header now also appears inside the assistant-role turns,
 * which invites imitation — countered by the explicit "never reproduce that header"
 * ban in [OUTPUT FORMAT] and by stripImitatedLogLabel() on the way back in (App.tsx).
 *
 * @param mode - the viewing agent's command track; 'text' wraps AI messages in {{RESPONSE:}}
 */
export function formatMessageText(
  message: Message,
  agent: Agent,
  allAgents: Agent[],
  userName: string | undefined,
  mode: CommandMode = 'text'
): string {
  const senderName = message.senderId === USER_ID
    ? (userName || "User")
    : (message.senderId === 'SYSTEM' || message.isSystem
      ? "System"
      : allAgents.find(a => a.id === message.senderId)?.name || "Unknown");

  const timeStr = formatMessageTime(message.timestamp);
  const pmLabel = message.pmTargetId ? ' [PM]' : '';
  const isAI = !message.isSystem && message.senderId !== USER_ID && message.senderId !== 'SYSTEM' && message.senderId !== 'narrator';
  const wrappedText = isAI && mode !== 'native' ? `{{RESPONSE: ${message.text}}}` : message.text;

  return `[ID: ${message.id}] [${timeStr}]${pmLabel} ${senderName}: ${wrappedText}`;
}

/**
 * Resolve the sender name for a message.
 */
export function resolveSenderName(
  message: Message,
  allAgents: Agent[],
  userName?: string
): string {
  if (message.senderId === USER_ID) return userName || "User";
  if (message.senderId === 'SYSTEM' || message.isSystem) return "System";
  return allAgents.find(a => a.id === message.senderId)?.name || "Unknown";
}

/**
 * Render the quote preview shown above a message that replies to an earlier one.
 * Carries the target's [ID: ...] label and sender name — without them, models
 * can't tell WHO is being quoted, and the history never demonstrates what a
 * {{REPLY: id}} resolves to (or which id to copy when quoting that message).
 */
export function formatReplyPreview(
  replyTarget: Message,
  allAgents: Agent[],
  userName?: string
): string {
  const senderName = resolveSenderName(replyTarget, allAgents, userName);
  return `[Replying to [ID: ${replyTarget.id}] ${senderName}: "${safeTruncate(replyTarget.text, 50)}..."]`;
}

/**
 * Append document attachment text to a message's text content.
 */
export function appendDocumentAttachments(textContent: string, message: Message): string {
  if (!message.attachments) return textContent;
  let result = textContent;
  message.attachments.filter(att => att.type === 'document' && att.textContent).forEach((att, idx) => {
    result += `\n\n[Attached File ${idx + 1}: ${att.fileName}]\n${att.textContent}\n[End of File]`;
  });
  return result;
}
