
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
 * pure markers stay on the text track — they carry no structured parameters, so
 * tool-ifying them buys nothing and the text detection is inherited for free.
 * `set_silence` DOES take a (structured, constrained) duration, so as of Phase 2
 * it is a capability and a native tool; only its text teaching lives in the
 * OUTPUT FORMAT block (shared.ts), suppressed there for native agents.
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

/**
 * Resolve an agent's effective command mode. Native is the DEFAULT (Sol,
 * 2026-07-10: few models lack function calling now) — an unset commandMode
 * means native; only an explicit 'text' opts into the legacy protocol
 * (for older models / tool-stripping proxies).
 */
export function getCommandMode(agent: Pick<Agent, 'commandMode'>): CommandMode {
  return agent.commandMode === 'text' ? 'text' : 'native';
}

export type CapabilityId =
  | 'search'
  | 'mute'
  | 'unmute'
  | 'add_note'
  | 'del_note'
  | 'clear_notes'
  | 'set_silence'
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
 * The 10 capabilities, in a stable order (matches CapabilityId's declaration
 * order — the order also fixes the native tool array, which matters for
 * Anthropic's prompt-cache prefix). availability predicates reproduce,
 * one-for-one, the branch conditions of the legacy buildProtocols; `set_silence`
 * is the one capability with no legacy availability gate — any member may
 * self-mute (matches the always-taught {{SILENCE}} text marker).
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
    id: 'set_silence',
    description: 'Mute yourself and stop participating for a while. Any member may use this. Omit duration for an indefinite self-mute.',
    paramsSchema: {
      type: 'object',
      properties: {
        duration: { type: 'string', description: 'One of: 10min, 30min, 1h, 1d. Omit to self-mute indefinitely.' },
      },
      additionalProperties: false,
    },
    availability: () => true,
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
 * Capabilities that are tool-ified on the native track. Phase 2 extends this to
 * the FULL set — every registry capability is now a native tool. This is the
 * single list both consumers reference:
 *   - renderToolSchemas emits exactly this set (∩ availability);
 *   - renderTextProtocols suppresses exactly this set when mode === 'native'.
 * (PASS / REPLY / [SPLIT] are not registry capabilities and never appear here;
 * they always travel the text track — see plan 2.3.)
 */
const NATIVE_TOOL_IDS: CapabilityId[] = [
  'search',
  'mute',
  'unmute',
  'add_note',
  'del_note',
  'clear_notes',
  'set_silence',
  'send_pm',
  'roll_dice',
  'draw_tarot',
];

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

/** Provider dialects the native tool schemas can be rendered into. */
export type ToolSchemaKind = 'gemini' | 'anthropic' | 'openai-chat' | 'openai-responses';

/**
 * Render the native-track tool schemas for a provider `kind`.
 *
 * A capability is emitted as a native tool only when it is BOTH native-tool-ified
 * (NATIVE_TOOL_IDS) AND available in this context — so the offered tools match
 * exactly what App.tsx dispatches, and no capability is ever exposed on both the
 * tool track and the text track at once. The filtered set is shared across all
 * dialects; only the per-tool shape differs:
 *   - gemini:           SDK `FunctionDeclaration` (types mapped, additionalProperties dropped)
 *   - anthropic:        `{ name, description, input_schema }` (raw JSON Schema)
 *   - openai-chat:      `{ type:'function', function:{ name, description, parameters } }`
 *   - openai-responses: `{ type:'function', name, description, parameters }` (top-level, matches image_generation array)
 */
export function renderToolSchemas(ctx: CapabilityContext, kind: 'gemini'): FunctionDeclaration[];
export function renderToolSchemas(ctx: CapabilityContext, kind: 'anthropic' | 'openai-chat' | 'openai-responses'): Record<string, unknown>[];
export function renderToolSchemas(ctx: CapabilityContext, kind: ToolSchemaKind): FunctionDeclaration[] | Record<string, unknown>[] {
  const caps = CAPABILITIES.filter((cap) => NATIVE_TOOL_IDS.includes(cap.id) && cap.availability(ctx));
  switch (kind) {
    case 'gemini':
      return caps.map((cap) => ({
        name: cap.id,
        description: cap.description,
        parameters: toGeminiSchema(cap.paramsSchema as Record<string, any>),
      }));
    case 'anthropic':
      return caps.map((cap) => ({
        name: cap.id,
        description: cap.description,
        input_schema: cap.paramsSchema,
      }));
    case 'openai-chat':
      return caps.map((cap) => ({
        type: 'function',
        function: { name: cap.id, description: cap.description, parameters: cap.paramsSchema },
      }));
    case 'openai-responses':
      return caps.map((cap) => ({
        type: 'function',
        name: cap.id,
        description: cap.description,
        parameters: cap.paramsSchema,
      }));
    default:
      return [];
  }
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
 * In `'native'` mode: capabilities in NATIVE_TOOL_IDS (Phase 2: the full set —
 * search / admin / entertainment / pm) are NOT emitted as text — their teaching
 * lives in the tool-schema `description` instead. Only `splitProtocol` survives
 * on the native track (`[SPLIT]` is a pure display marker, not a capability). The
 * `nativeToolified` guard on each segment's condition below is what enforces this;
 * because every registry capability is now tool-ified, native mode yields empty
 * admin/search/entertainment/pm segments. Text mode is byte-for-byte unaffected
 * (nativeToolified is always false there), so the internal native/text ternaries
 * that remain in the entertainment/pm/admin templates are dead on the native
 * track and always resolve to their text branch on the text track.
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

  // --- ADMIN --- (native track: all five commands tool-ified, so suppressed here)
  let adminProtocol = "";
  if (ADMIN_CAPABILITY_IDS.some((id) => has(id) && !nativeToolified(id))) {
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

  // --- ENTERTAINMENT TOOLS (Dice, Tarot) --- (native track: tool-ified, suppressed here)
  let entertainmentProtocol = "";
  if ((has('roll_dice') && !nativeToolified('roll_dice')) || (has('draw_tarot') && !nativeToolified('draw_tarot'))) {
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

  // --- PM (Private Message) --- (native track: tool-ified via send_pm, suppressed here)
  let pmProtocol = "";
  if (has('send_pm') && !nativeToolified('send_pm')) {
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
