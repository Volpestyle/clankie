import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { cleanups, privateService, type ChatMessage } from "./fixtures/durable-pi-room-service.ts";

// ADR 0284 with ADR 0118 (#368): the same sender's follow-up steers the durable
// room's running turn, as in any room, and is journaled there first. The real
// service is killed and restarted; the model is a scripted loopback endpoint,
// so this proves what the resumed turn hears, not model behaviour.
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

const MARK = "FOLLOWUP-MARK";
/** How many user messages carrying the follow-up the model was sent. */
const heard = (messages: readonly ChatMessage[]) =>
  messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes(MARK))
    .length;
const toolCount = (messages: readonly ChatMessage[]) =>
  messages.filter((message) => message.role === "tool").length;

function followUp(request: DiscordPresenceChannelTurnRequest, id: string): DiscordPresenceChannelTurnRequest {
  return {
    ...request,
    deliveryId: id,
    identity: { ...request.identity, correlationId: id },
    trigger: { ...request.trigger, id, body: `${MARK}: and say which room this is.` },
  };
}

it.each([
  ["the original first, as the bridge redelivers", false],
  ["the follow-up first, which resumes the original itself", true],
])(
  "a follow-up steered into a turn that is then killed is heard by the resumed turn and answered by it: %s",
  async (_order, followUpFirst) => {
    const f = await privateService({
      reply: (messages, { requestId, script }) =>
        toolCount(messages) === 0
          ? { call: { name: "memory", args: { action: "write", text: requestId } } }
          : toolCount(messages) === 1
            ? { call: { name: "bash", args: { command: `exec node '${script}'` } } }
            : { text: `${requestId} answered; heard follow-up ${heard(messages)}` },
    });
    const second = followUp(f.request, `${f.requestId}-follow`);
    await f.start();
    await f.presence();
    expect((await f.post()).status).toBe(202);
    await f.until(async () => ((await f.effects()).length === 1 ? true : undefined));
    // The same sender writes again while the shell runs: it joins the running turn.
    expect((await f.post(second)).status).toBe(202);
    await f.until(async () =>
      (await f.journal()).steers?.some((steer) => steer.deliveryId === second.deliveryId) ? true : undefined,
    );
    expect((await f.journal()).steers).toMatchObject([
      { deliveryId: second.deliveryId, after: "tool:call_bash_1" },
    ]);
    expect(await f.handoffs(second.deliveryId)).toMatchObject([{ state: "running" }]);
    await f.stop("SIGKILL");
    await f.stopTool();
    const asked = f.model.seen.length;

    await f.start();
    await f.presence();
    for (const request of followUpFirst ? [second, f.request] : [f.request, second])
      expect((await f.post(request)).status).toBe(202);
    expect(await f.settled()).toMatchObject({
      state: "settled",
      response: `${f.requestId} answered; heard follow-up 1`,
    });
    expect(heard(f.model.seen.at(-1)!)).toBe(1);
    expect(await f.settled(second.deliveryId)).toMatchObject({
      state: "absorbed",
      replyDeliveryId: f.requestId,
    });
    expect(f.model.seen.length).toBe(asked + 1);
    expect(await f.effects()).toHaveLength(1);
    expect(await f.handoffs(second.deliveryId)).toMatchObject([{ state: "completed" }]);
  },
  240_000,
);

it("a follow-up the turn read before the kill is replayed at the same point, once", async () => {
  const gate = (root: string) => join(root, "gate.open");
  const f = await privateService({
    reply: (messages, { requestId, script, root }) =>
      toolCount(messages) === 0
        ? { call: { name: "memory", args: { action: "write", text: requestId } } }
        : toolCount(messages) === 1
          ? { call: { name: "bash", args: { command: `exec node '${join(root, "gate.mjs")}'` } } }
          : toolCount(messages) === 2
            ? { call: { name: "bash", args: { command: `exec node '${script}'` } } }
            : { text: `${requestId} answered; heard follow-up ${heard(messages)}` },
  });
  // The first shell call runs until the test opens its gate, so the follow-up arrives mid-tool.
  await writeFile(
    join(f.root, "gate.mjs"),
    `import {appendFileSync,existsSync} from 'node:fs';
appendFileSync(${JSON.stringify(join(f.root, "gate.txt"))}, "ran\\n");
const wait = () => existsSync(${JSON.stringify(gate(f.root))}) ? process.exit(0) : setTimeout(wait, 50);
wait();
setTimeout(() => process.exit(1), 300000);
`,
  );
  const second = followUp(f.request, `${f.requestId}-follow`);
  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  await f.until(
    async () => ((await f.journal().catch(() => undefined))?.steps.length ?? 0) >= 4 || undefined,
  );
  expect((await f.post(second)).status).toBe(202);
  await f.until(async () =>
    (await f.journal()).steers?.some((steer) => steer.deliveryId === second.deliveryId) ? true : undefined,
  );
  await writeFile(gate(f.root), "");
  // The turn reads the follow-up, then starts the blocking shell; kill it there.
  await f.until(async () => ((await f.effects()).length === 1 ? true : undefined));
  const before = f.model.seen.length;
  expect(heard(f.model.seen.at(-1)!)).toBe(1);
  await f.stop("SIGKILL");
  await f.stopTool();

  await f.start();
  await f.presence();
  expect((await f.post()).status).toBe(202);
  expect(await f.settled()).toMatchObject({
    state: "settled",
    response: `${f.requestId} answered; heard follow-up 1`,
  });
  // One new model request, carrying the follow-up once and after the gate's result, as before the kill.
  expect(f.model.seen.length).toBe(before + 1);
  const resumed = f.model.seen.at(-1)!;
  expect(heard(resumed)).toBe(1);
  const order = resumed.map((message) => message.role);
  const followUpAt = resumed.findIndex(
    (message) => message.role === "user" && JSON.stringify(message.content).includes(MARK),
  );
  expect(order.slice(0, followUpAt).filter((role) => role === "tool")).toHaveLength(2);
  expect((await f.post(second)).status).toBe(202);
  expect(await f.settled(second.deliveryId)).toMatchObject({
    state: "absorbed",
    replyDeliveryId: f.requestId,
  });
  expect(f.model.seen.length).toBe(before + 1);
  expect(await f.effects()).toHaveLength(1);
}, 240_000);
