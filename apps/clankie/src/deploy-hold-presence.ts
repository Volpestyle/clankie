import type { DeployHold } from "@clankie/protocol/integrate";
import { parseHerdrTerminalCatalog } from "./captain/herdr-census.ts";

/** A failed census is unknown, never proof that a pane disappeared. */
export async function deployHoldPresence(
  hold: DeployHold,
  snapshot: (fleet: string) => Promise<string>,
): Promise<DeployHold["presence"]> {
  const target = hold.seat ?? hold.pane;
  if (!target) return "person";
  const slash = target.indexOf("/");
  const fleet = slash < 0 ? "default" : target.slice(0, slash);
  const id = slash < 0 ? target : target.slice(slash + 1);
  try {
    const raw = await snapshot(fleet);
    const parsed = JSON.parse(raw) as { result?: { snapshot?: { panes?: unknown; agents?: unknown } } };
    const observed = parsed.result?.snapshot;
    if (!observed || (!Array.isArray(observed.panes) && !Array.isArray(observed.agents))) return "unknown";
    const terminals = parseHerdrTerminalCatalog(raw);
    const found = terminals.find((t) =>
      hold.seat ? t.terminalId === id && Boolean(t.agent) : t.pane.id === id,
    );
    return found ? "present" : "gone";
  } catch {
    return "unknown";
  }
}
