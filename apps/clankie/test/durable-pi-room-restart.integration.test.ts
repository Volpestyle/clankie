import { afterEach, expect, it } from "vitest";
import { cleanups, privateService } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284's prototype lane, the regression base for rolling it out (#368).
// Discord is not involved; its delivery hop is proven in
// apps/discord-bridge/test/durable-pi-room-delivery.integration.test.ts.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("resumes a turn killed mid-shell with no new input: the shell surfaces as possibly ran and nothing repeats", async () => {
  const f = await privateService();
  await f.killMidShell();
  const asked = f.model.seen.length;
  await f.start();
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled", response: `${f.requestId} recovered: possibly ran` });
  // Completed model steps came from the journal: after the restart the model was asked once, for the answer.
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
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
  const result = await f.settled();
  // The first test is the control: the same kill and restart with unchanged settings settles.
  expect(result).toMatchObject({ state: "failed", code: "captain_turn_failed" });
  expect(f.model.seen.length).toBe(asked);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  expect((await f.journal()).steps.length).toBe(steps);
}, 240_000);
