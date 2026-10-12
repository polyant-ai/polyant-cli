// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { ApiResponse } from "../api/client.js";
import { ExitCode, RemoteError } from "../exit.js";
import type { DevCommandDependencies } from "./dev.js";
import { devContext, devHarness, leaf, response } from "./dev.test-harness.js";

describe("dev token issue", () => {
  const ISSUED = { token: "pdt_live_secret", expiresAt: "2026-09-04T10:00:00.000Z" };

  it("sends the TTL and prints the token on stdout, alone", async () => {
    const h = devHarness([response(ISSUED)]);

    await leaf(h.command, ["token", "issue"])(["acme", "--ttl-hours", "4"], devContext({ yes: true }));

    expect(h.calls[0]).toMatchObject({
      method: "POST",
      path: "/api/instances/acme/dev-session/token",
      body: { ttlHours: 4 },
    });
    // stdout is the answer: exactly the token, nothing to strip.
    expect(h.out.join("")).toBe("pdt_live_secret\n");
    expect(h.err.join("")).toContain("Shown once");
  });

  it("omits ttlHours entirely when the operator did not choose one", async () => {
    const h = devHarness([response(ISSUED)]);

    await leaf(h.command, ["token", "issue"])(["acme"], devContext({ yes: true }));

    expect(h.calls[0]?.body).toEqual({});
  });

  // The engine's bound is 1..24. Sending 48 would spend a round trip to be told
  // so, on a route that answers with a credential.
  it.each(["0", "25", "4.5", "-1"])("refuses --ttl-hours %s locally", async (value) => {
    const h = devHarness([]);

    await expect(leaf(h.command, ["token", "issue"])(["acme", "--ttl-hours", value], devContext({ yes: true }))).rejects.toThrow(
      /--ttl-hours needs an integer between 1 and 24/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("recaps that issuing invalidates the previous token and closes the session", async () => {
    const h = devHarness([]);

    await leaf(h.command, ["token", "issue"])(["acme"], devContext({ dryRun: true }));

    const recap = h.err.join("");
    expect(recap).toContain("Invalidate every dev token previously issued");
    expect(recap).toContain("Close the live dev session");
    expect(h.calls).toHaveLength(0);
    expect(h.out.join("")).toBe("");
  });

  it("passes the engine's body through under --json, token included", async () => {
    const h = devHarness([response(ISSUED)]);

    await leaf(h.command, ["token", "issue"])(["acme"], devContext({ yes: true, json: true }));

    expect(h.out.join("")).toBe(JSON.stringify(ISSUED));
  });

  it("needs an agent slug", async () => {
    const h = devHarness([]);

    await expect(leaf(h.command, ["token", "issue"])(["--ttl-hours", "2"], devContext({ yes: true }))).rejects.toThrow(
      /polyant-cli dev token issue needs an agent slug/,
    );
  });
});

describe("dev token revoke", () => {
  it("is destructive: it names the agent twice", async () => {
    const h = devHarness([]);

    await expect(leaf(h.command, ["token", "revoke"])(["acme"], devContext({ yes: true }))).rejects.toThrow(
      /--confirm acme is required/,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("deletes the tokens and reports how many were revoked", async () => {
    const h = devHarness([response({ revoked: 2 })]);

    await leaf(h.command, ["token", "revoke"])(["acme", "--confirm", "acme"], devContext({ yes: true }));

    expect(h.calls[0]).toMatchObject({ method: "DELETE", path: "/api/instances/acme/dev-session/token" });
    expect(h.out.join("")).toContain("Revoked 2 dev token(s) for acme.");
  });
});

describe("dev token status", () => {
  const LIVE = {
    session: {
      sessionId: "ds_1",
      connectedAt: "2026-09-03T09:00:00.000Z",
      issuedByUserId: "user-1",
      tools: ["local_echo", "webSearch"],
      overrides: ["webSearch"],
    },
    nodeWarning: true,
  };

  it("names the served tools and the ones that shadow a built-in", async () => {
    const h = devHarness([response(LIVE)]);

    await leaf(h.command, ["token", "status"])(["acme"], devContext());

    expect(h.calls[0]).toMatchObject({ path: "/api/instances/acme/dev-session" });
    const table = h.out.join("");
    expect(table).toContain("local_echo, webSearch");
    expect(table).toMatch(/overrides:\s+webSearch/);
  });

  // The caveat is a property of the deployment, not of this response: it is
  // reported whenever the engine sets it, session or no session.
  it("reports the single-node caveat on stderr, with and without a session", async () => {
    const live = devHarness([response(LIVE)]);
    await leaf(live.command, ["token", "status"])(["acme"], devContext());
    expect(live.err.join("")).toContain("ONE engine node");

    const idle = devHarness([response({ session: null, nodeWarning: true })]);
    await leaf(idle.command, ["token", "status"])(["acme"], devContext());
    expect(idle.out.join("")).toContain("No dev session is connected to acme.");
    expect(idle.err.join("")).toContain("ONE engine node");
  });

  it("keeps stdout pure JSON and the caveat on stderr under --json", async () => {
    const h = devHarness([response(LIVE)]);

    await leaf(h.command, ["token", "status"])(["acme"], devContext({ json: true }));

    expect(JSON.parse(h.out.join(""))).toEqual(LIVE);
    expect(h.err.join("")).toContain("ONE engine node");
  });

  it("reports an unknown agent as a configuration failure, not a retryable one", async () => {
    const failing = devHarness([], {
      request: (async () => {
        throw new RemoteError("Instance not found", ExitCode.Config, 404);
      }) as unknown as DevCommandDependencies["request"],
    });

    await expect(leaf(failing.command, ["token", "status"])(["nope"], devContext())).rejects.toMatchObject({
      code: ExitCode.Config,
    });
  });
});
