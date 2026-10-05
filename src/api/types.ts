// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/**
 * Response shapes, in one module on purpose: every command reads them from here,
 * so the blast radius of an engine change is one file.
 *
 * Hand-written, and staying that way. `/api/docs` on the selected target is the
 * interactive route catalogue and `/api/openapi.json` is its raw contract, but
 * some request body schemas are not yet published. Use the route documentation
 * or engine source for those payloads; only the response fields the CLI actually
 * reads are declared here.
 */

/** GET /health — public, not throttled. */
export interface HealthResponse {
  status: string;
  timestamp: string;
  service: string;
}

/** One entry of GET /api/instances. The DTO carries ~35 fields; these are the ones read. */
export interface AgentSummary {
  slug: string;
  status: string;
  authEnabled: boolean;
}

/** GET /api/instances — wrapped, unlike the three bare-array routes. */
export interface ListAgentsResponse {
  instances: AgentSummary[];
}

export interface ScheduledTask {
  id: string;
  name: string;
  scheduleHuman?: string;
  enabled: boolean;
  nextRunAt: string | null;
  outboundChannel: string | null;
}

export interface ScheduledTasksResponse {
  tasks: ScheduledTask[];
}

export interface OrganizationTask extends ScheduledTask {
  workspace: string;
  agent: string;
}

export interface AgentCheck {
  id: string;
  severity: string;
  titleKey: string;
  bodyKey: string;
  params?: Record<string, string | number>;
  section: string;
  sectionKey: string;
}

export interface AgentChecksResponse {
  instanceId?: string;
  name?: string;
  checks: AgentCheck[];
  dismissed: AgentCheck[];
  tally?: { broken?: number; warning?: number };
}

/** The `/api/instances` DTO fields the agent commands render or diff. */
export interface AgentDetail extends AgentSummary {
  id: string;
  name: string;
  /**
   * The workspace the agent actually lives in, on the detail route only. A slug,
   * never an id. The list route omits it on purpose: every row there is already
   * in the workspace the request resolved.
   *
   * It exists so a read can correct a wrong assumption. `instances.slug` is
   * unique per deployment, so `/api/instances/<slug>` is a complete address and
   * `--workspace` cannot change which agent comes back — without this field the
   * CLI could only echo the flag the operator typed.
   */
  workspaceSlug?: string;
  description: string | null;
  provider: string | null;
  model: string | null;
  effectiveProvider?: string | null;
  effectiveModel?: string | null;
  memoryEnabled: boolean;
  /**
   * How wide the agent's long-term memory reaches: "agent" (one pool for every
   * conversation), "conversation" (a pool per conversation), or "principal"
   * (reserved — the engine stores it but refuses to set it, and resolves it as
   * "conversation" until identity work lands). Absent before the field existed.
   */
  memoryScope?: string;
  knowledgeEnabled: boolean;
  /**
   * Whether the agent is exposed over A2A. Optional: an engine older than 1.1.0
   * does not report it, and a missing field must read as "not exposed" rather
   * than as "unknown" — the panel and the CLI both default it to false.
   */
  a2aEnabled?: boolean;
  /** The speech-to-text provider, "disabled" included. Absent before 1.0.2. */
  sttProvider?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AgentDetailResponse {
  instance: AgentDetail;
}

/** GET/PATCH /api/instances/:slug/prompts — `content` is the section body. */
export interface PromptSection {
  key: string;
  title: string;
  content: string;
}

export interface PromptsResponse {
  prompts: PromptSection[];
}

/** GET/PATCH /api/instances/:slug/tools — `enabled` is the instance's selection. */
export interface ToolEntry {
  name: string;
  description: string | null;
  category: string | null;
  enabled: boolean;
  source: string | null;
}

export interface ToolsResponse {
  tools: ToolEntry[];
  /** Engine 1.2.0: the plugins behind the served tools, keyed by tool namespace. */
  plugins?: { namespace: string; name: string; version: string }[];
}

/**
 * GET /api/instances/:slug/channels. Sensitive `config` values arrive masked as
 * `••••…`; the CLI reports key names only and never echoes a value.
 */
export interface ChannelEntry {
  channelType: string;
  enabled: boolean;
  config: Record<string, unknown>;
  /**
   * `false` only when the stored config failed to decrypt — a rotated
   * ENCRYPTION_KEY — never when it is simply empty. Without it an unreadable
   * channel renders exactly like an unconfigured one, which is the difference
   * an operator is looking for. Optional: an engine that predates it reports
   * nothing, and absent must read as readable rather than as broken.
   */
  configReadable?: boolean;
  /** Why the ENGINE disabled this channel, or null when a person did (or nobody). */
  disabledReason?: string | null;
  disabledAt?: string | null;
}

export interface ChannelsResponse {
  channels: ChannelEntry[];
}

/**
 * GET/PUT /api/instances/:slug/secrets. The engine reports presence, never the
 * value — the same discipline the CLI applies to channel configuration. The key
 * set varies per agent with its tools and channels, so it is read, not assumed.
 */
export interface AgentSecret {
  key: string;
  configured: boolean;
}

export interface SecretsResponse {
  secrets: AgentSecret[];
}

/** GET /api/instances/:slug/hooks — the store row, returned unwrapped per hook. */
export interface HookEntry {
  id: string;
  event: string;
  actionType: string;
  enabled: boolean;
  position: number;
  timeoutMs: number;
}

export interface HooksResponse {
  hooks: HookEntry[];
}

/** GET /api/conversations — `instanceId` carries the agent slug, not a UUID. */
export interface ConversationSummary {
  conversationId: string;
  title: string | null;
  channel: string | null;
  instanceId: string | null;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
  updatedAt: string | null;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  total: number;
}

/**
 * One model step inside an assistant message, as
 * `GET /api/conversations/:id/messages` carries it. The DTO holds the step's
 * text, reasoning, token counts and duration too; these are the fields read.
 * Every one is optional on purpose: rows written before the engine persisted
 * steps are backfilled with `legacy: true` and carry no tool calls.
 */
export interface MessageStep {
  toolCalls?: { toolCallId: string; toolName: string; args: unknown }[];
  toolResults?: { toolCallId: string; result: unknown }[];
}

/** GET /api/organizations — a management key sees only its own organisation. */
export interface OrganizationSummary {
  id: string;
  slug: string;
  name: string;
  isDefault?: boolean;
}

export interface OrganizationsResponse {
  organizations: OrganizationSummary[];
}

/** GET /api/organizations/:orgSlug/workspaces. */
export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkspacesResponse {
  workspaces: WorkspaceSummary[];
}

/** GET /api/organizations/:orgSlug/members. */
export interface MemberSummary {
  userId: string;
  email: string;
  name: string | null;
  roleKey: string | null;
}

export interface MembersResponse {
  members: MemberSummary[];
}

/** GET /api/organizations/:orgSlug/roles — custom roles; the system roles are separate. */
export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description?: string | null;
  permissions?: string[];
}

export interface RolesResponse {
  roles: RoleSummary[];
}

/** GET /api/organizations/:orgSlug/roles/permissions — the grantable permission keys. */
export interface RolePermissionsResponse {
  permissions: string[];
}

/** GET /api/audit-logs — one recorded tool action. */
export interface AuditLogRow {
  id: string;
  instanceId: string;
  conversationId: string | null;
  toolName: string;
  action: string;
  /** The assistant message this tool call served, when the engine recorded one. */
  messageId: string | null;
  success: boolean;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
}

export interface AuditLogListResponse {
  items: AuditLogRow[];
  total: number;
  limit: number;
  offset: number;
}

/** GET /api/audit-logs/stats. */
export interface AuditStatsResponse {
  totalEntries: number;
  errorCount: number;
  errorRate: number;
  byTool: { toolName: string; count: number }[];
  byAction: { action: string; count: number }[];
}

/** GET /api/ai-logs — one row per LLM call, unfiltered by outcome. */
export interface AiLogRow {
  id: string;
  provider: string;
  model: string;
  tier: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
  conversationId: string | null;
  instanceId: string | null;
  callType: string;
  outcome: string;
  errorKind: string | null;
  thinking: boolean;
  reasoningChars: number;
  stepCount: number;
  createdAt: string;
}

export interface AiLogListResponse {
  items: AiLogRow[];
  /** Counted over at most 10001 rows. A floor, not the row count, when capped. */
  total: number;
  /** True when `total` came back AT the engine's count ceiling. */
  totalIsCapped?: boolean;
  limit: number;
  offset: number;
}

/** GET /api/pipeline-traces — one row per turn, with its phase breakdown. */
export interface TraceRow {
  id: string;
  conversationId: string;
  instanceId: string;
  channel: string;
  llmCallMs: number | null;
  totalMs: number;
  ttfbMs: number | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
}

export interface TraceListResponse {
  items: TraceRow[];
  /** Counted over at most 10001 rows. A floor, not the row count, when capped. */
  total: number;
  /** True when `total` came back AT the engine's count ceiling. */
  totalIsCapped?: boolean;
  limit: number;
  offset: number;
}

/** GET /api/messages — messages across one agent's conversations. */
export interface MessageRow {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
}

export interface MessageListResponse {
  items: MessageRow[];
  /** Counted over at most 10001 rows. A floor, not the row count, when capped. */
  total: number;
  /** True when `total` came back AT the engine's count ceiling. */
  totalIsCapped?: boolean;
  limit: number;
  offset: number;
}

/**
 * One event of GET /api/activity-stream/live. Only the fields the live view
 * prints are declared; the engine caps every preview server-side.
 */
export interface FeedEvent {
  id: string;
  ts: string;
  persona: string;
  text: string;
  category?: string;
  status?: string;
  durationMs?: number;
  conversationId?: string;
  instance?: { slug: string; name: string };
  tool?: { name: string; summary: string };
}

/** GET /api/analytics and GET /api/instances/:slug/analytics. */
export interface AnalyticsResponse {
  overview: {
    totalCost: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
    cachedInputTokens: number;
    totalConversations: number;
    totalMessages: number;
    uniqueUsers: number;
    avgCostPerConversation: number;
    avgResponseTime: number;
  };
  dailyTrend: { date: string; cost: number; tokens: number; conversations: number; messages: number }[];
  channelDistribution: { channel: string; conversations: number; messages: number }[];
  modelDistribution: { provider: string; model: string; calls: number; tokens: number; cost: number; avgDuration: number }[];
  toolUsage: { tool: string; count: number }[];
  instanceComparison?: { instanceId: string; name: string; conversations: number; cost: number; tokens: number }[];
  latency: {
    overview: { p50: number; p95: number; p99: number; avgTotal: number; avgTtfb: number | null; sampleCount: number };
    slowestTools: { tool: string; avgDurationMs: number; callCount: number; p95: number; successRate: number }[];
  };
}
