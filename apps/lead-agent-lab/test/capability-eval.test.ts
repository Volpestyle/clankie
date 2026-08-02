import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CapabilityManifestSchema,
  loadCapabilityManifest,
  runCapabilityEvaluation,
  writeCapabilityEvaluationArtifacts,
  type CapabilityCommandResult,
  type CapabilityManifest,
} from "../src/capability-eval.ts";
import { evaluateDiscordTuiLiveReceipt } from "../src/discord-tui-live-proof.ts";
import { repoRoot } from "../src/lab.ts";

describe("unified capability evaluation", () => {
  it("loads exactly nine versioned capabilities and rejects shell entrypoints", async () => {
    const loaded = await loadCapabilityManifest(repoRoot);
    expect(loaded.manifest.capabilities).toHaveLength(9);
    expect(loaded.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      CapabilityManifestSchema.parse({
        ...loaded.manifest,
        capabilities: loaded.manifest.capabilities.map((capability, index) =>
          index === 0
            ? {
                ...capability,
                gates: [
                  {
                    id: "unsafe_shell",
                    kind: "command",
                    phase: "live",
                    command: ["sh", "-c", "true"],
                    timeoutMs: 1000,
                    success: { kind: "exit_zero" },
                  },
                ],
              }
            : capability,
        ),
      }),
    ).toThrow();
  });

  it("passes only when every gate passes", async () => {
    const loaded = await loadCapabilityManifest(repoRoot);
    const manifest = replaceScreenBlocker(loaded.manifest);
    const report = await runCapabilityEvaluation(
      { ...loaded, manifest },
      {
        repoRoot,
        env: completeRequiredEnvironment(),
        now: () => new Date("2026-07-25T18:00:00.000Z"),
        runCommand: (command) => Promise.resolve(successFor(command)),
      },
    );
    expect(report.passed).toBe(true);
    expect(report.counts).toEqual({ passed: 9, missing_input: 0, blocked: 0, failed: 0 });
    expect(report.capabilities.every((capability) => capability.status === "passed")).toBe(true);
  });

  it("types missing input, skips dependent live work, and never retains raw output", async () => {
    const sentinel = "SECRET_DETAIL_MUST_NOT_SURVIVE";
    const loaded = await loadCapabilityManifest(repoRoot);
    const invoked: string[][] = [];
    const report = await runCapabilityEvaluation(loaded, {
      repoRoot,
      env: {},
      runCommand: async (command) => {
        invoked.push([...command]);
        if (has(command, "readiness-cli.ts") && !has(command, "voice-readiness-cli.ts")) {
          return result(
            1,
            JSON.stringify({
              ready: false,
              checks: [{ name: "official bot credential", ok: false, detail: sentinel }],
            }),
          );
        }
        return successFor(command);
      },
    });
    const discord = report.capabilities.find((entry) => entry.id === "discord_text");
    expect(discord).toMatchObject({
      status: "missing_input",
      gates: [
        { status: "missing_input", issueCodes: ["official_bot_credential"] },
        { status: "skipped", issueCodes: ["readiness_not_passed"] },
      ],
    });
    expect(report.capabilities.find((entry) => entry.id === "firered")?.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "state_derived_free_play_competence", status: "passed" }),
        expect.objectContaining({
          id: "real_gameplay",
          status: "missing_input",
          issueCodes: ["firered_live_receipt_path"],
        }),
        expect.objectContaining({
          id: "rom_gated_free_play_competence",
          status: "missing_input",
          issueCodes: ["firered_free_play_competence_receipt_path"],
        }),
      ]),
    );
    expect(invoked.some((command) => has(command, "evaluate-live-receipt.ts"))).toBe(false);
    expect(JSON.stringify(report)).not.toContain(sentinel);
  });

  it("publishes only redacted reports and command-output hashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-capability-eval-"));
    const loaded = await loadCapabilityManifest(repoRoot);
    const report = await runCapabilityEvaluation(loaded, {
      repoRoot,
      env: {},
      runCommand: (command) => Promise.resolve(successFor(command)),
    });
    const paths = await writeCapabilityEvaluationArtifacts(report, join(root, "report"));
    const bytes = await readFile(paths.jsonPath, "utf8");
    expect(bytes).toContain('"stdoutSha256"');
    expect(bytes).not.toContain('"stdout":');
    expect(await readFile(paths.markdownPath, "utf8")).toContain("Raw command output is not retained");
  });
});

describe("Discord-to-TUI live receipt", () => {
  it("requires the same mission and worker identities across all three projections", () => {
    expect(
      evaluateDiscordTuiLiveReceipt({
        schemaVersion: 1,
        discord: {
          guildId: "guild",
          interactionId: "interaction",
          missionId: "mission",
          threadId: "thread",
        },
        worker: {
          missionId: "mission",
          taskId: "task",
          workerRunId: "worker-run",
          nativeSessionId: "native-session",
        },
        tui: { missionId: "mission", workerRunId: "worker-run", eventCursor: 42 },
      }),
    ).toMatchObject({ passed: true });
    expect(
      evaluateDiscordTuiLiveReceipt({
        schemaVersion: 1,
        discord: {
          guildId: "guild",
          interactionId: "interaction",
          missionId: "mission-a",
          threadId: "thread",
        },
        worker: {
          missionId: "mission-b",
          taskId: "task",
          workerRunId: "worker-run",
          nativeSessionId: "native-session",
        },
        tui: { missionId: "mission-b", workerRunId: "other-run", eventCursor: 0 },
      }),
    ).toMatchObject({ passed: false });
  });

  it("rejects raw Discord or terminal content in the evidence envelope", () => {
    expect(() =>
      evaluateDiscordTuiLiveReceipt({
        schemaVersion: 1,
        discord: {
          guildId: "guild",
          interactionId: "interaction",
          missionId: "mission",
          threadId: "thread",
          transcript: "must not be retained",
        },
        worker: {
          missionId: "mission",
          taskId: "task",
          workerRunId: "worker-run",
          nativeSessionId: "native-session",
        },
        tui: { missionId: "mission", workerRunId: "worker-run", eventCursor: 42 },
      }),
    ).toThrow();
  });
});

function replaceScreenBlocker(manifest: CapabilityManifest): CapabilityManifest {
  return CapabilityManifestSchema.parse({
    ...manifest,
    capabilities: manifest.capabilities.map((capability) =>
      capability.id === "discord_screen"
        ? {
            ...capability,
            gates: [
              {
                id: "official_transport",
                kind: "command",
                phase: "live",
                command: ["node", "screen-proof.mjs"],
                timeoutMs: 1000,
                success: { kind: "exit_zero" },
              },
            ],
          }
        : capability,
    ),
  });
}

function completeRequiredEnvironment(): NodeJS.ProcessEnv {
  return {
    CLANKIE_GBA_LIVE_RECEIPT_PATH: "/operator/firered-live-receipt.json",
    CLANKIE_GBA_COMPETENCE_RECEIPT_PATH: "/operator/firered-free-play-competence-receipt.json",
    CLANKIE_DISCORD_TUI_LIVE_RECEIPT_PATH: "/operator/discord-tui.json",
  };
}

function successFor(command: readonly string[]): CapabilityCommandResult {
  if (has(command, "real-provider-readiness.mjs")) {
    return result(
      0,
      [
        JSON.stringify({ provider: "codex", ready: true, issues: [] }),
        JSON.stringify({ provider: "claude", ready: true, issues: [] }),
        JSON.stringify({ provider: "pi", ready: true, issues: [] }),
      ].join("\n"),
    );
  }
  if (has(command, "integrations/minecraft-mineflayer/scripts/readiness.ts")) {
    return result(0, JSON.stringify({ status: "ready", missingInputs: [] }));
  }
  if (has(command, "apps/tui/bin/clankie.ts")) return result(0, JSON.stringify({ ok: true }));
  if (has(command, "evaluate-live-receipt.ts")) {
    return result(0, JSON.stringify({ passed: true, checks: [] }));
  }
  if (
    has(command, "run-free-play-competence.ts") ||
    has(command, "evaluate-free-play-competence-receipt.ts")
  ) {
    return result(0, JSON.stringify({ passed: true, checks: [] }));
  }
  if (has(command, "eval:real-workers:receipt")) {
    return result(0, JSON.stringify({ passed: true, checks: [] }));
  }
  if (has(command, "readiness-cli.ts") || has(command, "voice-readiness-cli.ts")) {
    return result(0, JSON.stringify({ ready: true, checks: [] }));
  }
  if (
    has(command, "live-proof-cli.ts") ||
    has(command, "person-memory-live-proof-cli.ts") ||
    has(command, "voice-live-proof-cli.ts") ||
    has(command, "discord-tui-live-proof-cli.ts")
  ) {
    return result(0, JSON.stringify({ passed: true, checks: [] }));
  }
  return result(0, "");
}

function has(command: readonly string[], suffix: string): boolean {
  return command.some((part) => part.endsWith(suffix));
}

function result(exitCode: number, stdout: string): CapabilityCommandResult {
  return {
    exitCode,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
    durationMs: 5,
    timedOut: false,
    outputExceeded: false,
  };
}
