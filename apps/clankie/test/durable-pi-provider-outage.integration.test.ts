import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanups, privateService } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284 (#368): a durable Pi turn whose provider stays unavailable past Pi's own
// retries is left unsettled for its body's redelivery, which asks the provider
// again from the last good step. The wait is bounded: an outage older than an
// hour fails the turn once.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function outage() {
  const provider = { down: true };
  const f = await privateService({
    reply: (messages, { requestId }) => {
      if (messages.every((message) => message.role !== "tool"))
        return { call: { name: "memory", args: { action: "write", text: requestId } } };
      return provider.down ? { unavailable: true } : { text: `${requestId} answered after the outage` };
    },
  });
  const turn = join(
    f.root,
    "state/captain/durable-pi-room",
    createHash("sha256").update(JSON.stringify(f.requestId)).digest("hex"),
    "turn.json",
  );
  const record = async () =>
    JSON.parse(await readFile(turn, "utf8")) as {
      deferred?: { since: number; attempts: number };
      result?: { state: string };
      steps: { kind: string; key: string; input: { name?: string }; output?: { stopReason?: string } }[];
    };
  const status = async () =>
    (
      await fetch(`${f.url}/v1/captain/channel-turns/${f.requestId}`, {
        headers: { authorization: f.authorization },
      })
    ).status;
  /** Admits the turn and waits until Pi's retries are spent and the turn is deferred. */
  const defer = async () => {
    await f.start();
    await f.presence();
    expect((await f.post()).status).toBe(202);
    await f.until(async () =>
      (await record().catch(() => undefined))?.deferred === undefined ? undefined : true,
    );
    expect(await f.until(async () => ((await status()) === 502 ? true : undefined))).toBe(true);
    const saved = await record();
    // The failed attempts are dropped: the journal ends at the memory write, which never repeats.
    expect(saved.steps.map((step) => step.input.name ?? step.kind)).toEqual(["model", "memory"]);
    expect(saved.result).toBeUndefined();
    expect(await f.handoffs()).toMatchObject([{ state: "running" }]);
    expect(await f.memories()).toHaveLength(1);
  };
  return { f, provider, record, defer, turn };
}

it("an unavailable provider defers the turn, and the redelivery answers once it is back", async () => {
  const { f, provider, record, defer } = await outage();
  await defer();
  expect((await record()).deferred).toMatchObject({ attempts: 1 });
  // Still down: the redelivery waits again, without repeating the effect.
  expect((await f.post()).status).toBe(202);
  await f.until(async () => ((await record()).deferred?.attempts === 2 ? true : undefined));
  provider.down = false;
  const asked = f.model.seen.length;
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({
    state: "settled",
    response: `${f.requestId} answered after the outage`,
  });
  // The first model step replayed from the journal; only the answer was asked for.
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.memories()).toHaveLength(1);
  expect(await f.handoffs()).toMatchObject([{ state: "completed" }]);
}, 300_000);

it("a deferred turn survives a restart and resumes on the redelivery", async () => {
  const { f, provider, defer } = await outage();
  await defer();
  await f.stop("SIGKILL");
  provider.down = false;
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({
    state: "settled",
    response: `${f.requestId} answered after the outage`,
  });
  expect(await f.memories()).toHaveLength(1);
}, 300_000);

it("an outage older than the wait fails the turn once instead of waiting again", async () => {
  const { f, record, defer, turn } = await outage();
  await defer();
  await f.stop("SIGTERM");
  // The outage began over an hour ago.
  const saved = await record();
  await writeFile(
    turn,
    JSON.stringify({ ...saved, deferred: { ...saved.deferred, since: Date.now() - 2 * 60 * 60_000 } }),
  );
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({ state: "failed" });
  expect((await record()).result).toMatchObject({ state: "failed" });
  expect(await f.memories()).toHaveLength(1);
  // Settled: another redelivery answers from the receipt and never asks again.
  const asked = f.model.seen.length;
  const again = await f.post();
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ state: "failed" });
  expect(f.model.seen.length).toBe(asked);
}, 300_000);
