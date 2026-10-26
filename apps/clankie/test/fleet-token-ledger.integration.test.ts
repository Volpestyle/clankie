import { mkdtemp, mkdir, writeFile, copyFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { afterEach, expect, it } from "vitest";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import { SettingsStore } from "@clankie/settings";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { createFleetTokenLedger, readFleetTokenLedger } from "../src/fleet-token-ledger.ts";
import { createUsageRoutes } from "../src/usage-routes.ts";
import { runUsageCommand, formatUsageTable } from "../../tui/src/command/usage.ts";

const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const lead = "a383aa17-4977-4763-a3e6-6093b6a43127";
const codex = "01a1789c-1918-7412-949e-86a42e0aec98";
const at = "2026-10-24T23:59:00.000Z";
const next = "2026-10-25T00:01:00.000Z";
const now = Date.parse("2026-10-26T00:00:00.000Z");
const jsonl = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const assistant = (
  id: string,
  input: number,
  timestamp = at,
  extra: object = {},
  content: unknown[] = [],
) => ({
  type: "assistant",
  sessionId: lead,
  timestamp,
  ...extra,
  message: {
    id,
    role: "assistant",
    model: "claude-opus-5-5",
    usage: { input_tokens: input, cache_read_input_tokens: 200_000, cache_creation_input_tokens: 0 },
    content,
  },
});
const usage = (id: string, input: number, timestamp = at) => [
  {
    type: "token_usage_record",
    timestamp,
    payload: { thread_id: codex, response_id: id, usage: { input_tokens: input } },
  },
  {
    type: "event_msg",
    timestamp,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: id === "response-1" ? 300_000 : 700_000 },
        last_token_usage: { input_tokens: input, cached_input_tokens: input - 100, output_tokens: 10 },
      },
    },
  },
];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-token-ledger-"));
  roots.push(root);
  const claudeHome = join(root, "claude");
  const codexHome = join(root, "codex");
  const stateDir = join(root, "state");
  const directory = join(claudeHome, "projects", "fixture");
  const codexDirectory = join(codexHome, "sessions", "2026", "10", "25");
  await Promise.all([
    mkdir(directory, { recursive: true }),
    mkdir(codexDirectory, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
  ]);
  const main = join(directory, `${lead}.jsonl`);
  await writeFile(
    main,
    jsonl([
      assistant("call-1", 50_005, at, {}, [
        { type: "tool_use", id: "sleep-1", name: "Bash", input: { command: "sleep 1" } },
      ]),
      assistant("call-1", 50_005, at, {}, [
        { type: "tool_use", id: "sleep-1", name: "Bash", input: { command: "sleep 1" } },
      ]),
      assistant("call-2", 0, next),
      assistant("call-2", 20_000, next),
      assistant("child-call", -150_000, next, { isSidechain: true, agentId: "child" }),
      assistant("foreign-call", 999_999, next, { sessionId: codex }),
      assistant("invalid", -1, next),
      { type: "system", subtype: "compact_boundary", sessionId: lead, timestamp: next, uuid: "compact-1" },
      assistant("call-2", 20_000, next, {}, [
        {
          type: "tool_use",
          id: "background",
          name: "Bash",
          input: { command: "sleep 1", run_in_background: true },
        },
        { type: "tool_use", id: "quoted", name: "Bash", input: { command: "echo 'sleep 1'" } },
        { type: "tool_use", id: "loop", name: "Bash", input: { command: "while true; do sleep 1; done" } },
        { type: "tool_use", id: "quoted-clause", name: "Bash", input: { command: 'echo "; sleep 9"' } },
        { type: "tool_use", id: "heredoc", name: "Bash", input: { command: "cat <<'EOF'\nsleep 9\nEOF" } },
        { type: "tool_use", id: "shell-background", name: "Bash", input: { command: "sleep 9 &" } },
      ]),
    ]) + "{incomplete\n",
  );
  await copyFile(main, join(directory, "retained-copy.jsonl"));
  const children = join(directory, lead, "subagents");
  await mkdir(children, { recursive: true });
  await writeFile(
    join(children, "agent-child.jsonl"),
    jsonl([
      {
        type: "assistant",
        sessionId: lead,
        timestamp: next,
        isSidechain: true,
        agentId: "child",
        message: { id: "child-call", role: "assistant", usage: { input_tokens: 50_000 }, content: [] },
      },
    ]),
  );
  await writeFile(
    join(codexDirectory, `rollout-${codex}.jsonl`),
    jsonl([
      { type: "session_meta", timestamp: at, payload: { id: codex, source: "cli" } },
      ...usage("response-1", 300_000),
      ...usage("response-1", 300_000),
      ...usage("response-2", 400_000, next),
      {
        type: "event_msg",
        timestamp: next,
        payload: {
          type: "token_count",
          thread_id: lead,
          info: { last_token_usage: { input_tokens: 900_000 } },
        },
      },
      { type: "compacted", timestamp: next, payload: {} },
      {
        type: "response_item",
        timestamp: next,
        payload: {
          type: "custom_tool_call",
          call_id: "exec-sleep",
          name: "exec",
          input: 'await tools.exec_command({"cmd":"sleep 2"});',
        },
      },
    ]),
  );
  const old = "01a1789c-1918-7412-949e-86a42e0aec99";
  const oldSnapshot = {
    type: "event_msg",
    timestamp: next,
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 100_000, output_tokens: 10 },
        last_token_usage: { input_tokens: 100_000 },
      },
    },
  };
  await writeFile(
    join(codexDirectory, `rollout-${old}.jsonl`),
    jsonl([
      { type: "session_meta", timestamp: at, payload: { id: old, source: "cli" } },
      oldSnapshot,
      oldSnapshot,
      {
        type: "response_item",
        timestamp: next,
        payload: {
          type: "custom_tool_call",
          call_id: "quoted-code",
          name: "exec",
          input: `const label = "tools.exec_command({cmd: 'sleep 9'})"; text(label);`,
        },
      },
      {
        type: "response_item",
        timestamp: next,
        payload: {
          type: "custom_tool_call",
          call_id: "comment-code",
          name: "exec",
          input: "// tools.exec_command({cmd:'sleep 9'})",
        },
      },
      {
        type: "response_item",
        timestamp: next,
        payload: {
          type: "custom_tool_call",
          call_id: "background-code",
          name: "exec",
          input: 'await tools.exec_command({"cmd":"sleep 9","run_in_background":true});',
        },
      },
    ]),
  );
  await writeFile(
    join(stateDir, "lead-seat-relaunches.json"),
    JSON.stringify({
      schemaVersion: 1,
      receipts: [{ previousSessionId: lead, from: { harness: "claude" }, to: { harness: "claude" } }],
    }),
  );
  await writeFile(
    join(stateDir, "herdr-watches.json.owners.json"),
    JSON.stringify({
      schemaVersion: 1,
      hires: [{ sessionKey: JSON.stringify(["local", "codex", codex]), seatId: "native-worker" }],
    }),
  );
  const options = {
    profiles: [
      { harness: "claude" as const, home: claudeHome },
      { harness: "codex" as const, home: codexHome },
    ],
    stateDir,
    now: () => now,
    census: async () => ({ seats: [] }),
  };
  return { root, main, options };
}

it("folds native Claude/Codex identities into per-seat UTC days, with cached input, children and foreground waits", async () => {
  const f = await fixture();
  const report = await readFleetTokenLedger({ days: 7 }, f.options);
  expect(report.totals).toMatchObject({
    modelCalls: 6,
    contextTokens: 1_320_005,
    medianContextTokens: 235_002.5,
    compactions: 2,
    foregroundSleepCalls: 3,
    aboveBudgetContextTokens: 650_005,
    above400KContextTokens: 0,
  });
  const parent = report.seats.find((seat) => seat.sessionId === lead && seat.subagentId === undefined)!;
  expect(parent).toMatchObject({
    role: "lead",
    roleSource: "lead-relaunch-journal",
    budgetTokens: 250_000,
    totals: { modelCalls: 2, contextTokens: 470_005 },
  });
  expect(parent.days.map((day) => [day.day, day.contextTokens, day.aboveBudgetContextTokens])).toEqual([
    ["2026-10-24", 250_005, 250_005],
    ["2026-10-25", 220_000, 0],
  ]);
  expect(report.seats.find((seat) => seat.subagentId === "child")).toMatchObject({
    role: "subagent",
    totals: { modelCalls: 1, contextTokens: 50_000 },
  });
  expect(report.seats.find((seat) => seat.sessionId === codex)).toMatchObject({
    role: "worker",
    seatId: "native-worker",
    totals: { modelCalls: 2, contextTokens: 700_000, aboveBudgetTokenShare: 400_000 / 700_000 },
  });
  expect(report.warnings.join(" ")).toContain("malformed or incomplete");
  const day = await readFleetTokenLedger({ since: next, until: "2026-10-26T00:00:00.000Z" }, f.options);
  expect(day.totals.contextTokens).toBe(770_000);
});

it("serves the native ledger beside account meters through the authenticated HTTP API and CLI, with cached refresh and bounded queries", async () => {
  const f = await fixture();
  const token = mintOperatorToken();
  const credentials = new FileCredentialStore(join(f.root, "credentials.json"));
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
  const settings = new SettingsStore(join(f.root, "settings.json"));
  const ledger = createFleetTokenLedger(f.options);
  const app = createUsageRoutes(
    async (request) =>
      request.headers.get("authorization") === `Bearer ${token}` ? true : "authentication_required",
    settings,
    async () => ({
      machine: "local",
      shell: "posix" as const,
      observedAt: new Date(now).toISOString(),
      accounts: [],
    }),
    () => now,
    ledger,
  );
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No native ledger fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  const options = {
    host,
    env: {
      HOME: f.root,
      CLANKIE_OPERATOR_TOKEN: token,
      CLANKIE_CREDENTIALS_FILE: join(f.root, "credentials.json"),
    },
    operatorCredentialStore: credentials,
  };
  expect((await fetch(`${host}/v1/usage?fleet=1`)).status).toBe(401);
  const ordinary = await runUsageCommand(["--json"], options);
  expect(ordinary).not.toHaveProperty("fleet");
  const report = await runUsageCommand(["--fleet", "--days", "7", "--json"], options);
  if (!("accounts" in report) || !report.fleet) throw new Error("No fleet ledger");
  expect(report.fleet.totals.contextTokens).toBe(1_320_005);
  expect(formatUsageTable(report)).toContain("FOREGROUND SLEEPS");
  await appendFile(f.main, jsonl([assistant("new-call", 200_001, next)]));
  expect((await ledger({ days: 7 })).totals.modelCalls).toBe(6);
  const refreshed = await ledger({ days: 7 }, true);
  expect(refreshed.totals.modelCalls).toBe(7);
  expect(refreshed.totals.above400KContextTokens).toBe(400_001);
  await expect(runUsageCommand(["--fleet", "--days", "367"], options)).rejects.toThrow();
  await expect(runUsageCommand(["--fleet", "--days", "7", "--since", at], options)).rejects.toThrow();
  for (const route of ["/v1/usage?fleet=1&days=7", `/v1/usage?fleet=1&since=${at}&until=${next}`]) {
    expect(hostedOperatorAllows("GET", route)).toBe(true);
    expect(publicGatewayTargetFor("GET", route)).toBe("relay");
    expect(hostedOperatorAllows("POST", route)).toBe(false);
  }
  for (const query of [
    "fleet=2",
    "fleet=1&days=7&days=1",
    "fleet=1&days=NaN",
    "fleet=1&days=0",
    "fleet=1&days=7&since=" + at,
    "fleet=1&extra=true",
    "days=7",
    "refresh=1&refresh=1",
  ]) {
    const route = `/v1/usage?${query}`;
    expect(hostedOperatorAllows("GET", route)).toBe(false);
    expect(publicGatewayTargetFor("GET", route)).toBeUndefined();
    expect((await fetch(host + route, { headers: { authorization: `Bearer ${token}` } })).status).toBe(400);
  }
  const invalid = await fetch(
    `${host}/v1/usage?fleet=1&since=2026-10-26T00:00:00Z&until=2026-10-25T00:00:00Z`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  expect(invalid.status).toBe(400);
});
