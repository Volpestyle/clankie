import { parseArgs } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { FLEET_ROOM_WAIT_MAX_MS, type FleetRoomResult } from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

export const FLEET_ROOM_USAGE =
  "Usage: clankie fleet room [--older CURSOR] [--limit N] [--follow]   (the fleet's coordination feed; owner only)";

export interface FleetRoomCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly signal?: AbortSignal;
}

/**
 * `clankie fleet room` (VUH-2184): one page of the fleet room as JSON, oldest
 * first, with the `older` cursor for the page before it. `--follow` prints that
 * page's entries and then each new one as a JSON line until interrupted. It
 * opts into `app_note` entries, so the notes connected apps leave show here too.
 */
export async function runFleetRoomCommand(
  args: readonly string[],
  options: FleetRoomCommandOptions = {},
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { older: { type: "string" }, limit: { type: "string" }, follow: { type: "boolean" } },
  });
  if (positionals.length > 0 || (values.follow && values.older !== undefined))
    throw new Error(FLEET_ROOM_USAGE);
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100))
    throw new Error("--limit takes 1 to 100");
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("The fleet room needs the owner operator credential. Run clankie doctor.");
  // The operator credential is the owner on this machine, so it is also the owner transport.
  const owner = createCaptainRouteClient({
    host: commandHost({ ...options, env }),
    captainToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const client = createCaptainOperatorConversationClient(owner, owner);
  const stdout = options.stdout ?? process.stdout;
  const unavailable = (result: FleetRoomResult) => {
    if (result.outcome === "ready") return false;
    outputJson(stdout, result);
    return true;
  };
  const page = await client.fleetRoom!({
    direction: "older",
    include: ["app_note"],
    ...(values.older === undefined ? {} : { cursor: values.older }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (unavailable(page) || page.outcome !== "ready") return 1;
  if (!values.follow) {
    outputJson(stdout, page);
    return 0;
  }
  for (const entry of page.entries) stdout.write(`${JSON.stringify(entry)}\n`);
  let cursor = page.newer;
  while (!options.signal?.aborted) {
    const next = await client.fleetRoom!({
      direction: "newer",
      include: ["app_note"],
      cursor,
      waitMs: FLEET_ROOM_WAIT_MAX_MS,
    });
    if (unavailable(next) || next.outcome !== "ready") return 1;
    for (const entry of next.entries) stdout.write(`${JSON.stringify(entry)}\n`);
    cursor = next.newer;
  }
  return 0;
}
