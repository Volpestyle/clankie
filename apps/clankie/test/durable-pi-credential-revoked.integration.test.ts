import { afterEach, expect, it } from "vitest";
import { cleanups, defaultReply, privateService } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284 (#368): the model credential is revoked while a durable turn is down.
// The real service, Pi, journal, file memory and shell, killed mid-shell and started
// again; the scripted loopback model then refuses the credential with a 401.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it("a model credential revoked while the service was down fails the resumed turn closed, once", async () => {
  let revoked = false;
  const f = await privateService({
    reply: (messages, context) =>
      revoked ? { rejected: true } : defaultReply(messages, context.requestId, context.script),
  });
  await f.killMidShell();
  const asked = f.model.seen.length;
  revoked = true;

  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  const failed = await f.settled();
  expect(failed).toMatchObject({ state: "failed" });
  // The completed steps came from the journal; the provider was asked once, and Pi does
  // not retry a refused credential.
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  const journal = await f.journal();
  expect(journal.result).toBeDefined();
  expect(journal.steps.filter((step) => step.input.name === "bash")).toHaveLength(1);
  expect(await f.handoffs()).toMatchObject([{ state: "failed" }]);

  // Restoring the credential does not reopen a settled turn: the redelivery, and one after
  // another restart, answer from the saved result without asking the model or rerunning a tool.
  revoked = false;
  await f.post();
  expect(await f.settled()).toEqual(failed);
  await f.stop("SIGKILL");
  await f.start();
  await f.presence();
  await f.post();
  expect(await f.settled()).toEqual(failed);
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
}, 240_000);
