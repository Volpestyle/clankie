import { CODEX_GOAL_QUERY, codexGoalSessionId, parseCodexGoal } from "@clankie/agent-transcript";
import type { OperatorFleetSeat, OperatorGoal } from "@clankie/protocol";
import { remoteProgramCommand, type FleetShellRun, type HerdrFleet } from "../herdr-fleet.ts";
import type { ObservedFleetSeat } from "./herdr-census.ts";

const CACHE_MS = 10_000;
const READ_TIMEOUT_MS = 5_000;
const MAX_SESSIONS = 48;
const MAX_CACHED_SESSIONS = 1_024;
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

// Service-authored code runs under the remote Node, without installing a helper.
// Never read credentials, rollouts or arbitrary session paths. Node 22 supports
// this read-only SQLite API; an older Node or a different schema means unknown.
const READ_GOALS = `
const { DatabaseSync } = require('node:sqlite');
const { join } = require('node:path');
const { homedir } = require('node:os');
const ids = JSON.parse(Buffer.from(process.argv[1], 'base64').toString('utf8'));
if (!Array.isArray(ids) || ids.length > ${MAX_SESSIONS} || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) process.exit(1);
let db;
const rows = [];
try {
  db = new DatabaseSync(join(process.env.CODEX_HOME || homedir() + '/.codex', 'goals_1.sqlite'), { readOnly: true });
  const query = db.prepare(${JSON.stringify(CODEX_GOAL_QUERY)});
  for (const id of ids) rows.push([id, query.get(id) || null]);
} catch {} finally { if (db) db.close(); }
process.stdout.write(JSON.stringify(rows));
`;

interface CachedGoal {
  attemptedAt: number;
  goal?: OperatorGoal;
}
interface FleetCache {
  readonly goals: Map<string, CachedGoal>;
  pending?: Promise<void>;
}

/**
 * One bounded read at a time per registered SSH fleet, cached across roster
 * polls. Unknown observations retain the last native value and its timestamps;
 * they never fabricate a lifecycle transition or a fresh update time.
 */
export function createRemoteCodexGoals(options: {
  readonly shell: (fleet: HerdrFleet) => FleetShellRun | undefined;
  readonly now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const caches = new Map<string, FleetCache>();
  const identity = (fleet: HerdrFleet) => JSON.stringify([fleet.id, fleet.session, fleet.ssh]);

  async function read(fleet: HerdrFleet, ids: readonly string[]): Promise<ReadonlyMap<string, CachedGoal>> {
    const key = identity(fleet);
    let cache = caches.get(key);
    if (cache === undefined) {
      cache = { goals: new Map() };
      caches.set(key, cache);
    }
    // Concurrent roster/list/get requests join the same observation. Newly seen
    // sessions during this read can be sampled on the next poll.
    if (cache.pending !== undefined) {
      await cache.pending;
      return cache.goals;
    }
    const selected = [...new Set(ids)]
      .filter((id) => {
        const previous = cache.goals.get(id);
        return previous === undefined || now() - previous.attemptedAt >= CACHE_MS;
      })
      .slice(0, MAX_SESSIONS);
    if (selected.length === 0) return cache.goals;
    const current = cache;
    current.pending = (async () => {
      try {
        const shell = options.shell(fleet);
        if (shell === undefined) return;
        const payload = Buffer.from(JSON.stringify(selected), "utf8").toString("base64");
        const stdout = await shell(
          remoteProgramCommand(fleet.ssh.shell, "node", ["--no-warnings", "-e", READ_GOALS, payload]),
          READ_TIMEOUT_MS,
        );
        if (Buffer.byteLength(stdout, "utf8") > MAX_RESPONSE_BYTES) return;
        const rows: unknown = JSON.parse(stdout);
        if (!Array.isArray(rows) || rows.length > MAX_SESSIONS) return;
        for (const row of rows) {
          if (!Array.isArray(row) || row.length !== 2 || !selected.includes(row[0])) continue;
          const goal = parseCodexGoal(row[1]);
          if (goal !== undefined) current.goals.set(row[0], { attemptedAt: now(), goal });
        }
      } catch {
        // Unreachable/missing/malformed stores are unknown, never cleared goals.
      } finally {
        for (const id of selected) {
          const previous = current.goals.get(id);
          current.goals.delete(id);
          current.goals.set(id, { ...previous, attemptedAt: now() });
        }
        while (current.goals.size > MAX_CACHED_SESSIONS)
          current.goals.delete(current.goals.keys().next().value!);
      }
    })();
    try {
      await current.pending;
    } finally {
      delete current.pending;
    }
    return current.goals;
  }

  return async (
    seats: readonly OperatorFleetSeat[],
    observed: readonly ObservedFleetSeat[],
    fleets: readonly HerdrFleet[],
  ): Promise<readonly OperatorFleetSeat[]> => {
    const active = new Set(fleets.map(identity));
    for (const key of caches.keys()) if (!active.has(key)) caches.delete(key);
    const sessions = new Map(observed.map((seat) => [seat.seatId, seat]));
    const goals = new Map<string, OperatorGoal>();
    await Promise.all(
      fleets.map(async (fleet) => {
        const selected = seats.flatMap((seat) => {
          const observation = sessions.get(seat.seatId);
          if (
            seat.harness !== "codex" ||
            seat.fleet !== fleet.id ||
            observation?.harness !== "codex" ||
            observation.fleet !== fleet.id ||
            observation.occupantId !== seat.occupantId ||
            observation.session === undefined
          )
            return [];
          const id = codexGoalSessionId(observation.session);
          return id === undefined ? [] : [{ seatId: seat.seatId, id }];
        });
        if (selected.length === 0) return;
        const result = await read(
          fleet,
          selected.map(({ id }) => id),
        );
        for (const { seatId, id } of selected) {
          const goal = result.get(id)?.goal;
          if (goal !== undefined) goals.set(seatId, goal);
        }
      }),
    );
    return seats.map((seat) => {
      const goal = goals.get(seat.seatId);
      return goal === undefined ? seat : { ...seat, goal };
    });
  };
}
