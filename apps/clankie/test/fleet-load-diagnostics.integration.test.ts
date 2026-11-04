import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { startLinearFixture } from "../scripts/fleet-load-fixtures.ts";

it("retains proof diagnostics and distinguishes unavailable observations from refused membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-load-diagnostics-"));
  const provider = await startLinearFixture();
  const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const config = join(root, "service.json");
  await writeFile(
    config,
    JSON.stringify({
      sourceRoot,
      root,
      workspace,
      socket: join(root, "absent.sock"),
      herdr: "herdr",
      provider: provider.url,
      bearer: "fixture-only",
    }),
  );
  const child = fork(new URL("../scripts/fleet-load.ts", import.meta.url), ["--internal-service", config], {
    execArgv: ["--import", import.meta.resolve("tsx")],
    env: { ...process.env, CLANKIE_STATE_HOME: root, CLANKIE_SETTINGS_FILE: join(root, "settings.json") },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const messages: Array<Record<string, unknown>> = [];
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("message", (message) => messages.push(message as Record<string, unknown>));
  try {
    await expect
      .poll(
        () => {
          if (child.exitCode !== null) throw new Error(`Load service exited: ${stderr}`);
          return messages.find((message) => message.kind === "ready");
        },
        { timeout: 20_000 },
      )
      .toBeDefined();
    const ready = messages.find((message) => message.kind === "ready")!;
    // Events uses fleet proof; peers uses original project proof. Neither
    // boundary may hide its refusal behind the rolling service log.
    for (const route of ["events", "peers"]) {
      const response = await fetch(`http://127.0.0.1:${ready.localPort}/v1/fleet/seats/invalid/${route}`, {
        headers: { "x-clankie-pane": "invalid" },
        signal: AbortSignal.timeout(5_000),
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    await expect
      .poll(() => messages.filter((message) => message.kind === "proof_diagnostic"))
      .toEqual([
        {
          kind: "proof_diagnostic",
          at: expect.any(Number),
          pane: "invalid",
          requestId: expect.any(String),
          connectionId: expect.any(String),
          diagnostic: { source: "proof", reason: "invalid_pane" },
        },
        {
          kind: "proof_diagnostic",
          at: expect.any(Number),
          pane: "invalid",
          requestId: expect.any(String),
          connectionId: expect.any(String),
          diagnostic: { source: "proof", reason: "invalid_pane" },
        },
      ]);
    const diagnostics = messages.filter((message) => message.kind === "proof_diagnostic");
    expect(new Set(diagnostics.map((message) => message.requestId)).size).toBe(2);
    // This syntactically valid pane cannot be observed: the fixture has no
    // Herdr listener. Production must refuse it as retryable unavailability,
    // rather than declaring that the caller permanently lost membership.
    const callsBeforeUnavailable = provider.calls.length;
    const unavailable = await fetch(`http://127.0.0.1:${ready.localPort}/v1/fleet/seats/w1:p1/events`, {
      headers: { "x-clankie-pane": "w1:p1" },
      signal: AbortSignal.timeout(5_000),
    });
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("1");
    expect(await unavailable.json()).toMatchObject({ error: "fleet_admission_unavailable", retryable: true });
    expect(provider.calls).toHaveLength(callsBeforeUnavailable);
    expect(JSON.stringify(messages)).not.toContain("fixture-only");
  } finally {
    if (child.exitCode === null) {
      const closed = once(child, "close");
      child.send("stop");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await closed;
      clearTimeout(timer);
    }
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Own service replacement, real captain/owner journal/link/WorkerMcp. The
// controlled hiring provenance and rate clock are fixtures; no successful kernel
// proof is substituted (the separate native test proves that boundary).
it.skipIf(process.platform !== "darwin")(
  "keeps personal-pane refusals out of alerts across a real service restart while a hire's observation fault still pages",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-refusal-restart-"));
    const provider = await startLinearFixture();
    const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await mkdir(join(root, "captain"));
    const owners = new HireOwners(join(root, "captain/herdr-watches.json.owners.json"));
    owners.adopt("w1:p1", "personal-seat", "personal-occupant", { conversationId: "global-default" });
    owners.bind("w2:p2", { conversationId: "global-default" }, "hired-seat", undefined, "hired-occupant");
    // Before explicit provenance existed, the same journal could hold a personal seat.
    // Unknown must not become a hire merely by replaying that legacy record.
    const ownersPath = join(root, "captain/herdr-watches.json.owners.json");
    const legacy = JSON.parse(await readFile(ownersPath, "utf8"));
    legacy.hires.push({
      id: "legacy-personal",
      paneId: "w3:p3",
      seatId: "legacy-seat",
      occupantId: "legacy-occupant",
      owner: { conversationId: "global-default" },
    });
    await writeFile(ownersPath, JSON.stringify(legacy));
    const config = join(root, "service.json");
    await writeFile(
      config,
      JSON.stringify({
        sourceRoot,
        root,
        workspace,
        socket: join(root, "absent.sock"),
        herdr: "herdr",
        provider: provider.url,
        bearer: "fixture-only",
        proofMetricsClock: Date.parse("2026-11-04T00:00:00Z"),
      }),
    );
    const children = new Set<ReturnType<typeof fork>>();
    const stop = async (child: ReturnType<typeof fork>) => {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.send("stop");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await closed;
        clearTimeout(timer);
      }
      children.delete(child);
    };
    const start = async () => {
      const child = fork(
        new URL("../scripts/fleet-load.ts", import.meta.url),
        ["--internal-service", config],
        {
          execArgv: ["--import", import.meta.resolve("tsx")],
          env: {
            ...process.env,
            NODE_ENV: "test",
            VITEST: "true",
            CLANKIE_STATE_HOME: root,
            CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
          },
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      children.add(child);
      const messages: Record<string, unknown>[] = [];
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("message", (message) => messages.push(message as Record<string, unknown>));
      await expect
        .poll(
          () => {
            if (child.exitCode !== null) throw new Error(`Refusal service exited: ${stderr}`);
            return messages.find((message) => message.kind === "ready");
          },
          { timeout: 20_000 },
        )
        .toBeDefined();
      const ready = messages.find((message) => message.kind === "ready")!;
      const refused = async (pane: string) => {
        const response = await fetch(`http://127.0.0.1:${ready.localPort}/v1/fleet/mcp`, {
          method: "POST",
          headers: {
            "x-clankie-pane": pane,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "restart-fixture", version: "1" },
            },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: "fleet_admission_unavailable",
          retryable: true,
        });
      };
      const sustain = async (pane: string) => {
        for (let request = 0; request < 100; request++) await refused(pane);
        const before = messages.filter((message) => message.kind === "proof_clock").length;
        child.send({ advanceProofMetricsMs: 60_001 });
        await expect
          .poll(() => messages.filter((message) => message.kind === "proof_clock").length)
          .toBe(before + 1);
        await refused(pane);
      };
      return { child, messages, sustain };
    };
    try {
      const first = await start();
      await first.sustain("w1:p1");
      await first.sustain("w3:p3");
      expect(first.messages.filter((message) => message.kind === "proof_alert")).toEqual([]);
      await stop(first.child);
      const restarted = await start();
      expect(restarted.child.pid).not.toBe(first.child.pid);
      await restarted.sustain("w1:p1");
      await restarted.sustain("w3:p3");
      expect(restarted.messages.filter((message) => message.kind === "proof_alert")).toEqual([]);
      await restarted.sustain("w2:p2");
      expect(restarted.messages.filter((message) => message.kind === "proof_alert")).toEqual([
        { kind: "proof_alert", refusals: 101, panes: ["w2:p2"] },
      ]);
    } finally {
      for (const child of children) await stop(child);
      await provider.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
