#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { run } from "./cli.js";

// Pipes are asynchronous on POSIX: process.exit() discards whatever libuv has
// not yet flushed to stdout, silently truncating piped output while still
// reporting exit 0. A file redirect or a TTY is synchronous, so only the
// piped case breaks — which is exactly how an agent consumes this tool.
// Setting exitCode and letting Node exit naturally drains the buffer first.
process.exitCode = await run(process.argv.slice(2));
