/**
 * 手机远程动作通道的契约（PHONE_ACTIONS_PLAN.md §2.2–2.6）。
 *
 * 三方共用：服务端 `server/live.ts`（形状校验、限流、转发）、电脑端 `services/liveBridge.ts` + `App.tsx`
 * （语义校验、执行、回传结果）、手机端 `viewer/`（发起、等待结果）。
 *
 * 放在 server/ 下是因为 tsconfig.node.json 是 composite 工程，服务端只能 import 它 include 范围内的文件；
 * 前端没有这个限制，直接相对路径 import 即可。本文件只能有类型与纯常量，不许 import node 内置模块或任何前端模块。
 */

// ---- 动作类型 ----

export const ACTION_TYPES = [
  'message.send',
  'session.switch',
  'group.member.add',
  'group.member.remove',
  'agent.mute',
  'agent.unmute',
  'agent.trigger',
  'agent.update',
  'agent.create',
  'group.create',
  'session.create',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/** 会话级动作：payload.sessionId 必填，且必须等于电脑当前会话（否则 409 not-active-session）。 */
export const SESSION_SCOPED_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'message.send',
  'session.switch',
  'group.member.add',
  'group.member.remove',
  'agent.mute',
  'agent.unmute',
  'agent.trigger',
]);

// ---- 长度与范围上限（服务端与电脑端都按这张表校验，手机端可用于提交前预检） ----

export const ACTION_LIMITS = {
  id: 128,              // 任何 id 字段（sessionId / agentId / providerId / modelId / replyToId / pmTargetId）
  text: 20000,          // message.send 的正文字符数
  name: 100,            // agent 名字
  systemPrompt: 64000,  // 提示词字符数
  color: 64,
  avatar: 2000,         // 头像是 emoji 或短 URL/data 片段，不接受大图
  muteMaxMinutes: 10080, // 7 天；0 = 永久
  maxTokensMax: 200000,
  reasoningBudgetMax: 200000,
  attachmentBytes: 4 * 1024 * 1024, // 单张图片**解码后**的字节上限
  attachmentsPerMessage: 4,         // 一条 message.send 最多几张图
  fileName: 200,                    // 附件原始文件名
} as const;

/**
 * 带附件的 `message.send` 允许的请求体上限（其余动作仍走 `SMALL_BODY_BYTES` = 64 KB）。
 * 4 张 × 4 MB 解码后 ≈ 16 MB，base64 膨胀 4/3 ≈ 21.3 MB，再留一点 JSON 外壳的余量。
 */
export const ACTION_BODY_BYTES_WITH_ATTACHMENTS = 24 * 1024 * 1024;

/** 附件只收这四种图片类型（`data` 的魔数必须与之对得上，服务端会验）。 */
export const ACTION_ATTACHMENT_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;

export type ActionAttachmentMimeType = (typeof ACTION_ATTACHMENT_MIME_TYPES)[number];

/**
 * 手机上传的图片附件。
 * `data` 是**纯 base64**，不带 `data:image/…;base64,` 前缀——前缀里的 mimeType 会和这里的字段打架，
 * 只留一个来源。电脑端拼回 data URL 再交给 `appendUserMessage`。
 */
export interface ActionAttachment {
  mimeType: ActionAttachmentMimeType;
  data: string;
  fileName?: string;
}

/** 独立于 inbox / control 的限流桶：每个来源地址每分钟最多 30 次动作。 */
export const ACTION_RATE_WINDOW_MS = 60_000;
export const ACTION_MAX_PER_WINDOW = 30;

/** 手机端等待 action-result 的超时（比 control 的 4 s 长：agent.trigger 之类要等 handler 真正返回）。 */
export const ACTION_RESULT_TIMEOUT_MS = 8_000;

// ---- payload ----

export interface MessageSendPayload {
  text: string;
  pmTargetId?: string;   // 群成员 agentId；手机端不需要给 'user'
  replyToId?: string;
  parseCommands?: boolean; // 默认 false，与 inbox 一致
  /**
   * 图片附件（≤ ACTION_LIMITS.attachmentsPerMessage 张）。
   * 有附件时 `text` 允许是空串——「只发图不说话」是手机上很常见的一发，
   * 与电脑端 `handleUserSend`（`!inputText.trim() && attachments.length === 0` 才拦）一致。
   */
  attachments?: ActionAttachment[];
}

export type EmptyPayload = Record<string, never>;

export interface AgentIdPayload {
  agentId: string;
}

export interface AgentMutePayload {
  agentId: string;
  durationMinutes: number; // 整数，0 = 永久，≤ ACTION_LIMITS.muteMaxMinutes
}

/** agent.update 允许修改的字段白名单。任何不在这里的键服务端直接 400（尤其 searchConfig / voice* 等凭据或私有配置）。 */
export interface AgentPatch {
  name?: string;
  systemPrompt?: string;
  providerId?: string;
  modelId?: string;
  color?: string;
  avatar?: string;
  config?: {
    temperature?: number | null;
    topP?: number | null;
    maxTokens?: number;
    enableReasoning?: boolean;
    reasoningBudget?: number;
  };
  role?: 'MEMBER' | 'ADMIN';
  mentionOnly?: boolean;
  enablePM?: boolean;
  commandMode?: 'native' | 'text';
}

export const AGENT_PATCH_KEYS: ReadonlyArray<keyof AgentPatch> = [
  'name', 'systemPrompt', 'providerId', 'modelId', 'color', 'avatar', 'config',
  'role', 'mentionOnly', 'enablePM', 'commandMode',
];

export const AGENT_PATCH_CONFIG_KEYS: ReadonlyArray<keyof NonNullable<AgentPatch['config']>> = [
  'temperature', 'topP', 'maxTokens', 'enableReasoning', 'reasoningBudget',
];

export interface AgentUpdatePayload {
  agentId: string;
  patch: AgentPatch;
}

export interface AgentCreatePayload {
  providerId: string;
  modelId: string;
  name?: string;
  systemPrompt?: string;
  joinActiveGroup?: boolean; // 为真时创建后立即 handleActivateAgent（加入电脑当前群）
}

/** 新建群组。名字留空（或只有空白）= 用电脑端自己的默认名「群组 N」。 */
export interface GroupCreatePayload {
  name?: string;
}

/**
 * 在指定群里新建一条会话。
 * `groupId` 是显式参数而不是「电脑当前群」：手机的会话列表本来就按群分组，
 * 每个群标题旁边都有一颗「+」，要求先把电脑切过去反而绕。所以它不是会话级动作。
 */
export interface SessionCreatePayload {
  groupId: string;
  name?: string;
}

export interface ActionPayloadMap {
  'message.send': MessageSendPayload;
  'session.switch': EmptyPayload;
  'group.member.add': AgentIdPayload;
  'group.member.remove': AgentIdPayload;
  'agent.mute': AgentMutePayload;
  'agent.unmute': AgentIdPayload;
  'agent.trigger': AgentIdPayload;
  'agent.update': AgentUpdatePayload;
  'agent.create': AgentCreatePayload;
  'group.create': GroupCreatePayload;
  'session.create': SessionCreatePayload;
}

// ---- 线上形状 ----

/** 手机 → 服务端：POST /api/live/action 的请求体。 */
export interface ActionRequest<T extends ActionType = ActionType> {
  id?: string;          // 手机自拟；服务端会换成自己的 id 并在 202 响应里返回
  type: T;
  sessionId?: string;   // SESSION_SCOPED_ACTIONS 必填；session.switch 时是目标会话
  payload: ActionPayloadMap[T];
}

/** 服务端 → 电脑：SSE `action` 事件的 data。 */
export interface ActionEvent<T extends ActionType = ActionType> {
  id: string;
  type: T;
  sessionId?: string;
  payload: ActionPayloadMap[T];
  receivedAt: number;
}

/** 电脑 → 服务端：POST /api/live/action-result（仅 loopback）；服务端原样广播为 SSE `action-result` 给非 desktop 客户端。 */
export interface ActionResult {
  id: string;
  ok: boolean;
  error?: string;                 // 机器可读短码，如 'not-active-session' | 'agent-not-found' | 'invalid-model' | 'busy'
  // 只放 id 类信息，不放内容体。group.create 两个都回：groupId 是新群，sessionId 是它附带的第一条会话。
  data?: { agentId?: string; messageId?: string; sessionId?: string; groupId?: string };
}

/** 服务端 → 全部客户端：agents / groups / settings 三张表任一被 PUT 后广播，手机端据此重拉 bootstrap。 */
export interface CatalogEvent {
  table: 'agents' | 'groups' | 'settings';
  at: number;
}

/** 服务端对 POST /api/live/action 的错误响应体。 */
export interface ActionErrorBody {
  error: 'bad-request' | 'desktop-offline' | 'not-active-session' | 'rate-limited';
  field?: string;   // bad-request 时指出是哪个字段
}
