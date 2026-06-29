
import { Message, Agent, AgentRole, EntertainmentConfig } from '../types';
import { USER_ID } from '../constants';

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
  humanDisguise?: string[]
): string {
  return allAgents.map(a => {
    const roleBadge = groupAdminIds?.includes(a.id) ? " [ADMIN]" : "";
    const isDisguised = humanDisguise?.includes(a.id) && a.id !== currentAgent.id;
    const typeLabel = isDisguised ? "(Human)" : "(AI Robot)";
    return `- ${a.name} ${typeLabel}${roleBadge}`;
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
  allAgents: Agent[]
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
    return `>>> You are the only AI in this chat. You MUST use {{RESPONSE:}} to respond to the user.`;
  } else {
    return `
        >>> [AMBIGUOUS ADDRESSING]
        The user did not mention anyone specific.
        - If the topic is relevant to your persona, use {{RESPONSE:}} to speak.
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
  userName?: string
): ProtocolStrings {
  // --- ADMIN ---
  let adminProtocol = "";
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

  // --- SEARCH TOOL ---
  let searchToolProtocol = "";
  if (hasSearchTool) {
    searchToolProtocol = `
      [SEARCH TOOL]
      Use {{SEARCH: query}} inside {{RESPONSE:}} to search the web. One search per message.
      Example: {{RESPONSE: {{SEARCH: latest AI news}} Let me look that up}}
    `;
  }

  // --- ENTERTAINMENT TOOLS (Dice, Tarot) ---
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

  // --- PM (Private Message) ---
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

  // --- SPLIT ---
  const splitProtocol = entertainmentConfig?.enableSplit ? `
- Message split: use [SPLIT] inside your {{RESPONSE:}} to send multiple separate chat bubbles, like a real person typing message by message.
  WARNING: You MUST put ALL [SPLIT] markers inside a SINGLE {{RESPONSE:}} block. Using multiple {{RESPONSE:}} blocks will cause all messages after the first to be SILENTLY DISCARDED and lost.
  CORRECT example:
    {{RESPONSE: Hey everyone[SPLIT]Just wanted to say hi[SPLIT]What are we talking about?}}
  WRONG (messages WILL BE LOST):
    {{RESPONSE: Hey}}{{RESPONSE: Hi}}
    {{RESPONSE: Hey}}[SPLIT]{{RESPONSE: Hi}}
` : '';

  return { adminProtocol, searchToolProtocol, entertainmentProtocol, pmProtocol, splitProtocol };
}

/**
 * Assemble the full system prompt from its constituent parts.
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
  protocols: ProtocolStrings
): string {
  const { adminProtocol, searchToolProtocol, entertainmentProtocol, pmProtocol, splitProtocol } = protocols;

  return `
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

  // 2. Context limit slicing
  if (contextLimit > 0) effectiveMessages = effectiveMessages.slice(-contextLimit);

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
 * sent to an AI model. Wraps AI messages in {{RESPONSE:}}, adds timestamp/ID labels.
 *
 * @param isSelf - whether this message was sent by the current agent
 * @param addTimestampToSelf - if false, self messages get only the wrapped text (Gemini/Anthropic style);
 *                             if true, all messages get the full timestamp label (OpenAI style)
 */
export function formatMessageText(
  message: Message,
  agent: Agent,
  allAgents: Agent[],
  userName: string | undefined,
  isSelf: boolean,
  addTimestampToSelf: boolean
): string {
  const senderName = message.senderId === USER_ID
    ? (userName || "User")
    : (message.senderId === 'SYSTEM' || message.isSystem
      ? "System"
      : allAgents.find(a => a.id === message.senderId)?.name || "Unknown");

  const timeStr = formatMessageTime(message.timestamp);
  const pmLabel = message.pmTargetId ? ' [PM]' : '';
  const isAI = !message.isSystem && message.senderId !== USER_ID && message.senderId !== 'SYSTEM' && message.senderId !== 'narrator';
  const wrappedText = isAI ? `{{RESPONSE: ${message.text}}}` : message.text;

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
