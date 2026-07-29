// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it } from "vitest";
import {
  renderLabelledResource,
  writeCompositeJson,
  writePrettyResource,
  writeRawResponse,
  type OutputIO,
} from "./output.js";

function captureOutput(): { io: OutputIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe("renderLabelledResource", () => {
  it("aligns labelled fields for a single resource", () => {
    expect(
      renderLabelledResource([
        { label: "target", value: "dev" },
        { label: "reachable", value: "yes" },
      ]),
    ).toBe("target:     dev\nreachable:  yes");
  });
});

describe("output writers", () => {
  it("writes pretty resource output to stdout", () => {
    const { io, stdout, stderr } = captureOutput();

    writePrettyResource(io, [{ label: "name", value: "acme" }]);

    expect(stdout).toEqual(["name:  acme\n"]);
    expect(stderr).toEqual([]);
  });

  it("writes a raw single response exactly as received", () => {
    const { io, stdout, stderr } = captureOutput();
    const raw = '{"version":1.0,"large":9007199254740993}';

    writeRawResponse(io, raw);

    expect(stdout).toEqual([raw]);
    expect(stderr).toEqual([]);
  });

  it("writes a composite JSON object with the original source bodies", () => {
    const { io } = captureOutput();
    const stdout: string[] = [];
    const body = { health: { status: "ok" }, agents: [{ slug: "acme" }] };

    writeCompositeJson({ stdout: (text) => stdout.push(text), stderr: io.stderr }, body);

    expect(JSON.parse(stdout.join(""))).toEqual(body);
  });
});
