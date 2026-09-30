/** Opt-in real hire: pnpm --filter @clankie/clankie verify-codex-seat OUT.json */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner, parseHerdrAgentResult } from "../src/captain/herdr-watch.ts";
import { readHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";

assert.equal(
  process.env.HERDR_ENV,
  "1",
  "Run inside Herdr; the verifier creates and closes only its own seat",
);
assert.ok(process.argv[2], "Supply an output JSON path");
const output = resolve(process.argv[2]);
const cwd = await realpath(await mkdtemp(join(tmpdir(), "vuh1459-captain-")));
const exec = promisify(execFile);
const evidence: Record<string, unknown> = { cwd, startedAt: new Date().toISOString() };
// A scratch captain runs the real tool bank and hire path without restarting or
// changing the user's service. Only unrelated browser/MCP dependencies are inert.
const captain = createCaptain(
  {
    herdrAvailable: () => true,
    embodiment: {},
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
  } as unknown as CaptainDeps,
  {
    repoRoot: resolve(import.meta.dirname, "../../.."),
    stateDir: join(cwd, "state"),
    settings: new SettingsStore(join(cwd, "settings.json")),
  },
);
let seatId: string | undefined;
try {
  const bank = await captain.laneToolBank("operator", "global-default");
  const call = async (name: string, args: Record<string, unknown>) => {
    const tool = bank.tools.find((tool) => tool.name === name);
    assert.ok(tool, `Missing ${name}`);
    const result = await tool.call(args);
    const text = result.content.find((part) => part.type === "text");
    assert.ok(text?.type === "text");
    return JSON.parse(text.text);
  };
  const hire = await call("hire_agent", {
    harness: "codex",
    title: "VUH1459 verification",
    workingDirectory: cwd,
    model: "gpt-6-astra",
    skills: "plain",
    brief: "Reply with exactly VUH1459_CAPTAIN_HIRE_OK. Do not use tools.",
  });
  evidence.hire = hire;
  assert.equal(hire.outcome, "spawned", JSON.stringify(hire));
  seatId = hire.seat.seatId as string;
  const pane = await createHerdrWatchRunner().resolveTerminal(seatId);
  assert.ok(pane, "Hired terminal must resolve to a Herdr pane");
  const paneId = pane.paneId;
  const observed = parseHerdrAgentResult((await exec("herdr", ["agent", "get", paneId])).stdout);
  assert.ok(observed.session, "Herdr must know the protocol's durable session ID");
  evidence.herdr = observed;
  evidence.nativeProcess = JSON.parse(
    (await exec("herdr", ["pane", "process-info", "--pane", paneId])).stdout,
  );
  const waitForReply = async (expected: string) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const transcript = readHerdrSeatTranscript("codex", observed.session);
      if (
        transcript?.entries.some(
          (entry) => entry.type === "message" && entry.role === "agent" && entry.text.includes(expected),
        )
      )
        return transcript;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`No native transcript reply: ${expected}`);
  };
  evidence.firstTranscript = await waitForReply("VUH1459_CAPTAIN_HIRE_OK");
  evidence.message = await call("message_seat", {
    seat: seatId,
    message: "Reply with exactly VUH1459_CAPTAIN_MESSAGE_OK. Do not use tools.",
  });
  assert.equal((evidence.message as { outcome: string }).outcome, "delivered");
  evidence.finalTranscript = await waitForReply("VUH1459_CAPTAIN_MESSAGE_OK");
  evidence.view = (
    await exec("herdr", ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", "100"])
  ).stdout;
  console.log(JSON.stringify({ hire: evidence.hire, message: evidence.message, session: observed.session }));
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  if (seatId)
    evidence.closed = await captain.serveOperatorConversation({ schemaVersion: 1, op: "close_seat", seatId });
  await captain.close();
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence: ${output}`);
}
