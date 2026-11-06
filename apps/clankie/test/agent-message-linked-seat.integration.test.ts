/**
 * #162: a receipt on a seat that lives on a linked machine. The real signed relay,
 * MCP, service and captain reach that machine's real Herdr through a real encrypted
 * loopback machine join, so the seat is fleet-qualified end to end. Only the harness
 * is a stand-in: a recorded `codex` queue, or a recorded native control.
 */
import type { SeatControl, SeatEvent } from "@clankie/agent-hosts";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { closes, decoded, fixture } from "./fixtures/agent-message-connector.ts";
import { loopbackJoinedMachine } from "./fixtures/loopback-joined-machine.ts";

vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => {
    throw new Error("No model call is permitted in this native receipt proof");
  },
}));
vi.mock("@clankie/agent-transcript", async (original) => ({
  ...(await original<object>()),
  readCodexGoal: async () => undefined,
  readClaudeSubagents: async () => undefined,
  readCodexSubagents: async () => undefined,
}));
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.HIRE_RECEIPT_NATIVE_TEST !== "1");

/** A machine with one pane whose occupant Herdr reports as this Codex session. */
async function linkedPane(session: string) {
  const machine = await loopbackJoinedMachine();
  closes.push(machine.close);
  const created = JSON.parse(
    await machine.herdrCli(["workspace", "create", "--cwd", machine.home, "--label", "seat", "--no-focus"]),
  );
  const pane = created.result.root_pane.pane_id as string;
  await machine.herdrCli(["pane", "run", pane, `${machine.home}/bin/codex ${session} --no-daemon`]);
  await expect
    .poll(async () => JSON.parse(await machine.run(["agent", "list"])).result.agents.length, {
      timeout: 10_000,
    })
    .toBe(1);
  return { machine, pane };
}

/** A recorded native control: admission through the service's own fence, exact-input events. */
function recordedControl(sessionId: string) {
  let release = () => {};
  const finished = new Promise<void>((resolve) => {
    release = resolve;
  });
  const messageId = "linked-input-1";
  const admitted: string[] = [];
  let reads = 0;
  const control: SeatControl = {
    ref: { harness: "codex", sessionId, paneId: "unused" },
    status: async () => "idle",
    interrupt: async () => false,
    close: async () => {},
    send: async (message, options) => {
      if (options?.beforeDispatch && !(await options.beforeDispatch()))
        return { outcome: "offline", detail: "The original occupant changed" };
      admitted.push(message);
      return { outcome: "accepted", state: "started", deliveryStage: "consumed", messageId };
    },
    settled: async (): Promise<SeatEvent> => {
      if (++reads === 1) return { type: "turn_started", at: new Date().toISOString(), messageId };
      await finished;
      return { type: "turn_completed", at: new Date().toISOString(), messageId, ok: true, text: "Done." };
    },
  };
  return { control, admitted, release };
}

const stages = (status: { receipt: { progress: { stage: string }[] } }) =>
  status.receipt.progress.map((entry) => entry.stage);

nativeIt("reads every stage back from an attached seat on a linked machine", async () => {
  const session = randomUUID();
  const { machine } = await linkedPane(session);
  const native = recordedControl(session);
  const f = await fixture({ control: native.control }, machine);
  expect(f.seat).toMatchObject({ fleet: "pc", seatId: expect.stringMatching(/^pc\/term_/u) });
  const client = await f.client();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: { agent: "herdr:" + f.seat.seatId, message: "Linked input", receipt: true },
    }),
  );
  expect(sent.status).toBe("delivered");
  expect(native.admitted).toHaveLength(1);
  const status = async () =>
    decoded(
      await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
    );
  await expect.poll(async () => stages(await status()), { timeout: 10_000 }).toEqual(["delivered", "read"]);
  native.release();
  await expect
    .poll(async () => stages(await status()), { timeout: 10_000 })
    .toEqual(["delivered", "read", "acted_on", "answered"]);
  expect(native.admitted).toHaveLength(1);
});

nativeIt("refuses a linked seat whose occupant changed before native admission", async () => {
  const session = randomUUID();
  const { machine, pane } = await linkedPane(session);
  const native = recordedControl(session);
  const f = await fixture({ control: native.control }, machine);
  const client = await f.client();
  const replacement = randomUUID();
  f.beforeNative(async () => {
    await machine.switchSession(replacement);
    await expect
      .poll(
        async () => JSON.parse(await machine.run(["pane", "get", pane])).result.pane.agent_session?.value,
        {
          timeout: 10_000,
        },
      )
      .toBe(replacement);
  });
  const result = await client.callTool({
    name: "message_agent",
    arguments: { agent: "herdr:" + f.seat.seatId, message: "Stale occupant", receipt: true },
  });
  expect(native.admitted).toEqual([]);
  expect(decoded(result)).toMatchObject({
    status: "offline",
    detail: expect.stringContaining("Nothing was sent"),
  });
});

nativeIt("reads a Codex CLI queue on a linked machine back as queued and no further", async () => {
  const session = randomUUID();
  const { machine } = await linkedPane(session);
  const f = await fixture(undefined, machine);
  expect(f.seat).toMatchObject({ fleet: "pc", seatId: expect.stringMatching(/^pc\/term_/u) });
  const client = await f.client();
  const sent = decoded(
    await client.callTool({
      name: "message_agent",
      arguments: { agent: "herdr:" + f.seat.seatId, message: "Linked queue", receipt: true },
    }),
  );
  expect(sent).toMatchObject({ status: "queued", receiptId: expect.any(String) });
  expect(await machine.codexCalls()).toEqual([
    ["queue", "--thread", session, "--message", expect.stringContaining("Linked queue")],
  ]);
  const status = async () =>
    decoded(
      await client.callTool({ name: "message_agent_status", arguments: { receiptId: sent.receiptId } }),
    );
  expect(await status()).toMatchObject({ receipt: { agent: "herdr:" + f.seat.seatId, delivery: "queued" } });
  // The CLI answers with acceptance alone, so there is no input ID to follow.
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect(stages(await status())).toEqual(["queued"]);
  const other = await (
    await f.client("app-b")
  ).callTool({
    name: "message_agent_status",
    arguments: { receiptId: sent.receiptId },
  });
  expect(JSON.stringify(other)).not.toContain("queued");
});
