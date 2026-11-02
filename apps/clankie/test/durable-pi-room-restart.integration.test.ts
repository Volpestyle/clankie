import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanups, privateService } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284's durable Pi turns in an owner DM, the regression base for rolling them out (#368). Its
// turns take the normal room handoff and only the Pi dispatch is journaled. A
// bot body registers over HTTP and redelivers by hand; the bridge's own inbox
// is proven in apps/discord-bridge/test/durable-pi-room-delivery.integration.test.ts.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("resumes a turn killed mid-shell when its body redelivers it: the shell surfaces as possibly ran and nothing repeats", async () => {
  const f = await privateService();
  await f.killMidShell();
  const asked = f.model.seen.length;
  await f.start();
  // The restart keeps the handoff open and waits for the room's body: it cannot reply without one.
  expect(await f.handoffs()).toMatchObject([{ state: "running" }]);
  expect(f.model.seen.length).toBe(asked);
  await f.presence();
  expect((await f.post()).status).toBe(202);
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled", response: `${f.requestId} recovered: possibly ran` });
  // Completed model steps came from the journal: after the restart the model was asked once, for the answer.
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  expect(await f.handoffs()).toMatchObject([{ state: "completed", host: "pi" }]);
  const journal = await f.journal();
  expect(journal.steps.filter((step) => step.input.name === "bash")).toHaveLength(1);
  expect(JSON.stringify(journal.steps.find((step) => step.input.name === "bash")?.output)).toContain(
    "possibly ran",
  );
  // The same delivery replays its saved result; a changed request under its id is refused.
  for (let i = 0; i < 2; i++) {
    const again = await f.post();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(result);
  }
  expect((await f.post({ ...f.request, trigger: { ...f.request.trigger, body: "different" } })).status).toBe(
    409,
  );
  // And a clean restart after settlement replays it without another model call.
  await f.stop("SIGTERM");
  await f.start();
  await f.presence();
  const replayed = await f.post();
  expect(await replayed.json()).toEqual(result);
  expect(f.model.seen.length).toBe(asked + 1);
}, 240_000);

it("a grant changed while the service was down fails the resumed turn closed, with no tool or model step", async () => {
  const f = await privateService();
  await f.killMidShell();
  const asked = f.model.seen.length;
  const steps = (await f.journal()).steps.length;
  // The sender is no longer the owner: the saved request is evidence of admission, never authority.
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, ownerUserId: "99999000077" },
  }));
  await f.start();
  await f.presence();
  await f.post();
  const result = await f.settled();
  // The first test is the control: the same kill and restart with unchanged settings settles.
  expect(result).toMatchObject({ state: "failed", code: "captain_session_failed" });
  // The journal refuses to continue under a different grant than it began with.
  expect(await f.handoffs()).toMatchObject([
    { state: "failed", result: "pi_turn_recovery_identity_changed" },
  ]);
  expect(f.model.seen.length).toBe(asked);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  expect((await f.journal()).steps.length).toBe(steps);
}, 240_000);

it("a graceful stop mid-shell pauses the handoff instead of failing it, and the redelivery resumes it", async () => {
  const f = await privateService();
  await f.killMidShell("SIGTERM");
  // Shutdown left the turn unsettled: its handoff still runs and its journal holds no result.
  expect(await f.handoffs()).toMatchObject([{ state: "running" }]);
  expect((await f.journal()).result).toBeUndefined();
  const asked = f.model.seen.length;
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({ state: "settled" });
  // Shutdown aborted the shell, and that outcome was journaled; resuming never reruns it.
  // Whether the answer step landed before exit is a race, so at most one model call follows.
  const bash = (await f.journal()).steps.filter((step) => step.input.name === "bash");
  expect(bash).toHaveLength(1);
  expect(JSON.stringify(bash[0]?.output)).toContain("Command aborted");
  expect(f.model.seen.length).toBeLessThanOrEqual(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  expect(await f.handoffs()).toMatchObject([{ state: "completed" }]);
}, 240_000);

it("a crash after the journal settles but before the receipt does answers the redelivery from the journal (#497)", async () => {
  const f = await privateService();
  await f.killMidShell();
  await f.start();
  await f.presence();
  // Receipts are read at boot; from here the receipt's settle cannot be written,
  // so the resumed turn settles its journal and the service dies holding an unsettled receipt.
  const receipts = join(f.root, "state/discord-turn-receipts.json");
  await rename(receipts, `${receipts}.saved`);
  await mkdir(receipts);
  await writeFile(join(receipts, "blocker"), "");
  expect((await f.post()).status).toBe(202);
  await f.until(async () => ((await f.journal()).result === undefined ? undefined : true));
  const journaled = (await f.journal()).result;
  expect(journaled).toMatchObject({ state: "settled", response: `${f.requestId} recovered: possibly ran` });
  await f.until(async () =>
    (
      await fetch(`${f.url}/v1/captain/channel-turns/${f.requestId}`, {
        headers: { authorization: f.authorization },
      })
    ).status === 502
      ? true
      : undefined,
  );
  await f.stop("SIGKILL");
  await rm(receipts, { recursive: true });
  await rename(`${receipts}.saved`, receipts);
  expect(JSON.parse(await readFile(receipts, "utf8"))[`discord:${f.requestId}`].settled).toBeUndefined();

  const asked = f.model.seen.length;
  await f.start();
  await f.presence();
  const answered = await f.post();
  expect(answered.status).toBeLessThan(300);
  // The journal's answer, not "unanswered", and no model call to produce it.
  expect(await f.settled()).toMatchObject({
    state: "settled",
    response: `${f.requestId} recovered: possibly ran`,
  });
  expect(f.model.seen.length).toBe(asked);
  expect(await f.effects()).toHaveLength(1);
}, 240_000);
