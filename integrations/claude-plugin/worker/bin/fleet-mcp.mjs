#!/usr/bin/env node
// Owner-granted fleet tools only. No operator credential or operator lane fallback.
import { parentCommandLine } from "./link.mjs";
import { runSeatChannel } from "./seat-channel.mjs";
runSeatChannel({
  paneId: process.env.HERDR_PANE_ID?.trim(),
  parentArgv: process.env.CLANKIE_SEAT_PARENT_ARGV ?? parentCommandLine(),
});
