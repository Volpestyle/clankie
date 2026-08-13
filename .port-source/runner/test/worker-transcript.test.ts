import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerTranscriptProjection, type WorkerTranscriptCandidate } from "../src/worker-transcript.ts";

const roots: string[] = [];
const key = { missionId: "mission-1", taskId: "task-1", workerRunId: "run-1" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projection(maxEntriesPerRun = 500) {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-transcript-"));
  roots.push(root);
  return { root, store: await WorkerTranscriptProjection.open(root, { maxEntriesPerRun }) };
}

function candidate(
  sequence: number,
  overrides: Partial<WorkerTranscriptCandidate> = {},
): WorkerTranscriptCandidate {
  return {
    key,
    occurredAt: `2026-07-12T18:00:0${sequence}.000Z`,
    correlationId: "corr-1",
    profileHash: "profile-1",
    sourceEventId: `event-${sequence}`,
    source: "runner_event",
    trust: "runner_observed",
    kind: "status",
    data: { state: "working" },
    ...overrides,
  };
}

describe("runner worker transcript projection", () => {
  it("redacts adversarial private content before any bytes reach persistence", async () => {
    const { root, store } = await projection();
    await store.append(
      candidate(1, {
        source: "worker_summary",
        trust: "worker_authored",
        kind: "narrative",
        data: {
          summary: "Authorization: Bearer auth-secret <think>private chain secret</think> token=token-secret",
          authorization: "Bearer header-secret",
          apiKey: "sk-api-secret",
          password: "password-secret",
          credential: "credential-secret",
          chainOfThought: "cot-secret",
          rawAudio: "audio-secret",
          toolOutput: "unbounded-secret",
          privatePrompt: "prompt-secret",
        },
      }),
    );
    await store.append(
      candidate(2, {
        source: "worker_summary",
        trust: "worker_authored",
        kind: "narrative",
        data: { summary: "Safe progress, token=standalone-token and ghp_1234567890abcdef." },
      }),
    );

    const files = await readdir(root);
    const persisted = await readFile(join(root, files[0] as string), "utf8");
    for (const forbidden of [
      "auth-secret",
      "private chain secret",
      "token-secret",
      "header-secret",
      "sk-api-secret",
      "password-secret",
      "credential-secret",
      "cot-secret",
      "audio-secret",
      "unbounded-secret",
      "prompt-secret",
      "standalone-token",
      "ghp_1234567890abcdef",
    ])
      expect(persisted).not.toContain(forbidden);
    expect(persisted).toContain("[redacted private worker update]");
    expect(persisted).not.toContain("Safe progress");
  });

  it("rebuilds byte-for-byte-equivalent snapshots after restart", async () => {
    const { root, store } = await projection();
    await store.append(candidate(1));
    await store.append(
      candidate(2, {
        kind: "action",
        data: {
          action: "command",
          result: "succeeded",
          fingerprint: "a".repeat(64),
        },
      }),
    );
    const before = store.snapshot(key);
    const restarted = await WorkerTranscriptProjection.open(root);
    expect(restarted.snapshot(key)).toEqual(before);
  });

  it("enforces retention and returns typed cursor-expired recovery", async () => {
    const { store } = await projection(3);
    await store.append(candidate(1));
    const oldCursor = store.snapshot(key);
    if (oldCursor.outcome !== "snapshot") throw new Error("snapshot expected");
    await store.append(candidate(2));
    await store.append(candidate(3));
    await store.append(candidate(4));
    await store.append(candidate(5));

    const snapshot = store.snapshot(key);
    expect(snapshot.outcome).toBe("snapshot");
    if (snapshot.outcome !== "snapshot") throw new Error("snapshot expected");
    expect(snapshot.entries.map((entry) => entry.sequence)).toEqual([3, 4, 5]);
    const tail = store.openTail(key, oldCursor.nextCursor, new AbortController().signal);
    expect(tail).toMatchObject({ outcome: "cursor_expired", retainedFromSequence: 3 });
  });

  it("returns run-replaced recovery when a task has a newer worker run", async () => {
    const { root, store } = await projection();
    await store.append(candidate(1));
    const replacementKey = { ...key, workerRunId: "run-2" };
    await store.append(candidate(2, { key: replacementKey }));
    await store.append(candidate(3));
    const lateOlderKey = { ...key, workerRunId: "run-0" };
    await store.append(
      candidate(4, {
        key: lateOlderKey,
        occurredAt: "2026-07-12T17:59:59.000Z",
      }),
    );
    expect(store.snapshot(key)).toMatchObject({ outcome: "run_replaced", replacementKey });
    expect(store.snapshot(lateOlderKey)).toMatchObject({ outcome: "run_replaced", replacementKey });
    const restarted = await WorkerTranscriptProjection.open(root);
    expect(restarted.snapshot(key)).toMatchObject({ outcome: "run_replaced", replacementKey });
    expect(restarted.snapshot(lateOlderKey)).toMatchObject({ outcome: "run_replaced", replacementKey });
  });

  it("replays without duplicates and delivers concurrent live tail entries", async () => {
    const { store } = await projection();
    const first = candidate(1);
    await store.append(first);
    await store.append(first);
    const snapshot = store.snapshot(key);
    if (snapshot.outcome !== "snapshot") throw new Error("snapshot expected");
    expect(snapshot.entries).toHaveLength(1);
    const abort = new AbortController();
    const opened = store.openTail(key, snapshot.nextCursor, abort.signal);
    if (opened.outcome !== "tail") throw new Error("tail expected");
    const iterator = opened.stream[Symbol.asyncIterator]();
    const next = iterator.next();
    await store.append(candidate(2));
    await expect(next).resolves.toMatchObject({ done: false, value: { entry: { sequence: 2 } } });
    abort.abort();
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });
});
