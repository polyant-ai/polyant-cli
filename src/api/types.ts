// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/**
 * Response shapes, in one module on purpose: every command reads them from here,
 * so the blast radius of an engine change is one file.
 *
 * Hand-written, and staying that way. The engine's OpenAPI document
 * (`/api/openapi.json`) declares no schemas — it is hand-built without
 * @nestjs/swagger — so generating from it would produce `unknown` for every body
 * and response. Only the fields the CLI actually reads are declared.
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
  memoryEnabled: boolean;
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
}

/**
 * GET /api/instances/:slug/channels. Sensitive `config` values arrive masked as
 * `••••…`; the CLI reports key names only and never echoes a value.
 */
export interface ChannelEntry {
  channelType: string;
  enabled: boolean;
  config: Record<string, unknown>;
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
