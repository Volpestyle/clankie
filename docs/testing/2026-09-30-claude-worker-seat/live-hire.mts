// VUH-1458 live check: a real interactive Claude hire through HerdrWatchStore
// with the Claude worker adapter and this Mac's real consent state.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  HerdrWatchStore,
  createHerdrWatchRunner,
  type HerdrWatchRunner,
} from "../../../apps/clankie/src/captain/herdr-watch.ts";
import {
  SeatHookLog,
  claudeWorkerChannelConsent,
  createClaudeWorkerSeatAdapter,
} from "../../../apps/clankie/src/captain/claude-worker-seat.ts";

const S = process.argv[2]!; // a private scratch directory
const log = (label: string, value: unknown) =>
  console.log(
    `${new Date().toISOString()} ${label} ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
const hooks: unknown[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => (body += chunk));
  request.on("end", () => {
    hooks.push({
      url: request.url,
      auth: request.headers.authorization?.slice(0, 18),
      body: JSON.parse(body || "null"),
    });
    log("HOOK", { url: request.url, body: JSON.parse(body || "null") });
    response
      .writeHead(200, { "content-type": "application/json" })
      .end('{"schemaVersion":1,"recorded":true}');
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

const real = createHerdrWatchRunner();
// Verification harness only: never accept the owner's development-channel
// warning; load the worker plugin inline (hooks, no channel); report to the capture server.
const runner: HerdrWatchRunner = {
  ...real,
  createTab: (options) =>
    real.createTab!({
      ...options,
      env: {
        ...options.env,
        CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${port}`,
        CLANKIE_OPERATOR_TOKEN: "clankie_op_" + "v".repeat(43),
      },
    }),
  startAgent: (options) => {
    const args = [...(options.args ?? [])];
    const flag = args.indexOf("--dangerously-load-development-channels");
    if (flag >= 0) args.splice(flag, 2);
    args.push(
      "--plugin-dir",
      fileURLToPath(new URL("../../../integrations/claude-plugin/worker", import.meta.url)),
      "--model",
      "haiku",
    );
    log("START_ARGS", args);
    return real.startAgent!({ ...options, args });
  },
};
const seatHooks = new SeatHookLog(`${S}/live/hooks.json`);
const adapter = createClaudeWorkerSeatAdapter({
  consent: () => claudeWorkerChannelConsent(),
  hooks: seatHooks,
  agent: (paneId) => runner.get(paneId),
  transcript: async (agent) => runner.transcript?.(agent as never),
  mailbox: { bound: () => false, deliver: async () => false },
});
const store = new HerdrWatchStore(`${S}/live/watches.json`, {
  runner,
  seatAdapters: [adapter],
  summariesPath: `${S}/live/summaries.json`,
});
let woke: (prompt: string) => void = () => undefined;
const wake = new Promise<string>((resolve) => (woke = resolve));
store.start(async (_conversation, prompt) => woke(prompt));

const brief = "BRIEF-1458: without using any tools, reply with exactly: brief-done";
const hired = await store.spawnSeat(
  {
    schemaVersion: 1,
    harness: "claude",
    title: "vuh-1458 live check",
    workingDirectory: fileURLToPath(new URL("../../../.data/vuh-1458-live", import.meta.url)),
  },
  undefined,
  brief,
);
log("HIRE", hired);
if (hired.outcome !== "spawned") process.exit(1);
const seatId = hired.seat.seatId;
const settle = async (label: string) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const agent = await runner.resolveTerminal(seatId);
    if (agent && ["idle", "done"].includes(agent.status)) return log(label, agent.status);
    if (Date.now() > deadline) return log(label, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};
await settle("BRIEF_SETTLED");
log("MESSAGE", await store.sendToSeat(seatId, "Now reply with exactly: follow-up-done"));
log(
  "WATCH",
  await store.watch("live-check", seatId, "harvest the follow-up").catch((error: Error) => error.message),
);
const prompt = await Promise.race([
  wake,
  new Promise<string>((resolve) => setTimeout(() => resolve("no wake"), 120_000)),
]);
log("WAKE", prompt);
const agent = await runner.resolveTerminal(seatId);
const transcript = agent ? await runner.transcript?.(agent) : undefined;
log(
  "TRANSCRIPT_TAIL",
  transcript?.entries
    .filter((entry) => entry.type === "message")
    .slice(-4)
    .map((entry) => ({
      role: (entry as { role: string }).role,
      text: (entry as { text: string }).text.slice(0, 160),
    })),
);
log("SESSION", agent?.session);
log(
  "FILE",
  await readFile(new URL("../../../.data/vuh-1458-live/hello.txt", import.meta.url), "utf8").catch(
    () => "missing",
  ),
);
await new Promise((resolve) => setTimeout(resolve, 3000));
log(
  "HOOKS_SEEN",
  hooks
    .map((hook) => (hook as { body: { event: string; lastMessage?: string } }).body)
    .map((body) => ({ event: body.event, lastMessage: body.lastMessage })),
);
log("CLOSE", await store.closeSeat(seatId));
store.close();
server.close();
