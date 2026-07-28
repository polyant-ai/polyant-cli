#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Polyant-Enterprise
import { run } from "./cli.js";

process.exit(await run(process.argv.slice(2)));
