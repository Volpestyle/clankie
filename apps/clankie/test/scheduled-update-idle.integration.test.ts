import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { bodyIdleCheck, withBodyActivity } from "../src/scheduled-update.ts";

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((step) => step()));

it("a scheduled install waits out a turn, an activity share, a live call and a hired agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "scheduled-idle-"));
  const leases = new BodyLeaseStore(root);
  cleanup.push(() => {
    leases.close();
    rmSync(root, { recursive: true, force: true });
  });
  const { provider, activity } = withBodyActivity({});
  let agents = 0;
  const idle = bodyIdleCheck({
    activity,
    voiceHeld: () => leases.status("voice") !== undefined,
    agentPanes: async () => agents,
  });
  expect(await idle()).toBe(true);

  const finish = provider.heartbeat.begin(undefined);
  expect(await idle()).toBe(false);
  finish();
  finish(); // a settled turn counts once
  expect(await idle()).toBe(true);

  provider.heartbeat.activitySharing(true);
  expect(await idle()).toBe(false);
  provider.heartbeat.activitySharing(false);

  // Between utterances no turn runs, but the call still holds the voice body.
  const call = leases.acquire("voice", "voice-room", 60_000);
  expect(call.outcome).toBe("acquired");
  expect(await idle()).toBe(false);
  if (call.outcome === "acquired") leases.release(call.lease);
  expect(await idle()).toBe(true);

  agents = 1;
  expect(await idle()).toBe(false);
});
