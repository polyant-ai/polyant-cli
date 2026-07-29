// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/** A pre-formatted table: callers turn domain values into strings before rendering. */
export interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Text to show instead of a header when the collection is empty. */
  readonly emptyMessage?: string;
}

function validate(table: Table): void {
  if (table.headers.length === 0) throw new Error("A table needs at least one header.");
  for (const row of table.rows) {
    if (row.length !== table.headers.length) {
      throw new Error(`A table row has ${row.length} cells; expected ${table.headers.length}.`);
    }
  }
}

/**
 * Renders strings as a predictable, no-colour table. It deliberately does not
 * format values: a command owns presentation choices such as dates and IDs.
 */
export function renderTable(table: Table): string {
  validate(table);
  if (table.rows.length === 0) return table.emptyMessage ?? "No results.";

  const widths = table.headers.map((header, index) =>
    Math.max(header.length, ...table.rows.map((row) => row[index].length)),
  );
  const renderRow = (row: readonly string[]) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index]))).join("  ");

  return [
    renderRow(table.headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...table.rows.map(renderRow),
  ].join("\n");
}
