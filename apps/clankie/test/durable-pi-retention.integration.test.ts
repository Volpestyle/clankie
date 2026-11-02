import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanups, privateService } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284 retention (#368): a settled durable Pi turn keeps only its answer and
// the effects it could not be sure of, and is forgotten after the room handoffs'
// 30 days. Unsettled work stays, however old, until its delivery returns.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

function paths(root: string, deliveryId: string) {
  const directory = join(
    root,
    "state/captain/durable-pi-room",
    createHash("sha256").update(JSON.stringify(deliveryId)).digest("hex"),
  );
  return { directory, turn: join(directory, "turn.json") };
}

async function age(path: string, ms: number) {
  const then = new Date(Date.now() - ms);
  await utimes(path, then, then);
}

it("compacts a settled turn and forgets it after retention; the delivery still answers from its receipt", async () => {
  const f = await privateService();
  await f.killMidShell();
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled", response: `${f.requestId} recovered: possibly ran` });

  // Model contexts and replayed reads are gone; the uncertain effects and the answer stay.
  const saved = JSON.parse(await readFile(paths(f.root, f.requestId).turn, "utf8")) as Record<
    string,
    unknown
  > & {
    steps: { kind: string; replay: string; input: { name?: string }; output?: unknown }[];
  };
  expect(saved.result).toMatchObject({
    state: "settled",
    response: result.state === "settled" ? result.response : "",
  });
  expect(saved).not.toHaveProperty("prompt");
  expect(saved).not.toHaveProperty("tools");
  expect(saved.steps.every((step) => step.kind === "tool" && step.replay === "never")).toBe(true);
  expect(saved.steps.map((step) => step.input.name)).toEqual(["memory", "bash"]);
  expect(JSON.stringify(saved.steps[1]?.output)).toContain("possibly ran");
  // The turn's Pi session stays as its trail.
  expect(await readdir(join(paths(f.root, f.requestId).directory, "pi"))).not.toHaveLength(0);
  // The receipt answers redelivery from its result and no longer keeps the request.
  const receipts = JSON.parse(
    await readFile(join(f.root, "state/discord-turn-receipts.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  expect(receipts[`discord:${f.requestId}`]).toMatchObject({ settled: result });
  expect(receipts[`discord:${f.requestId}`]).not.toHaveProperty("recoveryRequest");

  // Inside retention a restart keeps it.
  await f.stop("SIGTERM");
  await age(paths(f.root, f.requestId).turn, RETENTION_MS - 60 * 60_000);
  await f.start();
  expect(existsSync(paths(f.root, f.requestId).turn)).toBe(true);

  // Past retention the next start forgets the delivery's directory.
  await f.stop("SIGTERM");
  await age(paths(f.root, f.requestId).turn, RETENTION_MS + 60 * 60_000);
  const asked = f.model.seen.length;
  await f.start();
  expect(existsSync(paths(f.root, f.requestId).directory)).toBe(false);
  await f.presence();
  const again = await f.post();
  expect(again.status).toBe(200);
  expect(await again.json()).toEqual(result);
  expect(f.model.seen.length).toBe(asked);
}, 300_000);

it("keeps an unsettled turn past retention, and its redelivery resumes it", async () => {
  const f = await privateService();
  await f.killMidShell();
  await age(paths(f.root, f.requestId).turn, RETENTION_MS * 2);
  await f.start();
  expect((await f.journal()).result).toBeUndefined();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({
    state: "settled",
    response: `${f.requestId} recovered: possibly ran`,
  });
  expect(await f.effects()).toHaveLength(1);
}, 240_000);
