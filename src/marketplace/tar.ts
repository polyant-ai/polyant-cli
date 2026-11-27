// SPDX-License-Identifier: Apache-2.0
import { gzipSync } from "node:zlib";

/**
 * A reproducible `.tar.gz` of a few flat files: the shape of a runtime bundle.
 *
 * Written here rather than taken from a tar library because a bundle needs
 * exactly one thing from tar — regular files at the archive root — and it must
 * be byte-for-byte stable: the catalogue pins each version to its digest, and a
 * rebuild of unchanged sources has to produce the same one. Every field that
 * could vary (mtime, owner, mode, gzip header OS byte) is fixed.
 */

const BLOCK = 512;

export interface TarFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function writeString(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, length, "utf8");
}

/** A numeric field: zero-padded octal, NUL-terminated, as ustar spells it. */
function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  writeString(header, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

function headerFor(name: string, size: number): Buffer {
  if (Buffer.byteLength(name) > 100 || name.includes("/")) throw new Error(`tar: unsupported entry name ${name}`);
  const header = Buffer.alloc(BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function createTarGz(files: readonly TarFile[]): Buffer {
  const parts: Buffer[] = [];
  for (const file of files) {
    parts.push(headerFor(file.name, file.bytes.length), Buffer.from(file.bytes));
    const padding = (BLOCK - (file.bytes.length % BLOCK)) % BLOCK;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  const gzipped = gzipSync(Buffer.concat(parts), { level: 9 });
  // Byte 9 of the gzip header names the OS that wrote it, which differs between
  // platforms; 255 ("unknown") keeps the digest the same everywhere. It is not
  // covered by the gzip CRC, which is over the uncompressed data.
  gzipped[9] = 0xff;
  return gzipped;
}
