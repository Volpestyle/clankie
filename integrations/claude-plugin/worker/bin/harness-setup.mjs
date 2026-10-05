#!/usr/bin/env node
import { installHarnessBridges, codexSourceSetupCommand } from "./harness-install.mjs";
import { isAbsolute } from "node:path";
if (process.argv[2] !== "--approved" || !process.argv[3])
  throw new Error("Owner-approved preparation requires --approved MARKETPLACE");
const refresh = process.argv[4] === "--refresh-linked";
const [flag, script, ...rest] = process.argv.slice(refresh ? 5 : 4);
if (flag !== undefined && (flag !== "--codex-source-setup" || !script || !isAbsolute(script) || rest.length))
  throw new Error("Use --codex-source-setup ABSOLUTE_SOURCE_OWNED_SCRIPT");
const sourceSetup = script === undefined ? undefined : codexSourceSetupCommand(script);
const result = await installHarnessBridges({
  marketplaceRoot: process.argv[3],
  consent: async () => true,
  linkedOnly: refresh,
  ...(sourceSetup ? { codexSourceSetup: sourceSetup } : {}),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
