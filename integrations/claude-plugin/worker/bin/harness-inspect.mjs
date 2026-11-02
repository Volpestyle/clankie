#!/usr/bin/env node
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bridgeToolNames } from "./bridge-tools.mjs";
import { inspectHarnessProfiles } from "./harness-status.mjs";
const report = await inspectHarnessProfiles({ expectedVersion: process.argv[2] });
// Claude hires load this very copy with --plugin-dir (ADR 0317); name the tools it defines (#379).
process.stdout.write(
  `${JSON.stringify({ ...report, claudeBridgeTools: await bridgeToolNames(dirname(fileURLToPath(import.meta.url))) })}\n`,
);
