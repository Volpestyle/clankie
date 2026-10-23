/**
 * Live proof for a Claude seat's exact-task Stop (VUH-2680).
 *
 *   node --import ./scripts/dependency-types.mjs apps/clankie/scripts/prove-claude-stop.ts PANE OUT_DIR
 *
 * PANE is a throwaway interactive Claude the prover started itself, idle, with
 * an empty input line. Every Herdr call is fenced to that one pane: any other
 * target throws before Herdr runs. The real Herdr runner, Claude seat control,
 * HerdrWatchStore.stopNativeTask, SeatOutbox and settleStoppedTurn run here;
 * the service's HTTP/authority layer and the worker channel do not (the hook
 * log's SessionStart is recorded here, as the service would on the plugin's hook).
 *
 * Phases: (a) mid-turn Stop with a Queued message held behind the turn;
 * (b) mid-turn Stop refused for an unsent draft, with no key sent.
 */
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { OperatorSeatEventKindSchema } from "@clankie/protocol";
import { pumpSeatEvents } from "../../tui/src/command/mcp.ts";
import { SeatHookLog, createClaudeWorkerSeatAdapter } from "../src/captain/claude-worker-seat.ts";
import {
  HerdrWatchStore,
  createHerdrWatchRunner,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";
import { paneInputLine } from "../src/captain/pane-draft.ts";
import { SeatOutbox } from "../src/captain/seat-outbox.ts";
import { settleStoppedTurn } from "../src/captain/stopped-turn.ts";

const run = promisify(execFile);
const [pane, outArg] = process.argv.slice(2);
if (!pane || !outArg) throw new Error("usage: prove-claude-stop.ts PANE OUT_DIR");
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const log: Record<string, unknown>[] = [];
const note = (step: string, data: Record<string, unknown> = {}) => {
  const entry = { at: new Date().toISOString(), step, ...data };
  log.push(entry);
  console.log(JSON.stringify(entry));
};
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const real = createHerdrWatchRunner();
let terminalId: string | undefined;
const mine = (target: string) => {
  if (target !== pane && target !== terminalId) throw new Error(`refused: ${target} is not the proof pane`);
};
// Only what the Stop path reads or presses, and only for the proof pane.
const runner: HerdrWatchRunner = {
  get: async (target) => (mine(target), real.get(target)),
  resolveTerminal: async (target) => {
    mine(target);
    const agent = await real.resolveTerminal(target);
    if (agent) mine(agent.paneId);
    return agent;
  },
  wait: async (target, signal) => (mine(target), real.wait(target, signal)),
  readPane: async (target, source, format) => (mine(target), real.readPane!(target, source, format)),
  sendKeys: async (target, keys) => {
    mine(target);
    note("herdr.send-keys", { pane: target, keys });
    await real.sendKeys!(target, keys);
  },
};
const herdr = async (...args: string[]) => (await run("herdr", args)).stdout;
const screen = async (name: string, format: "text" | "ansi") => {
  const body = await runner.readPane!(pane, "visible", format);
  writeFileSync(join(out, `${name}.${format === "ansi" ? "ansi" : "txt"}`), body);
  return body;
};
const until = async (want: (agent: HerdrAgentSnapshot) => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const agent = await runner.get(pane);
    if (want(agent)) return agent;
    if (Date.now() > deadline) throw new Error(`timed out waiting; status ${agent.status}`);
    await sleep(250);
  }
};
const LONG =
  "Write a 1500-word short story about a lighthouse keeper who collects lost letters. Plain prose, no tools, no headings.";

const first = await runner.get(pane);
terminalId = first.terminalId;
if (first.agent !== "claude" || first.session === undefined)
  throw new Error(`proof pane must host a Claude session: ${JSON.stringify(first)}`);
const sessionId =
  first.session.kind === "id"
    ? first.session.value
    : first.session.value
        .split("/")
        .at(-1)!
        .replace(/\.jsonl$/u, "");
note("pane", { pane, terminalId, session: first.session, status: first.status });
const hooks = new SeatHookLog(join(out, "hooks.json"));
hooks.record(pane, { schemaVersion: 1, event: "SessionStart", sessionId });
const adapter = createClaudeWorkerSeatAdapter({
  consent: async () => ({ approved: true }),
  hooks,
  agent: (target) => runner.get(target),
  transcript: async () => undefined,
  mailbox: { bound: () => false, deliver: async () => false },
  pane: {
    read: (target) => runner.readPane!(target, "visible", "ansi"),
    sendKeys: (target, keys) => runner.sendKeys!(target, keys),
  },
});
const watch = new HerdrWatchStore(join(out, "watch.json"), { runner, seatAdapters: [adapter] });
let authorityChecks = 0;
const authorize = async () => {
  authorityChecks += 1;
};

// (a) Stop mid-turn; a Queued message held behind the turn goes out at once.
await herdr("agent", "prompt", pane, LONG);
await until((agent) => agent.status === "working", 20_000);
// Long enough that Claude is streaming its reply: an Esc before the first
// output makes Claude put the prompt back in the input line instead.
await sleep(Number(process.env.STOP_AFTER_MS ?? 15_000));
const busy = await screen("a-busy-empty", "ansi");
note("a.busy-input-line", { line: paneInputLine("claude", busy) });
note("a.capabilities", { inputCapabilities: await watch.inputCapabilities(await runner.get(pane)) });

const outbox = new SeatOutbox({ turnHoldStaleMs: 180_000 });
const released: { at: number; content: string }[] = [];
const stopPump = new AbortController();
const pump = pumpSeatEvents(
  {
    notification: async (event) => {
      const content = (event as { params: { content: string } }).params.content;
      released.push({ at: Date.now(), content });
    },
  },
  {
    pollEvents: (waitMs, signal) =>
      outbox.poll(waitMs, signal, undefined, {
        schemaVersion: 1 as const,
        eventKinds: [...OperatorSeatEventKindSchema.options],
        ownerOrigin: true,
      }),
  },
  stopPump.signal,
  { waitMs: 200, retryMs: 20 },
);
while (!outbox.bound()) await sleep(20);
outbox.observeTurn(sessionId, "responding");
let admitted: string | undefined;
const queued = "Queued while you worked: reply with just the word RECEIVED.";
const held = outbox.deliver({
  kind: "watch",
  conversationId: "proof",
  source: "service",
  content: queued,
  wantsReply: false,
  delivery: "queue",
  onAdmitted: (state) => {
    admitted ??= state;
  },
});
await sleep(1_000);
note("a.queued-held", { admitted, releasedSoFar: released.length });

const observed = await watch.nativeTaskObservation(terminalId);
if (!observed) throw new Error("proof pane was not observed");
const stopAt = Date.now();
const stopped = await watch.stopNativeTask(terminalId, observed.binding, authorize);
const stopMs = Date.now() - stopAt;
note("a.stop", { result: stopped, ms: stopMs, authorityChecks });
if (stopped.outcome === "stopped")
  settleStoppedTurn(await runner.get(pane), {
    mailbox: () => undefined,
    conversation: () => "proof",
    outbox: () => outbox,
    publishWaiting: (conversationId, session) => note("a.publish-waiting", { conversationId, session }),
  });
const delivery = await Promise.race([held, sleep(10_000).then(() => "still held after 10s")]);
note("a.queued-released", {
  delivery,
  msAfterStop: released[0] === undefined ? null : released[0].at - stopAt,
});
await screen("a-after-stop", "text");
const after = await screen("a-after-stop", "ansi");
note("a.input-line-after-stop", { line: paneInputLine("claude", after) });
stopPump.abort();
outbox.close();
await pump;
if (released[0] && paneInputLine("claude", after).state === "empty") {
  // The worker channel is not running here; a Herdr prompt stands in for it.
  await herdr("agent", "prompt", pane, released[0].content, "--wait", "--timeout", "120000");
  await screen("a-queued-answered", "text");
}

// (b) A draft in the input line: Stop is refused and no key is sent.
await until((agent) => agent.status !== "working", 60_000);
await herdr("agent", "prompt", pane, LONG);
await until((agent) => agent.status === "working", 20_000);
await sleep(3_000);
await herdr("pane", "send-text", pane, "DRAFT do not send");
await sleep(800);
const draftScreen = await screen("b-draft-before", "ansi");
note("b.draft-input-line", { line: paneInputLine("claude", draftScreen) });
const keysBefore = log.filter((entry) => entry.step === "herdr.send-keys").length;
const again = await watch.nativeTaskObservation(terminalId);
const refused = await watch.stopNativeTask(terminalId, again!.binding, authorize);
note("b.stop", {
  result: refused,
  keysSent: log.filter((entry) => entry.step === "herdr.send-keys").length - keysBefore,
  statusAfter: (await runner.get(pane)).status,
});
await screen("b-draft-after", "text");
watch.close();
writeFileSync(join(out, "result.json"), `${JSON.stringify(log, null, 2)}\n`);
console.log(`proof written to ${out}`);
