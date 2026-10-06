// Compatibility path for the official bot app; hosted and local bodies share one implementation.
export {
  probeVoxProcess,
  startOfficialBotVox,
  waitForVoxProcessReady,
  type VoxProcessProbeResult,
} from "@clankie/discord-presence-core";
