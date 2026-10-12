// SPDX-License-Identifier: Apache-2.0

/**
 * Exit codes are the only thing a local coding agent can branch on without
 * parsing stderr. Fixed by the polyant-cli contract §9.5 — adding a code is a
 * contract change, not an implementation detail.
 */
export const ExitCode = {
  Ok: 0,
  /** A difference or a failed assertion (`diff`, `check`). Not a tool error. */
  Difference: 1,
  /** Configuration, usage or authentication: 4xx except 429, missing target, absent key. */
  Config: 2,
  /** Remote: 5xx, 429, timeout, unreachable host. Transient, hence retryable. */
  Remote: 3,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/** Base class for every error the CLI raises deliberately: it carries its exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCodeValue,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad usage, unknown target, absent key, unparsable polyant.yaml. */
export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, ExitCode.Config);
  }
}

/** The instance answered with an error status, or could not be reached at all. */
export class RemoteError extends CliError {
  constructor(
    message: string,
    code: ExitCodeValue,
    readonly status?: number,
  ) {
    super(message, code);
  }
}
