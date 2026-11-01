#!/usr/bin/env node
// Owner-granted fleet tools only. No operator credential or operator lane fallback.
import { parentCommandLine, seatIdentity } from "./link.mjs";
import { runSeatChannel } from "./seat-channel.mjs";
runSeatChannel({
  paneId: seatIdentity().pane,
  parentArgv: process.env.CLANKIE_SEAT_PARENT_ARGV ?? parentCommandLine(),
});
