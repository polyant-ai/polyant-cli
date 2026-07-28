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
