/**
 * #341: a Claude hire whose model Claude refuses auto mode for is refused
 * before any native start, with Claude's own reason. Without the check, Claude
 * silently falls back to per-command approval and the worker stalls at its
 * first command.
 *
 * The hire runs through the real store and Claude adapter. The auto mode
 * answer comes from the installed `claude` when CLAUDE_AUTO_MODE_NATIVE_TEST=1
 * (no prompt is sent, so no model call), and otherwise from a replay of the
 * control-protocol answers Claude Code 2.1.316 gave for those models.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { probeClaudeAutoMode } from "../src/captain/claude-auto-mode.ts";
import { createClaudeWorkerSeatAdapter, SeatHookLog } from "../src/captain/claude-worker-seat.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../src/captain/herdr-watch.ts";

const native = process.env.CLAUDE_AUTO_MODE_NATIVE_TEST === "1";
const roots: string[] = [];
const stores: HerdrWatchStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Claude Code 2.1.316's control-protocol answers, replayed for the CI run. */
async function replayClaude(root: string): Promise<string> {
  const path = join(root, "claude");
  await writeFile(
    path,
    `#!/usr/bin/env node
const fs = require("node:fs");
const model = process.argv[process.argv.indexOf("--model") + 1];
fs.appendFileSync(${JSON.stringify(join(root, "argv.jsonl"))}, JSON.stringify(process.argv.slice(2)) + "\\n");
let buffer = "", asked = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\\n"); end >= 0; end = buffer.indexOf("\\n")) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    fs.appendFileSync(${JSON.stringify(join(root, "stdin.jsonl"))}, JSON.stringify(message) + "\\n");
    const id = message.request_id, subtype = message.request?.subtype;
    const reply = (response) => process.stdout.write(JSON.stringify({ type: "control_response", response: { request_id: id, ...response } }) + "\\n");
    if (subtype === "initialize") reply({ subtype: "success", response: { commands: [] } });
    else if (subtype === "set_permission_mode" && asked++ === 0)
      // The gate reads a remote switch at startup and answers this until it has.
      reply({ subtype: "error", error: "Cannot set permission mode to auto: auto mode availability is not known yet \\u00b7 ask again", error_code: "auto_mode_unavailable" });
    else if (subtype === "set_permission_mode")
      reply(model === "claude-haiku-4-5"
        ? { subtype: "error", error: "Cannot set permission mode to auto: auto mode unavailable for this model", error_code: "auto_mode_model" }
        : { subtype: "success", response: { mode: "auto" } });
  }
});
process.stdin.on("end", () => process.exit(0));
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "claude-auto-mode-hire-"));
  roots.push(root);
  const executable = native ? undefined : await replayClaude(root);
  const agent: HerdrAgentSnapshot = {
    paneId: "w1:p1",
    terminalId: "term_auto_mode",
    agent: "claude",
    status: "idle",
    title: "worker",
    workingDirectory: root,
  };
  const probes: (string | undefined)[] = [];
  const adapter = createClaudeWorkerSeatAdapter({
    consent: async () => ({ approved: true }),
    hooks: new SeatHookLog(join(root, "hooks.json")),
    agent: async () => agent,
    transcript: async () => undefined,
    mailbox: { bound: () => true, deliver: async () => true },
    trackerDeny: () => [],
    autoMode: async (launch) => {
      probes.push(launch.model);
      return await probeClaudeAutoMode(launch, executable === undefined ? {} : { executable });
    },
    timing: { readyMs: 30, receiptMs: 30, pollMs: 1, firstTurnMs: 1 },
  });
  const runner = {
    createTab: vi.fn(async () => agent.paneId),
    startAgent: vi.fn<NonNullable<HerdrWatchRunner["startAgent"]>>(async () => undefined),
    get: vi.fn(async () => agent),
    resolveTerminal: vi.fn(async () => agent),
    wait: vi.fn(() => new Promise<HerdrAgentSnapshot>(() => undefined)),
    runInPane: vi.fn(async () => undefined),
    closePane: vi.fn(async () => undefined),
  } satisfies HerdrWatchRunner;
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner,
    workerAccountsReport: async () => ({
      machine: "local",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "claude",
          label: "fixture",
          home: root,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "claude-usage",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    }),
    seatAdapters: [adapter],
    maximumTrustMode: async () => false,
  });
  stores.push(store);
  const hire = (model: string) =>
    store.spawnSeat(
      {
        schemaVersion: 1,
        harness: "claude",
        model,
        effort: "medium",
        effortReason: "Proves the auto mode refusal at the hire boundary.",
        title: "worker",
        workingDirectory: root,
      },
      undefined,
      "the brief",
    );
  return { root, runner, probes, hire, executable };
}

it(`refuses a hire Claude won't run in auto mode before anything starts (${native ? "installed claude" : "2.1.316 replay"})`, async () => {
  const f = await fixture();
  const result = await f.hire("claude-haiku-4-5");
  expect(result).toMatchObject({
    outcome: "failed",
    detail: expect.stringMatching(
      /^auto_mode_unavailable: Claude refuses auto mode for claude-haiku-4-5 \(auto_mode_model: /u,
    ),
  });
  expect(f.probes).toEqual(["claude-haiku-4-5"]);
  // Nothing native ran in the pane, and the empty pane was given back.
  expect(f.runner.startAgent).not.toHaveBeenCalled();
  expect(f.runner.closePane).toHaveBeenCalledWith("w1:p1");
  if (f.executable !== undefined) {
    // The probe sent only control requests: no prompt, so no model call.
    const sent = (await readFile(join(f.root, "stdin.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(sent.map((message) => message.type)).toEqual(sent.map(() => "control_request"));
    expect(sent.map((message) => message.request.subtype)).toEqual([
      "initialize",
      "set_permission_mode",
      "set_permission_mode",
    ]);
  }
}, 60_000);

it(`a model Claude runs in auto mode passes the check (${native ? "installed claude" : "2.1.316 replay"})`, async () => {
  const f = await fixture();
  await expect(
    probeClaudeAutoMode(
      { cwd: f.root, model: "claude-opus-4-6" },
      f.executable === undefined ? {} : { executable: f.executable },
    ),
  ).resolves.toEqual({ available: true });
}, 60_000);

it("a Claude that cannot answer leaves the hire unchecked rather than refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-auto-mode-missing-"));
  roots.push(root);
  await expect(
    probeClaudeAutoMode({ cwd: root, model: "claude-haiku-4-5" }, { executable: join(root, "no-claude") }),
  ).resolves.toMatchObject({ available: undefined });
});
