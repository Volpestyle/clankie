import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileWorkerSteeringStore, type StoredWorkerSteerCommand } from "../src/worker-steering.ts";

describe("FileWorkerSteeringStore", () => {
  it("recovers a pending command across restart and settles retries idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-steering-"));
    const path = join(root, "commands.json");
    const first = new FileWorkerSteeringStore(path);
    await first.put(command());

    const restarted = new FileWorkerSteeringStore(path);
    const claimed = await restarted.claim({ runnerId: "runner-1", workerRunId: "run-1", attempt: 1 });
    expect(claimed).toMatchObject({ commandId: "command-1", status: "delivering", deliveryCount: 1 });
    const outcome = { code: "delivered" as const, message: "Typed adapter accepted the command." };
    await expect(restarted.settle("command-1", outcome)).resolves.toMatchObject({
      status: "settled",
      outcome,
    });

    const afterSecondRestart = new FileWorkerSteeringStore(path);
    await expect(
      afterSecondRestart.claim({ runnerId: "runner-1", workerRunId: "run-1", attempt: 1 }),
    ).resolves.toBeUndefined();
    await expect(afterSecondRestart.settle("command-1", outcome)).resolves.toMatchObject({
      status: "settled",
      outcome,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("never replays a claimed command after restart when settlement was lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-steering-"));
    const path = join(root, "commands.json");
    const first = new FileWorkerSteeringStore(path);
    await first.put(command());
    await expect(
      first.claim({ runnerId: "runner-1", workerRunId: "run-1", attempt: 1 }),
    ).resolves.toMatchObject({ status: "delivering", deliveryCount: 1 });

    const restarted = new FileWorkerSteeringStore(path);
    await expect(
      restarted.claim({ runnerId: "runner-1", workerRunId: "run-1", attempt: 1 }),
    ).resolves.toBeUndefined();
    await expect(restarted.get("command-1")).resolves.toMatchObject({
      status: "settled",
      deliveryCount: 1,
      outcome: {
        code: "delivery_failed",
        message: expect.stringContaining("was not replayed"),
      },
    });
  });

  it("fails closed on malformed persisted commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-steering-"));
    const path = join(root, "commands.json");
    await writeFile(path, JSON.stringify([{ commandId: "command-1", input: "unbound" }]));

    const malformed = new FileWorkerSteeringStore(path);
    await expect(malformed.get("command-1")).rejects.toThrow("Invalid worker steering store");
  });
});

function command(): StoredWorkerSteerCommand {
  return {
    schemaVersion: 1,
    commandId: "command-1",
    workerRunId: "run-1",
    attempt: 1,
    sourceLane: "api",
    intent: { type: "focus", target: "failing_test" },
    principal: { kind: "captain", id: "captain-1" },
    correlationId: "correlation-1",
    missionId: "mission-1",
    taskId: "task-1",
    profileHash: "profile-1",
    input: "Focus on the failing test.",
    runnerId: "runner-1",
    leaseExpiresAt: "2026-07-12T00:00:00.000Z",
    inputSha256: "hash-1",
    inputLength: 26,
    requestedAt: "2026-07-11T23:00:00.000Z",
    status: "pending",
    deliveryCount: 0,
  };
}
