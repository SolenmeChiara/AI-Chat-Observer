
import { Message, Agent, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';
import { renderTextProtocols, type CommandMode } from './capabilities';

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
 * System prompt split for prompt caching:
 * - stable: persona / members / output format / protocols — byte-identical across
 *   turns as long as group config doesn't change. Safe to put a cache breakpoint after.
 * - dynamic: time / recall / attention / shared memory — changes every turn (the
 *   Time line changes every SECOND), so it must live outside the cached prefix.
 */
export interface SystemPromptParts {
  stable: string;
  dynamic: string;
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
  // (the raw reply IS the message); {{PASS}} / {{REPLY}} stay text markers on both tracks.
  // Self-mute is a native tool (set_silence) as of Phase 2, so its {{SILENCE}} text
  // teaching is removed from the native block — text mode keeps it below.
  const outputFormat = mode === 'native' ? `[OUTPUT FORMAT]
Write your reply directly — no wrapper. Whatever text you output IS your message.
- Stay silent: output only {{PASS}}
- Quote old message: messages in the chat log carry an [ID: ...] label. Copy that exact id string into the marker and START your reply with it, closing braces required. Example — to quote the log line "[08-27 14:31] [ID: 1780000000001-1111] Alice: the budget is too high", begin your reply with: {{REPLY: 1780000000001-1111}} followed by your text. Never write the [ID: ...] label itself in your own output.
- @mention: use @Name only when directly addressing someone` : `[OUTPUT FORMAT]
You MUST use one of these formats. Unwrapped text is discarded.
- Speak: {{RESPONSE: your message}}
- Stay silent: {{PASS}}
- Mute yourself: {{SILENCE: 10min}} or {{SILENCE: 1h}} or {{SILENCE}} (permanent)
- Quote old message: {{RESPONSE: {{REPLY: message_id}} your message}} — message_id is the exact string from that message's [ID: ...] label in the chat log. Never write the [ID: ...] label itself in your own output.
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

  const dynamic = `
${memoryContext}
[NOW]
Time: ${new Date().toLocaleString()}
${myLastActionContext}
${attentionInstruction}
  `;

  return { stable, dynamic };
}

/**
 * Assemble the full system prompt as a single string (stable + dynamic).
 * Providers without an explicit cache-block API use this combined form.
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
  return `${parts.stable}\n${parts.dynamic}`;
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
 * sent to an AI model. Adds timestamp/ID labels; on the text track, AI messages
 * are additionally wrapped in {{RESPONSE:}} as a format demonstration. The native
 * track skips the wrapper — those models never emit it, and replaying it in
 * history teaches them to imitate a format the parser no longer expects.
 *
 * @param isSelf - whether this message was sent by the current agent
 * @param addTimestampToSelf - if false, self messages get only the wrapped text (Gemini/Anthropic style);
 *                             if true, all messages get the full timestamp label (OpenAI style)
 * @param mode - the viewing agent's command track; 'text' wraps AI messages in {{RESPONSE:}}
 */
export function formatMessageText(
  message: Message,
  agent: Agent,
  allAgents: Agent[],
  userName: string | undefined,
  isSelf: boolean,
  addTimestampToSelf: boolean,
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

  if (isSelf && !addTimestampToSelf) {
    return wrappedText;
  }
  return `[${timeStr}] [ID: ${message.id}]${pmLabel} ${senderName}: ${wrappedText}`;
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
