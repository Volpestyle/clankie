import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where Clankie keeps the owner's state, immune to Herdr's own isolation
 * ([ADR 0164](../../../docs/adr/0164-the-fleet-is-its-own-session.md)).
 *
 * The bundled runtime gives its Herdr a private `XDG_STATE_HOME` so that
 * server's config, logs, and sessions never touch the owner's. Herdr hands its
 * environment to every pane it opens, so inside the fleet that private path
 * would otherwise redefine where Clankie's own service records, console
 * history, and seat record live — the launcher then finds no records and
 * reports its own healthy services as foreign. `CLANKIE_STATE_HOME` is the
 * pointer that survives: the runtime sets it to the owner's real state home,
 * and every pane inherits it.
 */
export function clankieStateHome(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.CLANKIE_STATE_HOME?.trim() ||
    env.XDG_STATE_HOME?.trim() ||
    join(env.HOME?.trim() || homedir(), ".local", "state")
  );
}
