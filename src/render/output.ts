// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise

/** Injectable process output used by commands and lightweight unit tests. */
export interface OutputIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

/** The real process streams, kept behind the same boundary commands use in tests. */
export const processOutput: OutputIO = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export interface LabelledField {
  readonly label: string;
  readonly value: string;
}

/** Produces a compact, aligned, human-readable representation of one resource. */
export function renderLabelledResource(fields: readonly LabelledField[]): string {
  const width = Math.max(0, ...fields.map((field) => field.label.length));
  return fields.map((field) => `${field.label}:${" ".repeat(width - field.label.length + 2)}${field.value}`).join("\n");
}

/** Writes a labelled resource to stdout, with the CLI's conventional trailing newline. */
export function writePrettyResource(output: OutputIO, fields: readonly LabelledField[]): void {
  output.stdout(`${renderLabelledResource(fields)}\n`);
}

/** Writes an HTTP response body without parsing, serialising, or adding a newline. */
export function writeRawResponse(output: OutputIO, raw: string): void {
  output.stdout(raw);
}

/** Writes the original bodies from a multi-source command as one JSON object. */
export function writeCompositeJson(output: OutputIO, bodies: Readonly<Record<string, unknown>>): void {
  output.stdout(`${JSON.stringify(bodies, null, 2)}\n`);
}
