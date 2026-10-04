import { createHash } from "node:crypto";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { IssueMetricsReportSchema } from "@clankie/protocol";
import { expect, it } from "vitest";
import { createSeatLedger } from "../src/captain/seat-ledger.ts";
import { TurnMetrics, TurnSettledLog } from "../src/captain/turn-metrics.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = new URL("./fixtures/issue-metrics/", import.meta.url);
const query = { issue: "VUH-1608", since: "2026-10-04T00:00:00Z", until: "2026-10-05T00:00:00Z" };

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(timer);
}

it("serves the real VUH-1608 golden through the production service, client and CLI without changing the owner's fleet link", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clankie-issue-metrics-"));
  // Explicitly opt in to this one owner-file read during local evidence capture.
  // CI and other owners exercise the same invariant against their private sentinel.
  const linkPath = process.env.CLANKIE_METRICS_LINK_GUARD ?? join(dir, "owner-links", "default-local.json");
  if (process.env.CLANKIE_METRICS_LINK_GUARD === undefined) {
    await mkdir(join(dir, "owner-links"));
    await writeFile(linkPath, '{"owner":"unchanged"}\n');
  }
  const before = await readFile(linkPath);
  let child: ChildProcess | undefined;
  let output = "";
  try {
    const home = join(dir, "home");
    const state = join(dir, "state");
    const captain = join(state, "captain");
    const conversationId = "conv-19296793-5a5f-4da4-af48-a8be7c2a19ca";
    const conversation = join(captain, "conversations", conversationId);
    await mkdir(conversation, { recursive: true });
    await mkdir(home, { recursive: true });
    const manifest = JSON.parse(await readFile(new URL("vuh-1608.json", fixtures), "utf8"));
    const nativeDir = join(home, "codex", "sessions", "2026", "10", "04");
    await mkdir(nativeDir, { recursive: true });
    const native = join(nativeDir, manifest.source.replace("Codex ", ""));
    const nativeBytes = await readFile(new URL("vuh-1608.jsonl", fixtures));
    expect(createHash("sha256").update(nativeBytes).digest("hex")).toBe(manifest.fixtureSha256);
    await writeFile(
      native,
      process.env.CLANKIE_METRICS_NATIVE_COPY === undefined
        ? nativeBytes
        : await readFile(process.env.CLANKIE_METRICS_NATIVE_COPY),
    );
    // Production metadata shape, reconstructed from the retained exact binding;
    // no live captain reads. The native source itself is the copied real history.
    await writeFile(
      join(conversation, "meta.json"),
      JSON.stringify({
        conversationId,
        scope: { kind: "seat", seatId: manifest.terminalId },
        title: manifest.worker,
        isDefault: false,
        createdAt: manifest.expected.startedAt,
        updatedAt: manifest.expected.acceptedAt,
        revision: 0,
        sessionState: "waiting",
        nativeSource: {
          terminalId: manifest.terminalId,
          paneId: "w3Z:p1P",
          agent: "codex",
          session: { source: "herdr:codex", kind: "id", value: manifest.sessionId },
        },
      }),
    );
    const settings = join(dir, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "disabled" },
        captain: { workingDirectory: dir },
      }),
    );
    const port = await unusedPort();
    const host = `http://127.0.0.1:${port}`;
    // A minimal allowlist keeps all owner's integration/provider/auth env out.
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CI: "1",
      CLANKIE_STATE: state,
      CLANKIE_SETTINGS_FILE: settings,
      CLANKIE_CREDENTIALS_FILE: join(dir, "credentials.json"),
      CLANKIE_OPERATOR_TOKEN: "metrics-journey-private-operator",
      CLANKIE_CAPTAIN_TOKEN: "metrics-journey-private-captain",
      CLANKIE_BROWSER_ENABLED: "false",
      CLANKIE_RELAY_PORT: "0",
      PORT: String(port),
      CLANKIE_CONTROL_PLANE_URL: host,
    };
    const tsx = join(root, "apps/clankie/node_modules/tsx/dist/loader.mjs");
    child = spawn(process.execPath, ["--import", tsx, join(root, "apps/clankie/src/index.ts")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      output += String(chunk);
    });
    const client = new ClankieApiClient({ baseUrl: host, operatorToken: env.CLANKIE_OPERATOR_TOKEN! });
    let report;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${output}`);
      try {
        report = await client.readIssueMetrics(query);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!report) throw new Error(`Service did not answer: ${output}`);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      issueId: manifest.issueId,
      status: "accepted",
      ...manifest.expected,
      leadReportedTokens: null,
      leadUsageReports: 0,
    });
    expect(report.workers[0]).toMatchObject({
      workerId: manifest.terminalId,
      label: "Noor",
      reportedTokens: 23106300,
      fullCheckRuns: 3,
    });
    expect(report.coverage.tokens).toContain("Native subagents");
    const cli = await exec(
      process.execPath,
      [
        "--import",
        tsx,
        join(root, "apps/tui/bin/clankie.ts"),
        "metrics",
        "--issues",
        "--issue",
        query.issue,
        "--since",
        query.since,
        "--until",
        query.until,
      ],
      { cwd: root, env, timeout: 20_000 },
    );
    expect(JSON.parse(cli.stdout)).toEqual({ ok: true, report });
    expect(IssueMetricsReportSchema.parse(JSON.parse(cli.stdout).report)).toEqual(report);
    expect((await client.readIssueMetrics({ ...query, worker: "Noor" })).issues).toEqual(report.issues);
    expect((await client.readIssueMetrics({ ...query, worker: "different-worker" })).issues).toEqual([]);
    expect((await client.readIssueMetrics({ ...query, since: "2026-10-04T19:16:00Z" })).issues).toEqual([]);
    const route = `${host}/v1/captain/issue-metrics`;
    expect((await fetch(route)).status).toBe(401);
    expect(
      (
        await fetch(`${route}?issue=bad`, {
          headers: { Authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}` },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await fetch(`${route}?since=2026-10-05T00:00:00Z&until=2026-10-04T00:00:00Z`, {
          headers: { Authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}` },
        })
      ).status,
    ).toBe(400);
    // Integration boundary: actual settled-log producer rows are attributed
    // only through unambiguous retained inbound references, in the episode.
    // These are lab rows, separate from the real-history golden above.
    const metaPath = join(conversation, "meta.json");
    const metadata = JSON.parse(await readFile(metaPath, "utf8"));
    metadata.inboundAcceptances = {
      unique: { text: "VUH-1608 ready", runId: "lab-unique", paneId: "w3Z:p1P" },
      mixed: { text: "VUH-1608 and VUH-1613", runId: "lab-mixed", paneId: "w3Z:p1P" },
      conflictingA: { text: "VUH-1608", runId: "lab-conflicting", paneId: "w3Z:p1P" },
      conflictingB: { text: "VUH-1613", runId: "lab-conflicting", paneId: "w3Z:p1P" },
      outside: { text: "VUH-1608", runId: "lab-outside", paneId: "w3Z:p1P" },
    };
    await writeFile(metaPath, JSON.stringify(metadata));
    const log = new TurnSettledLog(join(captain, "turn-settled.jsonl"));
    for (const runId of ["lab-unique", "lab-mixed", "lab-conflicting", "lab-outside"]) {
      const at = runId === "lab-outside" ? "2026-10-04T20:00:00.000Z" : "2026-10-04T19:10:00.000Z";
      const metrics = new TurnMetrics({ conversationId, lane: "operator", runId, acceptedAt: at });
      metrics.recordReportedUsage(77);
      const settled = metrics.finish("completed", new Date(at));
      log.append(settled);
      log.append(settled);
    }
    expect((await client.readIssueMetrics(query)).issues[0]).toMatchObject({
      leadReportedTokens: 77,
      leadUsageReports: 1,
    });
    delete metadata.inboundAcceptances;
    await writeFile(metaPath, JSON.stringify(metadata));
    // Replay repeated native delivery/usage rows through the real reader: no
    // cumulative or duplicate reports, calls, or approvals may inflate totals.
    const raw = await readFile(native, "utf8");
    const realCheck = raw
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .find((row) => row?.payload?.call_id === "call_A88pUEanyaF1I2edEzUO4jST");
    const patchMention = {
      ...realCheck,
      payload: { ...realCheck.payload, call_id: "lab-patch-mention", name: "apply_patch" },
    };
    const commandMention = {
      ...realCheck,
      payload: {
        ...realCheck.payload,
        call_id: "lab-command-mention",
        input:
          "text(await tools.exec_command({cmd: " +
          JSON.stringify("printf 'ok; pnpm check'\n# subprocess.run(['pnpm','check'])") +
          "}));",
      },
    };
    const foreignUsage = {
      timestamp: "2026-10-04T18:30:00.000Z",
      type: "token_usage_record",
      payload: {
        thread_id: "foreign-child",
        response_id: "lab-foreign-response",
        usage: { total_tokens: 999999 },
      },
    };
    await writeFile(
      native,
      raw +
        JSON.stringify(foreignUsage) +
        "\n" +
        JSON.stringify(patchMention) +
        "\n" +
        JSON.stringify(commandMention) +
        "\n",
    );
    expect((await client.readIssueMetrics(query)).issues).toEqual(report.issues);
    await writeFile(native, raw + raw);
    expect((await client.readIssueMetrics(query)).issues).toEqual(report.issues);
    // Missing structured usage cannot become zero or borrow legacy cumulative
    // counts. The complete private interval includes those legacy rows too.
    await writeFile(
      native,
      raw
        .split("\n")
        .filter(
          (line) =>
            !line.includes('"type":"token_usage_record"') && !line.includes('"type": "token_usage_record"'),
        )
        .join("\n"),
    );
    expect((await client.readIssueMetrics(query)).issues[0]).toMatchObject({
      reportedTokens: null,
      usageReports: 0,
    });
    // A passing seat edge is not acceptance; the approval prompt is the fence.
    await writeFile(
      native,
      raw
        .split("\n")
        .filter((line) => !line.includes(manifest.expected.acceptedAt))
        .join("\n"),
    );
    const ledger = createSeatLedger(join(captain, "seat-ledger.jsonl"), () =>
      Date.parse("2026-10-04T19:10:00.000Z"),
    );
    ledger.runSettled(manifest.terminalId, "passed");
    const fence = new DeliveryFence(join(captain, "herdr-watches.json.hire-receipts.json"));
    fence.begin("lab-pending", { fingerprint: "lab-pending", sessionId: manifest.sessionId });
    const unfinished = await client.readIssueMetrics(query);
    expect(unfinished.issues[0]).toMatchObject({
      status: "in_progress",
      acceptedAt: null,
      wallTimeMs: null,
      reviewRounds: 1,
      reworkRounds: 1,
    });
    expect(unfinished.issues[0]!.workers[0]!.seatSettlements.passed).toBe(1);
    expect(unfinished.issues[0]!.workers[0]!.unresolvedHireReceipt).toBe(true);
    fence.reconcile("lab-pending", fence.pending("lab-pending")!.messageId);
    // A retained binding with a missing native source stays unavailable.
    await rm(native);
    const unavailable = await client.readIssueMetrics(query);
    expect(unavailable.issues).toEqual([]);
    expect(unavailable.coverage.warnings).toContain(`Native history unavailable: ${manifest.terminalId}`);
    if (process.env.CLANKIE_METRICS_EVIDENCE !== undefined) {
      await writeFile(join(process.env.CLANKIE_METRICS_EVIDENCE, "metrics-cli.json"), cli.stdout);
      await writeFile(join(process.env.CLANKIE_METRICS_EVIDENCE, "loopback-service.log"), output);
    }
  } finally {
    if (child) await stop(child);
    const after = await readFile(linkPath);
    expect(after).toEqual(before);
    if (process.env.CLANKIE_METRICS_EVIDENCE !== undefined)
      await writeFile(
        join(process.env.CLANKIE_METRICS_EVIDENCE, "link-guard.json"),
        JSON.stringify(
          {
            path: linkPath,
            beforeSha256: createHash("sha256").update(before).digest("hex"),
            afterSha256: createHash("sha256").update(after).digest("hex"),
            byteIdentical: before.equals(after),
          },
          null,
          2,
        ) + "\n",
      );
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
