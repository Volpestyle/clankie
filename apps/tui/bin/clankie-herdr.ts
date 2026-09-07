#!/usr/bin/env node
// `clankie-herdr` alone opens the viewer; with arguments it is the fleet's
// own Herdr CLI (ADR 0164), so `clankie-herdr server stop` reaches the right
// runtime without anyone spelling out its socket.
process.argv.splice(2, 0, "herdr", ...(process.argv.length > 2 ? [] : ["open"]));
await import("./clankie.ts");
export {};
