import {
  SettingsStore,
  personaInstructions,
  type ClankieSettings,
  type PersonaRegister,
} from "@clankie/settings";
import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { captainLaneKind, type EveChannelLaneContext } from "./lanes/context.ts";

/**
 * The room, derived from the lane.
 *
 * Both Discord planes are social: he is a participant there, not an assistant
 * on call. The operator lane is the only one that gets the working register.
 */
const REGISTER_FOR_LANE: Readonly<Record<CaptainSessionLaneV2, PersonaRegister>> = {
  operator: "operator",
  discord_voice: "social",
  discord_presence: "social",
  gameplay: "gameplay",
};

/**
 * Persona is read from the operator settings file rather than passed through
 * the channel, for the same reason ceremony instructions are HMAC-verified:
 * caller-controlled channel metadata must not be able to redefine who Clankie
 * is. The settings file is owner-authored and local.
 *
 * It is cached per process because it is read on every turn and changes only
 * when the owner edits it; `reloadPersona` exists so the TUI can take effect
 * without restarting the captain.
 */
let cached: Promise<ClankieSettings> | undefined;

function load(): Promise<ClankieSettings> {
  cached ??= new SettingsStore().load();
  return cached;
}

export function reloadPersona(): void {
  cached = undefined;
}

export async function captainPersonaInstructions(channel: EveChannelLaneContext): Promise<string> {
  const lane = captainLaneKind(channel);
  const settings = await load();
  return personaInstructions(settings.persona, REGISTER_FOR_LANE[lane]);
}
