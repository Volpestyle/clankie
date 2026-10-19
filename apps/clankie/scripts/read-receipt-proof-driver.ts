// Drives a running proof-host.ts from this native pane. The stock worker bridge
// (fleet-mcp.mjs over stdio) and the source CLI are the callers; both inherit
// this pane's real process ancestry. Nothing here can grant admission.
//
//   node --import ./scripts/dependency-types.mjs \
//     apps/clankie/scripts/read-receipt-proof-driver.ts ROOT read|runner|measure
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";

const repo = join(import.meta.dirname, "../../..");
const root = process.argv[2]!;
const mode = process.argv[3];
if (mode !== "read" && mode !== "runner" && mode !== "measure")
  throw new Error("Expected ROOT read|runner|measure");
const { issue } = JSON.parse(await readFile(join(root, "host.json"), "utf8")) as {
  issue: { identifier: string };
};
const env = { ...process.env, CLANKIE_STATE: root };
const steps: Record<string, unknown>[] = [];
const record = (step: string, value: Record<string, unknown>) => {
  steps.push({ step, at: new Date().toISOString(), ...value });
  console.log(JSON.stringify({ step, ...value }));
};

/** The stock stdio bridge a native Claude/Codex seat runs, linked by CLANKIE_STATE. */
function bridge() {
  const child = spawn(process.execPath, [join(repo, "integrations/claude-plugin/worker/bin/fleet-mcp.mjs")], {
    env: { ...env, CLANKIE_SEAT_PARENT_ARGV: "claude" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  const stderr: string[] = [];
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      pending.set(++id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return {
    async start() {
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "local-vuh-13-proof", version: "1" },
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      return request("tools/list", {});
    },
    async call(args: Record<string, unknown>) {
      const message = await request("tools/call", { name: "clankie_call", arguments: args });
      const result = message.result as {
        content: { text: string }[];
        structuredContent?: Record<string, unknown>;
        isError?: boolean;
      };
      return {
        isError: result.isError === true,
        body: result.structuredContent ?? JSON.parse(result.content[0]!.text),
        text: result.content.map((entry) => entry.text),
      };
    },
    stop() {
      child.kill("SIGTERM");
      return stderr;
    },
  };
}

/** The shipped native CLI, through the same pane's linked fleet transport. */
function cli(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [join(repo, "apps/tui/bin/clankie.ts"), "agents", "call-receipt", ...args],
      {
        env: { ...env, ...overrides },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}
const parsed = (output: { stdout: string }) => {
  try {
    return JSON.parse(output.stdout);
  } catch {
    return undefined;
  }
};

const seat = bridge();
const listed = await seat.start();
const tools = ((listed.result as { tools?: { name: string }[] })?.tools ?? []).map((tool) => tool.name);
record("bridge.tools", { tools });

if (mode === "measure") {
  // Alternate eligible READs (proof hooks, journal admission) with an ineligible read, and
  // an eligible read whose selector exceeds the 1 KiB proof cap so it can't retain a proof.
  const cases = [
    ["get_issue", "linear_get_issue", { id: issue.identifier }],
    ["get_issue.oversized", "linear_get_issue", { id: `${issue.identifier}-${"x".repeat(1_100)}` }],
    ["list_issues", "linear_list_issues", { limit: 5 }],
  ] as const;
  const timings = new Map<string, number[]>();
  for (let round = 0; round < 20; round++) {
    for (const [label, name, args] of cases) {
      const started = performance.now();
      const result = await seat.call({ name, arguments: args });
      const ms = performance.now() - started;
      timings.set(label, [...(timings.get(label) ?? []), ms]);
      record(`measure.${label}`, { ms, outcome: result.body.outcome, isError: result.body.isError });
    }
  }
  for (const [label, values] of timings) {
    const sorted = values.toSorted((left, right) => left - right);
    record(`measure.${label}.summary`, {
      runs: sorted.length,
      medianMs: (sorted[(sorted.length - 1) >> 1]! + sorted[sorted.length >> 1]!) / 2,
      p90Ms: sorted[Math.ceil(sorted.length * 0.9) - 1],
      maxMs: sorted.at(-1),
    });
  }
} else if (mode === "runner") {
  const runs = await seat.call({ name: "linear_list_runs", arguments: {} });
  record("original.list_runs.runner", runs);
  const receiptId = runs.body.receiptId as string;
  record("cli.inspect.list_runs.runner", parsed(await cli(["inspect", receiptId])) ?? {});
  record(
    "cli.abandon.list_runs.runner",
    parsed(await cli(["abandon-read", receiptId, "--reason", "Production-shaped runner read"])) ?? {},
  );
  record("bridge.lookup.list_runs.runner", await seat.call({ receiptId }));
} else {
  const getIssue = await seat.call({ name: "linear_get_issue", arguments: { id: issue.identifier } });
  record("original.get_issue", getIssue);
  const getUser = await seat.call({ name: "linear_get_user", arguments: { query: "me" } });
  record("original.get_user", getUser);
  const listRuns = await seat.call({ name: "linear_list_runs", arguments: {} });
  record("original.list_runs", listRuns);
  const save = await seat.call({
    name: "linear_save_issue",
    arguments: { id: issue.identifier, title: "LOCAL-VUH-13 proof mutation" },
  });
  record("original.save_issue", save);
  const mistyped = await seat.call({ name: "linear_get_issue", arguments: { id: "LOCAL-404" } });
  record("original.get_issue.mistyped", mistyped);
  record(
    "cli.inspect.get_issue.mistyped",
    parsed(await cli(["inspect", mistyped.body.receiptId as string])) ?? {},
  );
  const readId = getIssue.body.receiptId as string;
  const userId = getUser.body.receiptId as string;
  const writeId = save.body.receiptId as string;

  record("cli.inspect.get_issue", parsed(await cli(["inspect", readId])) ?? {});
  const abandoned = await cli(["abandon-read", readId, "--reason", "LOCAL-VUH-13 disposable proof"]);
  const abandonedBody = parsed(abandoned);
  record("cli.abandon.get_issue", { code: abandoned.code, body: abandonedBody, stderr: abandoned.stderr });
  const abandonmentId = abandonedBody?.abandonmentId as string | undefined;
  record(
    "cli.inspect.get_issue.with_abandonment",
    parsed(await cli(["inspect", readId, ...(abandonmentId ? ["--abandonment-id", abandonmentId] : [])])) ??
      {},
  );
  const second = await cli(["abandon-read", readId, "--reason", "A different decision"]);
  record("cli.abandon.get_issue.second_decision", {
    code: second.code,
    body: parsed(second),
    stderr: second.stderr,
  });
  record("bridge.lookup.get_issue.after_abandon", await seat.call({ receiptId: readId }));

  record(
    "bridge.abandon.get_user",
    await seat.call({ receiptId: userId, action: "abandon-read", reason: "Stock bridge recovery path" }),
  );
  record("cli.inspect.list_runs", parsed(await cli(["inspect", listRuns.body.receiptId as string])) ?? {});

  record("cli.inspect.save_issue", parsed(await cli(["inspect", writeId])) ?? {});
  const writeAbandon = await cli(["abandon-read", writeId, "--reason", "Writes are never abandonable"]);
  record("cli.abandon.save_issue", {
    code: writeAbandon.code,
    body: parsed(writeAbandon),
    stderr: writeAbandon.stderr,
  });
  record("cli.inspect.missing", parsed(await cli(["inspect", randomUUID()])) ?? {});
  record(
    "bridge.inspect.caller_read_assertion",
    await seat.call({ receiptId: writeId, action: "inspect", classification: "READ" }),
  );
  const spoof = await cli(["inspect", readId], { HERDR_PANE_ID: "w0:p999" });
  record("cli.inspect.spoofed_pane", {
    code: spoof.code,
    body: parsed(spoof),
    stderr: spoof.stderr.slice(0, 2000),
  });

  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
  const off = await cli(["inspect", readId]);
  record("cli.inspect.tools_off", { code: off.code, body: parsed(off), stderr: off.stderr.slice(0, 2000) });
  await settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "connected" } }));
  record("cli.inspect.tools_restored", parsed(await cli(["inspect", readId])) ?? {});

  // Last: replace this proof's own store incarnation, then try recovery against it.
  await rename(join(root, "tracker"), join(root, "tracker-retired"));
  await createLocalTracker({ directory: join(root, "tracker") }).call("get_user", { query: "me" });
  const replaced = await cli(["inspect", readId]);
  record("cli.inspect.store_replaced", {
    code: replaced.code,
    body: parsed(replaced),
    stderr: replaced.stderr.slice(0, 2000),
  });
  const replacedAbandon = await cli(["abandon-read", userId, "--reason", "After store replacement"]);
  record("cli.abandon.store_replaced", {
    code: replacedAbandon.code,
    body: parsed(replacedAbandon),
    stderr: replacedAbandon.stderr.slice(0, 2000),
  });
}
record("bridge.stderr", { lines: seat.stop() });
await writeFile(join(root, `driver-${mode}.json`), `${JSON.stringify(steps, null, 2)}\n`, { mode: 0o600 });
