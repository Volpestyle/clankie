#!/usr/bin/env node
import { installHarnessBridges } from "./harness-install.mjs";
if (process.argv[2] !== "--approved" || !process.argv[3])
  throw new Error("Owner-approved preparation requires --approved MARKETPLACE");
const result = await installHarnessBridges({ marketplaceRoot: process.argv[3], consent: async () => true });
process.stdout.write(`${JSON.stringify(result)}\n`);
