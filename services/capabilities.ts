
import { Agent, AgentRole, EntertainmentConfig } from '../types';
import type { ProtocolStrings } from './shared';

/**
 * Capability registry (Phase 0 of the tool abstraction layer).
 *
 * Single source of truth for *which* agent capabilities are available in a
 * given turn. Two consumers are planned:
 *   - text track: `renderTextProtocols` below assembles the exact protocol
 *     teaching text (identical to the legacy `buildProtocols` output);
 *   - native track (Phase 1+): tool schemas derived from `description` +
 *     `paramsSchema` — defined here but NOT consumed yet.
 *
 * PASS / REPLY / [SPLIT] are intentionally NOT capabilities (see plan 2.3):
 * pure markers stay on the text track. `set_silence` is taught in the OUTPUT
 * FORMAT block (Phase 1 scope) and is likewise absent here.
 */

export type CapabilityId =
  | 'search'
  | 'mute'
  | 'unmute'
  | 'add_note'
  | 'del_note'
  | 'clear_notes'
  | 'send_pm'
  | 'roll_dice'
  | 'draw_tarot';

/**
 * All inputs the availability predicates need. Mirrors the parameter set of
 * the legacy `buildProtocols(agent, allAgents, groupAdminIds, hasSearchTool,
 * entertainmentConfig, userName)`.
 */
export interface CapabilityContext {
  agent: Agent;
  allAgents: Agent[];
  groupAdminIds?: string[];
  hasSearchTool?: boolean;
  entertainmentConfig?: EntertainmentConfig;
  userName?: string;
}

export interface CapabilityDef {
  id: CapabilityId;
  /** One-line English description; teaching source for the native-track tool schema (Phase 1). */
  description: string;
  /** JSON Schema for the tool's arguments (native track). Defined only, not consumed in Phase 0. */
  paramsSchema: object;
  /** Whether this capability is offered in the given context. Shared by both tracks. */
  availability: (ctx: CapabilityContext) => boolean;
}

// --- shared availability predicates ---------------------------------------

/** Admin gate: agent's own role is ADMIN, or the group marks it as an admin. */
const isGroupAdmin = (ctx: CapabilityContext): boolean =>
  ctx.agent.role === AgentRole.ADMIN || !!ctx.groupAdminIds?.includes(ctx.agent.id);

/**
 * The 9 capabilities, in a stable order (matches CapabilityId's declaration
 * order). availability predicates reproduce, one-for-one, the branch
 * conditions of the legacy buildProtocols.
 */
export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'search',
    description: 'Search the web for up-to-date information. One search per message.',
    paramsSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query.' } },
      required: ['query'],
      additionalProperties: false,
    },
    availability: (ctx) => !!ctx.hasSearchTool,
  },
  {
    id: 'mute',
    description: 'Mute a group member for a set duration. Admin only. Never mute the User or other admins.',
    paramsSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Member name to mute.' },
        duration: { type: 'string', description: 'One of: 10min, 30min, 1h, 1d.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    availability: isGroupAdmin,
  },
  {
    id: 'unmute',
    description: 'Unmute a previously muted group member. Admin only.',
    paramsSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Member name to unmute.' } },
      required: ['name'],
      additionalProperties: false,
    },
    availability: isGroupAdmin,
  },
  {
    id: 'add_note',
    description: 'Add a note to the shared group notice board. Admin only.',
    paramsSchema: {
      type: 'object',
      properties: { content: { type: 'string', description: 'Note content.' } },
      required: ['content'],
      additionalProperties: false,
    },
    availability: isGroupAdmin,
  },
  {
    id: 'del_note',
    description: 'Delete a note from the group notice board by keyword. Admin only.',
    paramsSchema: {
      type: 'object',
      properties: { keyword: { type: 'string', description: 'Keyword identifying the note to delete.' } },
      required: ['keyword'],
      additionalProperties: false,
    },
    availability: isGroupAdmin,
  },
  {
    id: 'clear_notes',
    description: 'Clear all notes from the group notice board. Admin only.',
    paramsSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    availability: isGroupAdmin,
  },
  {
    id: 'send_pm',
    description: 'Send a private message visible only to a single member. Can be combined with a public message.',
    paramsSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Recipient member name.' },
        content: { type: 'string', description: 'Private message body.' },
      },
      required: ['target', 'content'],
      additionalProperties: false,
    },
    availability: (ctx) => !!(ctx.entertainmentConfig?.enablePM && ctx.agent.enablePM),
  },
  {
    id: 'roll_dice',
    description: 'Roll dice using an XdY+Z expression; the system computes and displays the result.',
    paramsSchema: {
      type: 'object',
      properties: { spec: { type: 'string', description: 'Dice expression, e.g. d20, 2d6+3, d100.' } },
      required: ['spec'],
      additionalProperties: false,
    },
    availability: (ctx) => !!ctx.entertainmentConfig?.enableDice,
  },
  {
    id: 'draw_tarot',
    description: 'Draw N tarot cards; the system shows upright/reversed positions.',
    paramsSchema: {
      type: 'object',
      properties: { count: { type: 'number', description: 'Number of cards to draw.' } },
      additionalProperties: false,
    },
    availability: (ctx) => !!ctx.entertainmentConfig?.enableTarot,
  },
];

const CAPABILITY_BY_ID: Record<CapabilityId, CapabilityDef> = CAPABILITIES.reduce(
  (acc, cap) => {
    acc[cap.id] = cap;
    return acc;
  },
  {} as Record<CapabilityId, CapabilityDef>,
);

export function getCapability(id: CapabilityId): CapabilityDef {
  return CAPABILITY_BY_ID[id];
}

export function isCapabilityAvailable(id: CapabilityId, ctx: CapabilityContext): boolean {
  return getCapability(id).availability(ctx);
}

/** The five admin commands share a single availability gate. */
const ADMIN_CAPABILITY_IDS: CapabilityId[] = ['mute', 'unmute', 'add_note', 'del_note', 'clear_notes'];

/**
 * Render the legacy text-track protocol strings.
 *
 * Output is byte-for-byte identical to the legacy `buildProtocols`. Each
 * segment's availability is decided by the registry's `availability`
 * predicates (never re-derived here); splitProtocol is not a capability and
 * stays a fixed text segment gated by enableSplit, exactly as before.
 *
 * NOTE ON INDENTATION: the whitespace *inside* the backtick templates below is
 * load-bearing — it is part of the emitted string and is copied verbatim from
 * the original source. Do not "fix" the alignment; the snapshot test enforces
 * byte equality.
 */
export function renderTextProtocols(ctx: CapabilityContext): ProtocolStrings {
  const { agent, allAgents, entertainmentConfig, userName } = ctx;
  const has = (id: CapabilityId): boolean => isCapabilityAvailable(id, ctx);

  // --- ADMIN ---
  let adminProtocol = "";
  if (ADMIN_CAPABILITY_IDS.some((id) => has(id))) {
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
  if (has('search')) {
    searchToolProtocol = `
      [SEARCH TOOL]
      Use {{SEARCH: query}} inside {{RESPONSE:}} to search the web. One search per message.
      Example: {{RESPONSE: {{SEARCH: latest AI news}} Let me look that up}}
    `;
  }

  // --- ENTERTAINMENT TOOLS (Dice, Tarot) ---
  let entertainmentProtocol = "";
  if (has('roll_dice') || has('draw_tarot')) {
    const tools: string[] = [];

    if (has('roll_dice')) {
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

    if (has('draw_tarot')) {
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
  if (has('send_pm')) {
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

  // --- SPLIT --- (not a registry capability: pure display marker, plan 2.3)
  const splitProtocol = entertainmentConfig?.enableSplit ? `
- Message split: use [SPLIT] inside your {{RESPONSE:}} to send multiple separate chat bubbles, like a real person typing message by message.
  WARNING: You MUST put ALL [SPLIT] markers inside a SINGLE {{RESPONSE:}} block. Using multiple {{RESPONSE:}} blocks will cause all messages after the first to be SILENTLY DISCARDED and lost.
  CORRECT example:
    {{RESPONSE: Hey everyone[SPLIT]Just wanted to say hi[SPLIT]What are we talking about?}}
  WRONG (messages WILL BE LOST):
    {{RESPONSE: Hey}}{{RESPONSE: Hi}}
    {{RESPONSE: Hey}}[SPLIT]{{RESPONSE: Hi}}
  NOTE: If another member's message looks cut off or incomplete, they likely used multiple {{RESPONSE:}} blocks by mistake and lost part of their output. Do not ask them to repeat — just continue the conversation naturally.
` : '';

  return { adminProtocol, searchToolProtocol, entertainmentProtocol, pmProtocol, splitProtocol };
}
