/**
 * The image's service loadout (`CLANKIE_SERVICES`). Unset — every service runs
 * as its own configuration says. Set — a hosted body runs `clankie,relay` — a
 * service outside the list never runs. Image policy, not a preference:
 * settings cannot widen it. The launcher starts services by it, and the
 * service leaves out the tools a missing service would back.
 */
export const SERVICE_LOADOUT_ENV = "CLANKIE_SERVICES";

export function serviceInLoadout(id: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SERVICE_LOADOUT_ENV]?.trim();
  if (raw === undefined || raw.length === 0) return true;
  return raw.split(",").some((entry) => entry.trim() === id);
}
