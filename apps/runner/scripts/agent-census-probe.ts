/**
 * Live agent census probe (ADR 0078).
 *
 * Answers "what is running on this machine right now, and what can Clankie
 * honestly say about it?" against every running local Herdr session, using the same census
 * the runner takes at startup. Read-only: it adopts nothing, writes no adoption
 * record into the runner's real state root, and touches no live agent.
 *
 *   pnpm --filter @clankie/runner census:probe
 *
 * Prints the census as JSON; failed discovery is reported as
 * `transportAvailable: false` rather than an empty machine.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteEventStore } from "@clankie/event-store";
import type { AgentObservation } from "@clankie/protocol";
import { takeAgentCensus } from "../src/agent-census.ts";
import {
  createCompositeHerdrAgentSource,
  discoverHerdrSessionEndpoints,
} from "../src/herdr-session-discovery.ts";
import { WorkerAdoptionStore } from "../src/worker-adoptions.ts";

let observations: readonly AgentObservation[] | undefined;
const endpoints = await discoverHerdrSessionEndpoints(process.env);
const source = createCompositeHerdrAgentSource(endpoints);
if (source) {
  try {
    observations = await source.listAgents();
  } catch (error) {
    process.stderr.write(`herdr transport unavailable: ${error instanceof Error ? error.name : "unknown"}\n`);
  }
} else {
  process.stderr.write("no running Herdr session was discovered; reporting an unavailable transport\n");
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
