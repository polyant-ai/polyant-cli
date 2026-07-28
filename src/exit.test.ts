// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect } from "vitest";
import { ExitCode, CliError, ConfigError, RemoteError } from "./exit.js";

describe("exit codes", () => {
  it("should_use_the_contracted_number_for_every_code", () => {
    expect(ExitCode.Ok).toBe(0);
    expect(ExitCode.Difference).toBe(1);
    expect(ExitCode.Config).toBe(2);
    expect(ExitCode.Remote).toBe(3);
  });

  it("should_carry_code_2_when_a_config_error_is_raised", () => {
    const err = new ConfigError("no target");
    expect(err).toBeInstanceOf(CliError);
    expect(err.code).toBe(ExitCode.Config);
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("no target");
  });

  it("should_carry_status_and_code_when_a_remote_error_is_raised", () => {
    const err = new RemoteError("service unavailable", ExitCode.Remote, 503);
    expect(err.code).toBe(ExitCode.Remote);
    expect(err.status).toBe(503);
    expect(err.name).toBe("RemoteError");
  });
});
