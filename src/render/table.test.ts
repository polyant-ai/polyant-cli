// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { describe, expect, it } from "vitest";
import { renderTable } from "./table.js";

describe("renderTable", () => {
  it("renders headers and rows with equal-width columns", () => {
    expect(
      renderTable({
        headers: ["Agent", "Status"],
        rows: [
          ["acme", "active"],
          ["support", "idle"],
        ],
      }),
    ).toBe("Agent    Status\n-------  ------\nacme     active\nsupport  idle");
  });

  it("shows a clear message when there are no rows", () => {
    expect(renderTable({ headers: ["Agent"], rows: [], emptyMessage: "No agents found." })).toBe("No agents found.");
  });

  it("preserves supplied string cell values", () => {
    const value = "001.0 ";
    expect(renderTable({ headers: ["Value"], rows: [[value]] })).toContain(value);
  });
});
