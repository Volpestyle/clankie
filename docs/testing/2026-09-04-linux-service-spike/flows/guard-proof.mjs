/**
 * VUH-1030 proof: launcher conflicts are scoped to an instance's own resources.
 *
 * The change touched `startService` and `stopService` only — `inspectService`
 * was left alone — so `clankie status` cannot exercise it. This drives the two
 * changed branches directly, against real `lsof` in the container.
 *
 * The case: activity's own ports (4320 viewer, 4322 producer) are free, and a
 * foreign process carrying activity's argv shape listens somewhere else.
 * The old guard matched on that shape and refused; the new one asks who owns
 * the ports and proceeds, without ever signalling the stranger.
 *
 *   node guard-proof.mjs <old|new>
 */
import { execFileSync } from "node:child_process";
import { managedService } from "/clankie/apps/tui/bin/services.ts";
import { startService, stopService } from "/clankie/apps/tui/bin/service-supervisor.ts";

const mode = process.argv[2];
if (!["old", "new", "producer"].includes(mode)) throw new Error("usage: guard-proof.mjs <old|new|producer>");

const OCCUPIED = /occupied by a process the clankie launcher does not own/u;
const FOREIGN_STOP = /was not started by the clankie launcher/u;
const activity = managedService("activity");
const env = { ...process.env };
const options = { env, repoRoot: "/clankie" };

const listening = (port) => {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    return out.trim().length === 0 ? [] : out.trim().split(/\s+/u).map(Number);
  } catch (error) {
    if (
      error.status === 1 &&
      String(error.stdout ?? "").trim() === "" &&
      String(error.stderr ?? "").trim() === ""
    )
      return [];
    throw error;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const decoyPid = Number(process.env.SPIKE_DECOY_PID);
if (!Number.isSafeInteger(decoyPid) || !alive(decoyPid)) throw new Error("the decoy is not running");
// `producer` is the opposite case: 4322 is deliberately occupied there.
const requiredFree = mode === "producer" ? [4320] : [4320, 4322];
for (const port of requiredFree) {
  if (listening(port).length > 0)
    throw new Error(`activity port ${String(port)} must be free for this proof`);
}
if (mode === "producer" && listening(4322).length === 0) {
  throw new Error("this case needs a listener on the producer port 4322");
}
console.log(
  `decoy pid ${String(decoyPid)} on 4399; 4320 free; 4322 ${mode === "producer" ? `held by ${listening(4322).join(",")}` : "free"}`,
);

const attempt = async (label, run) => {
  try {
    const value = await run();
    return { label, outcome: "returned", value };
  } catch (error) {
    return { label, outcome: "threw", message: error instanceof Error ? error.message : String(error) };
  }
};

if (mode !== "producer") {
  const stoppedBeforeStart = await attempt("stopService(activity) without an owned record", () =>
    stopService(activity, options),
  );
  console.log(`${stoppedBeforeStart.label}: ${stoppedBeforeStart.outcome}`);
  if (mode === "old") {
    if (stoppedBeforeStart.outcome !== "threw" || !FOREIGN_STOP.test(stoppedBeforeStart.message)) {
      throw new Error("old unowned stop did not reproduce the foreign-instance refusal");
    }
  } else if (stoppedBeforeStart.outcome !== "returned") {
    throw new Error(`new unowned stop failed: ${stoppedBeforeStart.message}`);
  }
  if (!alive(decoyPid)) throw new Error("unowned stop signalled the decoy");
}

const started = await attempt("startService(activity)", () => startService(activity, options));
console.log(
  `${started.label}: ${started.outcome}${started.outcome === "threw" ? ` — ${started.message}` : ` — state ${String(started.value?.state)}`}`,
);

if (mode === "producer") {
  // A stranger on activity's own producer port is a real conflict: it must block,
  // and it must still not be signalled.
  if (started.outcome !== "threw" || !OCCUPIED.test(started.message)) {
    throw new Error("a listener on producer port 4322 did not block the start");
  }
  if (!alive(decoyPid)) throw new Error("the decoy was signalled");
  console.log("PRODUCER PORT: a listener on 4322 blocks the start, as it should.");
} else if (mode === "old") {
  // The pre-fix guard matched the decoy's command shape and refused to start.
  if (started.outcome !== "threw" || !OCCUPIED.test(started.message)) {
    throw new Error(
      "old guard did NOT block on the foreign same-shape process; the case is not a regression case",
    );
  }
  if (!alive(decoyPid)) throw new Error("old guard signalled the decoy");
  console.log("OLD GUARD: blocked by the stranger's command shape, as expected. Decoy untouched.");
} else {
  if (started.outcome !== "returned" || started.value?.state !== "healthy") {
    throw new Error(`new start did not reach healthy: ${started.message ?? started.value?.state}`);
  }
  if (!alive(decoyPid)) throw new Error("new guard signalled the decoy");
  console.log("NEW GUARD: start proceeded past the stranger. Decoy untouched.");

  const stopped = await attempt("stopService(activity)", () => stopService(activity, options));
  console.log(
    `${stopped.label}: ${stopped.outcome}${stopped.outcome === "threw" ? ` — ${stopped.message}` : ""}`,
  );
  if (stopped.outcome !== "returned") {
    throw new Error(`new owned stop failed: ${stopped.message}`);
  }
  if (!alive(decoyPid)) throw new Error("stop signalled the decoy");
  console.log("NEW GUARD: stop proceeded past the stranger. Decoy untouched.");
}
