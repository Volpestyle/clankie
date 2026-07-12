import { mkdtemp } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskSpec } from "@clankie/protocol";
import type { WorkerRunContext } from "@clankie/worker-sdk";
import { CodexWorkerAdapter, type CodexWorkerOptions } from "@clankie/worker-codex";
import { ClaudeWorkerAdapter, type ClaudeWorkerOptions } from "@clankie/worker-claude";
import { PiWorkerAdapter, type PiWorkerOptions } from "@clankie/worker-pi";
import { afterEach, describe, expect, it } from "vitest";
import { buildWorkerAdapters, simWorkersEnabled } from "../src/worker-descriptors.ts";
import { buildWorkerEnvironment } from "../src/worker-environment.ts";

describe("buildWorkerAdapters", () => {
  it("registers codex, claude, and pi descriptors role-appropriate to the frozen scenario", () => {
    const adapters = buildWorkerAdapters({}, { PATH: "/toolchain/bin" });
    const byId = new Map(adapters.map((adapter) => [adapter.descriptor.id, adapter.descriptor]));
    expect([...byId.keys()]).toEqual([
      "codex-implementer",
      "codex-verifier",
      "claude-verifier",
      "pi-debugger",
    ]);

    expect(byId.get("codex-implementer")).toMatchObject({
      harness: "codex",
      capabilities: { kinds: ["implementation", "debugging", "integration"], canWrite: true },
    });
    expect(byId.get("codex-verifier")).toMatchObject({
      harness: "codex",
      capabilities: { kinds: ["verification", "review"], canWrite: false },
    });
    expect(byId.get("claude-verifier")).toMatchObject({
      harness: "claude",
      capabilities: { kinds: ["verification", "review"], canWrite: false },
    });
    expect(byId.get("pi-debugger")).toMatchObject({
      harness: "pi",
      capabilities: { kinds: ["debugging"], canWrite: true },
    });
  });

  it("registers only simulated descriptors covering every frozen-scenario role in sim mode", () => {
    expect(simWorkersEnabled({ CLANKIE_SIM_WORKERS: "1" })).toBe(true);
    expect(simWorkersEnabled({ CLANKIE_SIM_WORKERS: "true" })).toBe(true);
    expect(simWorkersEnabled({ CLANKIE_SIM_WORKERS: "0" })).toBe(false);
    expect(simWorkersEnabled({})).toBe(false);

    const adapters = buildWorkerAdapters({ CLANKIE_SIM_WORKERS: "1" }, {});
    expect(adapters.map((adapter) => adapter.descriptor.id)).toEqual([
      "sim-planner",
      "sim-implementer",
      "sim-verifier",
      "sim-debugger",
    ]);
    for (const adapter of adapters) {
      expect(adapter.descriptor.harness).toBe("simulated");
    }
    const kinds = new Set(adapters.flatMap((adapter) => adapter.descriptor.capabilities.kinds));
    for (const kind of ["context", "implementation", "verification", "debugging", "review"] as const) {
      expect(kinds.has(kind)).toBe(true);
    }
  });

  it("executes plan-scripted sim writes and binds a synthetic native session", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "clankie-sim-worker-"));
    const adapters = buildWorkerAdapters({ CLANKIE_SIM_WORKERS: "1" }, {});
    const implementer = adapters.find((adapter) => adapter.descriptor.id === "sim-implementer");
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const result = await implementer?.run(
      context(workspacePath, "implementation", "implementer", {
        sim: { files: { "src/retry.mjs": "export const DEFECT = true;\n" } },
      }, emitted),
    );

    expect(result).toMatchObject({ status: "succeeded" });
    expect(result?.outputs.nativeSessionId).toBe("sim:run-sim-test");
    await expect(readFile(join(workspacePath, "src", "retry.mjs"), "utf8")).resolves.toContain("DEFECT");
    expect(emitted.map((event) => event.type)).toContain("worker.native_session.bound");
    const bound = emitted.find((event) => event.type === "worker.native_session.bound");
    expect(bound?.data).toMatchObject({ provider: "sim", nativeSessionId: "sim:run-sim-test" });
  });

  it("refuses scripted writes from a read-only sim role and rejects candidate escapes", async () => {
    const workspacePath = await mkdtemp(join(tmpdir(), "clankie-sim-worker-"));
    const adapters = buildWorkerAdapters({ CLANKIE_SIM_WORKERS: "1" }, {});
    const verifier = adapters.find((adapter) => adapter.descriptor.id === "sim-verifier");
    const readOnlyResult = await verifier?.run(
      context(workspacePath, "verification", "verifier", { sim: { files: { "src/x.ts": "x" } } }, []),
    );
    expect(readOnlyResult).toMatchObject({ status: "failed" });

    const implementer = adapters.find((adapter) => adapter.descriptor.id === "sim-implementer");
    await expect(
      implementer?.run(
        context(workspacePath, "implementation", "implementer", {
          sim: { files: { "../escape.txt": "outside" } },
        }, []),
      ),
    ).rejects.toThrow(/outside the candidate/u);
  });
});

function context(
  workspacePath: string,
  kind: TaskSpec["kind"],
  role: TaskSpec["role"],
  metadata: Record<string, unknown>,
  emitted: Array<{ type: string; data: Record<string, unknown> }>,
): WorkerRunContext {
  return {
    missionId: "mission-sim",
    workerRunId: "run-sim-test",
    workspacePath,
    profileHash: "profile-sim",
    attempt: 1,
    signal: new AbortController().signal,
    emit: (event) => emitted.push({ type: event.type, data: event.data }),
    task: {
      id: `${kind}-task`,
      title: kind,
      objective: `${kind} objective`,
      kind,
      role,
      dependsOn: [],
      executionClass: "runner_visible",
      risk: "low",
      writeScope: kind === "implementation" ? ["src/**"] : [],
      successCriteria: ["done"],
      evidenceRequirements: ["evidence"],
      maxAttempts: 1,
      metadata,
    },
  };
}

describe("buildWorkerAdapters environment wiring", () => {
  const poisonKey = "CLANKIE_VUH819B_POISON";
  const secretKey = "CLANKIE_RUNNER_SECRET";

  afterEach(() => {
    delete process.env[poisonKey];
    delete process.env[secretKey];
  });

  it("passes the allowlisted worker environment to the Claude descriptor, identical to codex/pi, with no runner secret leaking", () => {
    // Poison the real runner process.env, then derive the worker env the runner
    // actually hands its adapters — exactly as apps/runner/src/index.ts does.
    process.env[poisonKey] = "leak-me-if-you-can";
    process.env[secretKey] = "runner-only-top-secret";
    const workerEnvironment = buildWorkerEnvironment(process.env);

    // Capture the `environment` option each real descriptor is constructed with,
    // via the DI seam, without touching adapter packages or private state.
    const captured = new Map<string, NodeJS.ProcessEnv | undefined>();
    class RecordingCodex extends CodexWorkerAdapter {
      constructor(options: CodexWorkerOptions) {
        captured.set(options.id ?? "codex", options.environment);
        super(options);
      }
    }
    class RecordingClaude extends ClaudeWorkerAdapter {
      constructor(options: ClaudeWorkerOptions) {
        captured.set(options.id ?? "claude", options.environment);
        super(options);
      }
    }
    class RecordingPi extends PiWorkerAdapter {
      constructor(options: PiWorkerOptions) {
        captured.set(options.id ?? "pi", options.environment);
        super(options);
      }
    }

    const adapters = buildWorkerAdapters({}, workerEnvironment, {
      Codex: RecordingCodex,
      Claude: RecordingClaude,
      Pi: RecordingPi,
    });
    expect(adapters.map((adapter) => adapter.descriptor.id)).toEqual([
      "codex-implementer",
      "codex-verifier",
      "claude-verifier",
      "pi-debugger",
    ]);

    const claudeEnv = captured.get("claude-verifier");
    const codexEnv = captured.get("codex-verifier");

    // Criterion: the Claude descriptor receives exactly the allowlisted env.
    expect(claudeEnv).toEqual(workerEnvironment);
    // ...and it is identical to what the codex descriptor receives (and codex-implementer/pi).
    expect(claudeEnv).toEqual(codexEnv);
    expect(claudeEnv).toEqual(captured.get("codex-implementer"));
    expect(claudeEnv).toEqual(captured.get("pi-debugger"));
    // The Claude adapter no longer inherits the full runner process env.
    expect(claudeEnv).toBeDefined();

    // Criterion: a poisoned runner env var never reaches the worker env.
    expect(claudeEnv).not.toHaveProperty(poisonKey);
    expect(claudeEnv).not.toHaveProperty(secretKey);
    expect(Object.values(claudeEnv ?? {})).not.toContain("leak-me-if-you-can");
    expect(Object.values(claudeEnv ?? {})).not.toContain("runner-only-top-secret");

    // Baseline inherited vars the allowlist provides (e.g. PATH) are forwarded,
    // matching the codex descriptor exactly rather than being stripped.
    if (process.env.PATH !== undefined) {
      expect(claudeEnv?.PATH).toBe(process.env.PATH);
    }
  });
});
