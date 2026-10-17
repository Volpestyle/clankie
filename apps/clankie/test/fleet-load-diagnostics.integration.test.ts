import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { startLinearFixture } from "../scripts/fleet-load-fixtures.ts";

it("retains a real load-service proof refusal over IPC, independently of its rolling logs", async () => {
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
