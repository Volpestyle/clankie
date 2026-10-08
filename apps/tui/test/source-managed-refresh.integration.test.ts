import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { readRuntimeUpdate, writeRuntimeUpdate } from "../bin/runtime-update.ts";
import { formatUpdateOutput } from "../src/command/update-output.ts";
import { inspectHarnessProfiles } from "../../../integrations/claude-plugin/worker/bin/harness-status.mjs";

it("reads the a7913139 refusal shapes from retained files without changing history or claiming refresh", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "source-managed-refresh-")));
  try {
    const receipt = {
      ok: false,
      local: [
        {
          harness: "codex",
          profile: "/profiles/codex",
          status: "declined",
          detail:
            "codex configuration is managed at /source/config.toml. Use its source setup to install clankie-worker@clankie-fleet; no config file will be modified here.",
        },
        {
          harness: "codex",
          profile: "/profiles/disabled",
          status: "declined",
          detail: "The Codex worker plugin is disabled.",
        },
      ],
      fleets: [
        {
          fleet: "pc",
          ok: false,
          result: {
            installations: [
              {
                harness: "codex",
                profile: "C:\\Users\\fixture\\.codex-james",
                status: "source-manager-required",
              },
            ],
          },
        },
        { fleet: "kh2", ok: false, error: "Automatic harness refresh needs an already-linked machine." },
      ],
    };
    await writeFile(join(root, "harness-refresh.json"), JSON.stringify(receipt), { mode: 0o600 });
    writeRuntimeUpdate(root, {
      id: "a7913139-6285-41da-a6c8-cdc8d70999d2",
      ref: "main",
      oldCommit: "a".repeat(40),
      newCommit: "b".repeat(40),
      phase: "healthy",
      healthy: true,
      updatedAt: "2026-10-07T00:00:00Z",
      reason: "harness-refresh-incomplete",
      harnessRefresh: { ok: false, result: { ok: false, receipt: "/untrusted/path" } },
    });
    const original = await readFile(join(root, "result.json"), "utf8");
    const result = readRuntimeUpdate(root);
    expect(result.reason).toBe("harness-refresh-source-managed");
    expect(result.harnessRefresh?.ok).toBe(false);
    expect(result.harnessRefresh?.sourceManaged).toMatchObject([
      { home: "/profiles/codex", machine: "local" },
      { home: "C:\\Users\\fixture\\.codex-james", machine: "pc" },
    ]);
    expect(formatUpdateOutput({ latest: result })).toContain(
      "source-managed: needs setup in /profiles/codex",
    );
    expect(formatUpdateOutput({ latest: result })).toContain("--codex-source-setup");
    expect(await readFile(join(root, "result.json"), "utf8")).toBe(original);
    expect(await readFile(join(root, "harness-refresh.json"), "utf8")).toBe(JSON.stringify(receipt));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("doctor identifies a real source-managed home without a source setup record", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "source-managed-doctor-")));
  const profile = join(root, ".codex"),
    source = join(root, "owner-config.toml");
  try {
    await mkdir(profile);
    await writeFile(source, "# generated; do not edit\n");
    await symlink(source, join(profile, "config.toml"));
    const inspect = () =>
      inspectHarnessProfiles({
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          CODEX_HOME: profile,
          CLAUDE_CONFIG_DIR: join(root, ".claude"),
        },
      });
    expect((await inspect()).codex.sourceSetup).toMatchObject({
      state: "source-manager-required",
      detail: `source-managed: needs setup in ${profile}`,
      fix: expect.stringContaining(source),
    });
    await mkdir(join(profile, "plugins"));
    await writeFile(
      join(profile, "plugins", "clankie-source-setup.json"),
      JSON.stringify({ source, command: "/owner/setup", args: [] }),
    );
    expect((await inspect()).codex.sourceSetup?.state).toBe("source-setup-recorded");
    await writeFile(
      join(profile, "plugins", "clankie-source-setup.json"),
      JSON.stringify({ source: "/other/source", command: "/owner/setup", args: [] }),
    );
    expect((await inspect()).codex.sourceSetup?.state).toBe("source-manager-required");
    expect(await realpath(join(profile, "config.toml"))).toBe(source);
    expect(await readFile(source, "utf8")).toBe("# generated; do not edit\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
