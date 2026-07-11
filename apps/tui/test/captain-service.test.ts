import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureCaptainService } from "../bin/captain-service.ts";
import {
  CAPTAIN_AGENT_NAME,
  CAPTAIN_AUTHORED_TOOL_NAMES,
  CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES,
  EVE_WORKFLOW_ID,
  isCaptainInfo,
} from "../src/session/captain-identity.ts";

function captainInfo(name = CAPTAIN_AGENT_NAME): unknown {
  return {
    kind: "eve-agent-info",
    agent: { name },
    tools: {
      authored: CAPTAIN_AUTHORED_TOOL_NAMES.map((toolName) => ({ name: toolName })),
      available: CAPTAIN_AUTHORED_TOOL_NAMES.map((toolName) => ({ name: toolName })),
      disabledFramework: [...CAPTAIN_DISABLED_FRAMEWORK_TOOL_NAMES],
    },
  };
}

describe("ensureCaptainService", () => {
  it("attaches only when the loopback endpoint identifies a ready Eve service", async () => {
    const handle = await ensureCaptainService({
      repoRoot: "/unused",
      host: "http://127.0.0.1:4321",
      fetchImpl: async (input) =>
        String(input).endsWith("/eve/v1/info")
          ? Response.json(captainInfo())
          : Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
    });

    expect(handle).toMatchObject({ host: "http://127.0.0.1:4321", owned: false });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it("rejects an unrelated Eve agent even though its generic workflow health matches", () => {
    expect(isCaptainInfo(captainInfo("some-other-eve-agent"))).toBe(false);
  });

  it("rejects a stale captain that still exposes a broad framework tool", () => {
    const stale = captainInfo() as {
      tools: { available: Array<{ name: string }>; disabledFramework: string[] };
    };
    stale.tools.available.push({ name: "bash" });
    stale.tools.disabledFramework = stale.tools.disabledFramework.filter((name) => name !== "bash");
    expect(isCaptainInfo(stale)).toBe(false);
  });

  it("does not mistake an unrelated HTTP 200 response for the captain", async () => {
    await expect(
      ensureCaptainService({
        repoRoot: "/unused",
        host: "https://example.test:4321",
        fetchImpl: async () => Response.json({ ok: true, status: "ready", workflowId: EVE_WORKFLOW_ID }),
      }),
    ).rejects.toThrow("must use a loopback http URL");
  });

  it("turns an asynchronous spawn failure into an actionable startup error", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "captain-service-test-"));
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      pid: undefined,
      kill: () => true,
    }) as unknown as ChildProcess;
    const spawnImpl = (() => {
      queueMicrotask(() => child.emit("error", new Error("spawn pnpm ENOENT")));
      return child;
    }) as unknown as typeof spawn;

    try {
      await expect(
        ensureCaptainService({
          repoRoot: "/unused",
          host: "http://127.0.0.1:4321",
          env: { XDG_STATE_HOME: stateRoot },
          fetchImpl: async () => new Response(null, { status: 503 }),
          spawnImpl,
          timeoutMs: 500,
        }),
      ).rejects.toThrow("could not start: spawn pnpm ENOENT");
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
