
import { Type } from '@google/genai';
import type { FunctionDeclaration, Schema } from '@google/genai';
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

/**
 * Unified intermediate representation of a native-track tool invocation.
 *
 * The native track (Phase 1: Gemini `functionCall` parts) decodes each tool call
 * into this shape and hands it to App.tsx via `StreamChunk.toolCalls`. App.tsx
 * then maps it onto the same `detected*` variables the text-track regex parser
 * fills, so both tracks converge on one unchanged dispatch path. Defined here as
 * the single source of truth; types.ts re-exports it via `import type`.
 */
export interface CapabilityCall {
  capability: string;
  args: Record<string, unknown>;
}

/** Command mode for an agent: legacy text protocol, or native function calling. */
export type CommandMode = 'text' | 'native';

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
    description: 'Search the web for up-to-date information. Results are posted into the group chat for all members to see and discuss. One search per message.',
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

// --- native track (Phase 1) -----------------------------------------------

/**
 * Capabilities that are tool-ified on the native track. Phase 1 wires only
 * `search`; every other capability stays on the text track even for native
 * agents (see renderTextProtocols native branch), so a native agent never
 * loses a capability. This is the single list both consumers reference:
 *   - renderToolSchemas emits exactly this set (∩ availability);
 *   - renderTextProtocols suppresses exactly this set when mode === 'native'.
 * Phase 2 extends this array and both sides follow automatically.
 */
const NATIVE_TOOL_IDS: CapabilityId[] = ['search'];

/** JSON-Schema primitive type name → Gemini OpenAPI `Type` enum member (UPPERCASE). */
const JSON_TYPE_TO_GEMINI: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

/**
 * Convert a generic JSON Schema (CapabilityDef.paramsSchema) into a Gemini
 * `Schema` (OpenAPI 3.0 subset). Fields Gemini does not support — notably
 * `additionalProperties` — are dropped by construction: only the recognised
 * keys are copied, and `type` is mapped from lowercase JSON-Schema names to the
 * UPPERCASE `Type` enum the SDK's `.d.ts` requires. Nested object properties and
 * array items are converted recursively.
 */
function toGeminiSchema(node: Record<string, any>): Schema {
  const schema: Schema = {};
  if (typeof node.type === 'string') {
    const mapped = JSON_TYPE_TO_GEMINI[node.type.toLowerCase()];
    if (mapped) schema.type = mapped;
  }
  if (typeof node.description === 'string') schema.description = node.description;
  if (Array.isArray(node.enum)) schema.enum = node.enum;
  if (node.properties && typeof node.properties === 'object') {
    const props: Record<string, Schema> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      props[key] = toGeminiSchema(value as Record<string, any>);
    }
    schema.properties = props;
  }
  if (Array.isArray(node.required)) schema.required = node.required;
  if (node.items && typeof node.items === 'object') schema.items = toGeminiSchema(node.items as Record<string, any>);
  return schema;
}

/**
 * Render the native-track tool schemas for a provider `kind`.
 *
 * Phase 1 implements only the Gemini kind. A capability is emitted as a native
 * tool only when it is BOTH native-tool-ified (NATIVE_TOOL_IDS) AND available in
 * this context — so the offered tools match exactly what App.tsx dispatches, and
 * no capability is ever exposed on both the tool track and the text track at once.
 */
export function renderToolSchemas(ctx: CapabilityContext, kind: 'gemini'): FunctionDeclaration[] {
  if (kind !== 'gemini') return [];
  return CAPABILITIES
    .filter((cap) => NATIVE_TOOL_IDS.includes(cap.id) && cap.availability(ctx))
    .map((cap) => ({
      name: cap.id,
      description: cap.description,
      parameters: toGeminiSchema(cap.paramsSchema as Record<string, any>),
    }));
}

/**
 * Render the text-track protocol strings.
 *
 * In the default `'text'` mode the output is byte-for-byte identical to the
 * legacy `buildProtocols`. Each segment's availability is decided by the
 * registry's `availability` predicates (never re-derived here); splitProtocol is
 * not a capability and stays a fixed text segment gated by enableSplit, exactly
 * as before.
 *
 * In `'native'` mode: capabilities in NATIVE_TOOL_IDS (Phase 1: search) are NOT
 * emitted as text — they live in the tool schema instead. The remaining segments
 * (admin / entertainment / pm / split) are still emitted so a native agent keeps
 * every capability, but their wording drops the `{{RESPONSE:}}` wrapper phrasing
 * (there is no wrapper on the native track). The instruction token formats
 * themselves (e.g. `{{MUTE: ...}}`) are unchanged across modes.
 *
 * NOTE ON INDENTATION: the whitespace *inside* the `'text'`-mode backtick
 * templates below is load-bearing — it is part of the emitted string and is
 * copied verbatim from the original source. Do not "fix" the alignment; the
 * snapshot test enforces byte equality for text mode.
 */
export function renderTextProtocols(ctx: CapabilityContext, mode: CommandMode = 'text'): ProtocolStrings {
  const { agent, allAgents, entertainmentConfig, userName } = ctx;
  const has = (id: CapabilityId): boolean => isCapabilityAvailable(id, ctx);
  // A capability that is tool-ified on the native track is NOT taught as text for
  // native agents (its teaching lives in the tool schema). Text agents: unaffected.
  const nativeToolified = (id: CapabilityId): boolean => mode === 'native' && NATIVE_TOOL_IDS.includes(id);

  // --- ADMIN ---
  let adminProtocol = "";
  if (ADMIN_CAPABILITY_IDS.some((id) => has(id))) {
    // Only the "where to put it" phrasing differs by mode; the command tokens are identical.
    const adminWhere = mode === 'native'
      ? 'You are a group admin. Available commands (place directly in your reply):'
      : 'You are a group admin. Available commands (inside {{RESPONSE:}}):';
    adminProtocol = `
      [ADMIN COMMANDS]
      ${adminWhere}
      {{MUTE: Name, Duration}} (10min/30min/1h/1d) | {{UNMUTE: Name}}
      {{NOTE: content}} | {{DELNOTE: keyword}} | {{CLEARNOTES}}
      Never mute the User or other admins.
      `;
  }

  // --- SEARCH TOOL --- (native track: tool-ified via NATIVE_TOOL_IDS, so suppressed here)
  let searchToolProtocol = "";
  if (has('search') && !nativeToolified('search')) {
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

    entertainmentProtocol = mode === 'native' ? `
    [ENTERTAINMENT TOOLS]
    This chat has the following entertainment features enabled. Use directly in your reply:
    ${tools.join('\n')}

    Usage examples:
    Let me roll the dice {{ROLL: d20}}
    Drawing a tarot card for you {{TAROT: 1}}
    ` : `
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
    pmProtocol = mode === 'native' ? `
    [PRIVATE MESSAGE]
    Send a PM visible only to one member: {{RES_PM_Name: message}}
    Can combine with a public message: write your public text directly, then append {{RES_PM_Name: private text}}
    Available targets: ${pmTargetNames}
    One PM target per turn. The {{RES_PM_Name: ...}} marker goes directly in your reply.
    ` : `
    [PRIVATE MESSAGE]
    Send a PM visible only to one member: {{RES_PM_Name: message}}
    Can combine with public message: {{RESPONSE: public text}}{{RES_PM_Name: private text}}
    Available targets: ${pmTargetNames}
    One PM target per turn. Do NOT wrap PM inside {{RESPONSE:}}.
    `;
  }

  // --- SPLIT --- (not a registry capability: pure display marker, plan 2.3)
  let splitProtocol = "";
  if (entertainmentConfig?.enableSplit) {
    splitProtocol = mode === 'native' ? `
- Message split: use [SPLIT] in your reply to send multiple separate chat bubbles, like a real person typing message by message.
  Put every [SPLIT] marker in your single reply; each segment between markers becomes its own bubble.
  Example:
    Hey everyone[SPLIT]Just wanted to say hi[SPLIT]What are we talking about?
  NOTE: If another member's message looks cut off or incomplete, they may have split their output. Do not ask them to repeat — just continue the conversation naturally.
` : `
- Message split: use [SPLIT] inside your {{RESPONSE:}} to send multiple separate chat bubbles, like a real person typing message by message.
  WARNING: You MUST put ALL [SPLIT] markers inside a SINGLE {{RESPONSE:}} block. Using multiple {{RESPONSE:}} blocks will cause all messages after the first to be SILENTLY DISCARDED and lost.
  CORRECT example:
    {{RESPONSE: Hey everyone[SPLIT]Just wanted to say hi[SPLIT]What are we talking about?}}
  WRONG (messages WILL BE LOST):
    {{RESPONSE: Hey}}{{RESPONSE: Hi}}
    {{RESPONSE: Hey}}[SPLIT]{{RESPONSE: Hi}}
  NOTE: If another member's message looks cut off or incomplete, they likely used multiple {{RESPONSE:}} blocks by mistake and lost part of their output. Do not ask them to repeat — just continue the conversation naturally.
`;
  }

  return { adminProtocol, searchToolProtocol, entertainmentProtocol, pmProtocol, splitProtocol };
}
