import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { preTrustClaude, preTrustCodex, preTrustHarnesses } from "../src/harness-trust.ts";

let home: string;
let claudeConfig: string;
let codexConfig: string;
const candidate = "/tmp/clankie-herdr-harness-fixture-xyz";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "harness-trust-test-"));
  claudeConfig = join(home, ".claude.json");
  codexConfig = join(home, ".codex/config.toml");
  await mkdir(dirname(codexConfig), { recursive: true });
});

describe("preTrustClaude", () => {
  it("creates the config and a trusted project entry when no config exists", async () => {
    const { receipt } = await preTrustClaude(candidate, claudeConfig);
    expect(receipt.action).toBe("seeded");
    const config = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(config.projects[candidate].hasTrustDialogAccepted).toBe(true);
    expect(config.projects[candidate].hasCompletedProjectOnboarding).toBe(true);
  });

  it("preserves unrelated config content and other projects", async () => {
    await writeFile(
      claudeConfig,
      JSON.stringify({
        theme: "dark",
        projects: { "/existing": { hasTrustDialogAccepted: true, lastCost: 4.2 } },
      }),
      "utf8",
    );
    await preTrustClaude(candidate, claudeConfig);
    const config = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(config.theme).toBe("dark");
    expect(config.projects["/existing"]).toEqual({ hasTrustDialogAccepted: true, lastCost: 4.2 });
    expect(config.projects[candidate].hasTrustDialogAccepted).toBe(true);
  });

  it("reports already-trusted without rewriting when the entry is trusted", async () => {
    await writeFile(
      claudeConfig,
      JSON.stringify({ projects: { [candidate]: { hasTrustDialogAccepted: true } } }),
      "utf8",
    );
    const before = await readFile(claudeConfig, "utf8");
    const { receipt, undo } = await preTrustClaude(candidate, claudeConfig);
    expect(receipt.action).toBe("already-trusted");
    expect(await readFile(claudeConfig, "utf8")).toBe(before);
    await undo();
    expect(await readFile(claudeConfig, "utf8")).toBe(before);
  });

  it("undo removes an entry it created but keeps concurrent additions elsewhere", async () => {
    await writeFile(claudeConfig, JSON.stringify({ projects: {} }), "utf8");
    const { undo } = await preTrustClaude(candidate, claudeConfig);
    // Simulate a live session adding an unrelated project before cleanup runs.
    const mid = JSON.parse(await readFile(claudeConfig, "utf8"));
    mid.projects["/concurrent"] = { hasTrustDialogAccepted: true };
    await writeFile(claudeConfig, JSON.stringify(mid), "utf8");
    await undo();
    const config = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(config.projects[candidate]).toBeUndefined();
    expect(config.projects["/concurrent"]).toEqual({ hasTrustDialogAccepted: true });
  });

  it("undo restores prior flag values on a pre-existing untrusted entry", async () => {
    await writeFile(
      claudeConfig,
      JSON.stringify({ projects: { [candidate]: { hasTrustDialogAccepted: false, lastCost: 1 } } }),
      "utf8",
    );
    const { receipt, undo } = await preTrustClaude(candidate, claudeConfig);
    expect(receipt.action).toBe("seeded");
    await undo();
    const config = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(config.projects[candidate].hasTrustDialogAccepted).toBe(false);
    expect(config.projects[candidate].lastCost).toBe(1);
  });
});

describe("preTrustCodex", () => {
  it("creates the config with a trusted project block when no config exists", async () => {
    const { receipt } = await preTrustCodex(candidate, codexConfig);
    expect(receipt.action).toBe("seeded");
    const config = await readFile(codexConfig, "utf8");
    expect(config).toContain(`[projects."${candidate}"]`);
    expect(config).toContain(`trust_level = "trusted"`);
  });

  it("appends without disturbing existing content and undo removes only the appended block", async () => {
    const existing = `model = "gpt-5.6-sol"\n\n[projects."/other"]\ntrust_level = "trusted"\n`;
    await writeFile(codexConfig, existing, "utf8");
    const { undo } = await preTrustCodex(candidate, codexConfig);
    expect(await readFile(codexConfig, "utf8")).toContain(`[projects."${candidate}"]`);
    await undo();
    expect(await readFile(codexConfig, "utf8")).toBe(existing);
  });

  it("reports already-trusted without rewriting when the project block exists", async () => {
    const existing = `[projects."${candidate}"]\ntrust_level = "trusted"\n`;
    await writeFile(codexConfig, existing, "utf8");
    const { receipt, undo } = await preTrustCodex(candidate, codexConfig);
    expect(receipt.action).toBe("already-trusted");
    expect(await readFile(codexConfig, "utf8")).toBe(existing);
    await undo();
    expect(await readFile(codexConfig, "utf8")).toBe(existing);
  });
});

describe("preTrustHarnesses", () => {
  it("returns one receipt per harness and cleanup reverts every seeded store", async () => {
    const result = await preTrustHarnesses(candidate, {
      claudeConfigPath: claudeConfig,
      codexConfigPath: codexConfig,
    });
    expect(result.receipts.map((receipt) => receipt.harness)).toEqual(["claude", "codex", "grok"]);
    expect(result.receipts[0]?.action).toBe("seeded");
    expect(result.receipts[1]?.action).toBe("seeded");
    expect(result.receipts[2]?.action).toBe("no-trust-surface");

    await result.cleanup();
    const claude = JSON.parse(await readFile(claudeConfig, "utf8"));
    expect(claude.projects[candidate]).toBeUndefined();
    expect(await readFile(codexConfig, "utf8")).not.toContain(candidate);
  });
});
