// SPDX-License-Identifier: Apache-2.0

/** A pre-formatted table: callers turn domain values into strings before rendering. */
export interface Table {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  /** Text to show instead of a header when the collection is empty. */
  readonly emptyMessage?: string;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const COMBINING_MARK = /^\p{Mark}$/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

function isWide(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff01 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1b000 && codePoint <= 0x1b2ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function isZeroWidth(codePoint: number, symbol: string): boolean {
  return (
    symbol === "\u200d" ||
    COMBINING_MARK.test(symbol) ||
    codePoint === 0xfe0e ||
    codePoint === 0xfe0f ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

/** The terminal column width of text, accounting for grapheme clusters. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (EXTENDED_PICTOGRAPHIC.test(segment)) {
      width += 2;
      continue;
    }
    for (const symbol of segment) {
      const codePoint = symbol.codePointAt(0);
      if (codePoint !== undefined && !isZeroWidth(codePoint, symbol)) {
        width += isWide(codePoint) ? 2 : 1;
      }
    }
  }
  return width;
}

/** Pads by terminal columns without changing the supplied text. */
export function padDisplayEnd(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - displayWidth(text)))}`;
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
    Math.max(displayWidth(header), ...table.rows.map((row) => displayWidth(row[index]))),
  );
  const renderRow = (row: readonly string[]) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : padDisplayEnd(cell, widths[index]))).join("  ");

  return [
    renderRow(table.headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...table.rows.map(renderRow),
  ].join("\n");
}
