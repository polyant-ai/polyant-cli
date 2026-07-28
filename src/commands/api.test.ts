// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, it, expect } from "vitest";
import { parseApiArgs } from "./api.js";
import { ConfigError } from "../exit.js";

describe("parseApiArgs", () => {
  it("should_read_the_method_and_path_from_positionals", () => {
    const args = parseApiArgs(["GET", "/api/instances"]);
    expect(args.method).toBe("GET");
    expect(args.path).toBe("/api/instances");
    expect(args.query).toEqual({});
  });

  it("should_uppercase_the_method", () => {
    expect(parseApiArgs(["get", "/health"]).method).toBe("GET");
  });

  it("should_collect_repeated_query_flags", () => {
    const args = parseApiArgs(["GET", "/api/conversations", "--query", "instanceId=acme", "--query", "limit=5"]);
    expect(args.query).toEqual({ instanceId: "acme", limit: "5" });
  });

  it("should_keep_equals_signs_inside_a_query_value", () => {
    expect(parseApiArgs(["GET", "/x", "--query", "q=a=b"]).query).toEqual({ q: "a=b" });
  });

  it("should_read_the_target_and_url_flags", () => {
    const args = parseApiArgs(["GET", "/x", "--target", "prod", "--url", "http://localhost:4000"]);
    expect(args.target).toBe("prod");
    expect(args.url).toBe("http://localhost:4000");
  });

  it("should_reject_an_unsupported_method", () => {
    expect(() => parseApiArgs(["FETCH", "/x"])).toThrow(/Unsupported method "FETCH"/);
  });

  it("should_reject_a_missing_path", () => {
    expect(() => parseApiArgs(["GET"])).toThrow(ConfigError);
  });

  it("should_reject_a_missing_method", () => {
    expect(() => parseApiArgs([])).toThrow(ConfigError);
  });

  it("should_reject_an_unknown_flag_with_a_config_error", () => {
    expect(() => parseApiArgs(["GET", "/x", "--verbose"])).toThrow(ConfigError);
    expect(() => parseApiArgs(["GET", "/x", "--verbose"])).toThrow(/--verbose/);
  });

  it("should_reject_a_query_flag_without_an_equals_sign", () => {
    expect(() => parseApiArgs(["GET", "/x", "--query", "oops"])).toThrow(/k=v/);
  });
});
