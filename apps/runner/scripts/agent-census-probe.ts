/**
 * Live agent census probe (ADR 0078).
 *
 * Answers "what is running on this machine right now, and what can Clankie
 * honestly say about it?" against the real Herdr socket, using the same census
 * the runner takes at startup. Read-only: it adopts nothing, writes no adoption
 * record into the runner's real state root, and touches no live agent.
 *
 *   pnpm --filter @clankie/runner census:probe
 *
 * Requires HERDR_SOCKET_PATH. Prints the census as JSON; a missing socket is
 * reported as `transportAvailable: false` rather than an empty machine.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@clankie/event-store";
import type { AgentObservation } from "@clankie/protocol";
import { takeAgentCensus } from "../src/agent-census.ts";
import { HerdrSocketTransport } from "../src/herdr-provider.ts";
import { WorkerAdoptionStore } from "../src/worker-adoptions.ts";

const socketPath = process.env.HERDR_SOCKET_PATH?.trim();

let observations: readonly AgentObservation[] | undefined;
if (socketPath) {
  try {
    observations = await new HerdrSocketTransport({ socketPath }).listAgents();
  } catch (error) {
    process.stderr.write(`herdr transport unavailable: ${error instanceof Error ? error.name : "unknown"}\n`);
  }
} else {
  process.stderr.write("HERDR_SOCKET_PATH is unset; reporting an unavailable transport\n");
}

// A scratch state root keeps the probe from reading or writing the runner's
// real adoption records, so running it never changes what the runner believes.
const rootDir = await mkdtemp(join(tmpdir(), "clankie-census-probe-"));
const census = await takeAgentCensus({
  runnerId: process.env.CLANKIE_RUNNER_ID ?? "local",
  observations,
  leases: [],
  adoptions: new WorkerAdoptionStore({ rootDir, events: new SqliteEventStore(":memory:") }),
});

process.stdout.write(`${JSON.stringify(census, null, 2)}\n`);
