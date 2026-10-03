#!/usr/bin/env node
import { inspectHarnessProfiles } from "./harness-status.mjs";
process.stdout.write(
  `${JSON.stringify(await inspectHarnessProfiles({ expectedVersion: process.argv[2] }))}\n`,
);
