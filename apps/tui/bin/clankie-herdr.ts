#!/usr/bin/env node
process.argv.splice(2, 0, "herdr", "open");
await import("./clankie.ts");
export {};
