#!/usr/bin/env node
// Seat hooks run on every prompt and tool call of another harness, so they skip
// the launcher's import graph; everything else is the full launcher.
import { runFastSeatHook } from "./seat-hook-fast.ts";

const code = await runFastSeatHook(process.argv.slice(2));
if (code === undefined) await import("./launcher.ts");
else process.exitCode = code;
