// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/**
 * Response shapes, in one module on purpose: when the engine serves an OpenAPI
 * spec (phase 0b) this file is regenerated and no command has to change.
 * Only the fields the CLI actually reads are declared.
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
  description: string | null;
  provider: string | null;
  model: string | null;
  memoryEnabled: boolean;
  knowledgeEnabled: boolean;
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
