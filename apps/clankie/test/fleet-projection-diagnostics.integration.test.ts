import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLogger } from "@clankie/observability";
import { fleetProjectionDiagnostics } from "../src/captain/fleet-projection-diagnostics.ts";

it("writes content-free phase diagnostics across real file reads without changing results or errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-timing-"));
  const destination = createWriteStream(join(root, "diagnostic.jsonl"));
  try {
    const diagnostics = fleetProjectionDiagnostics(
      createLogger({ service: "clankie-test" }, { level: "info" }, destination),
    );
    const path = join(root, "private-content.txt");
    const content = "private-result-and-path-must-not-be-logged";
    await writeFile(path, content);
    const stopSettings = diagnostics.start("settings_binding");
    stopSettings();
    const stopCensus = diagnostics.start("census");
    diagnostics.census("herdr:default", true);
    diagnostics.census("herdr:pc", true);
    const values = await Promise.all([
      diagnostics.measure("capability", () => readFile(path, "utf8")),
      diagnostics.measure("capability", () => readFile(path, "utf8")),
    ]);
    expect(values).toEqual([content, content]);
    diagnostics.census("herdr:default", false, "ok");
    diagnostics.census("herdr:pc", false, "error");
    stopCensus();
    await diagnostics.measure("issue_attribution", () => readFile(path, "utf8"));
    await diagnostics.measure("issue_keeper", () => readFile(path, "utf8"));
    for (const phase of [
      "issue_proof_local",
      "issue_proof_remote",
      "issue_project_membership",
      "issue_head_assignments",
    ] as const)
      await diagnostics.measure(phase, () => readFile(path, "utf8"));
    let original: unknown;
    const failure = await diagnostics
      .measure("activity", async () => {
        try {
          return await readFile(join(root, "missing-private-path"));
        } catch (error) {
          original = error;
          throw error;
        }
      })
      .catch((error) => error);
    expect(failure).toBe(original);
    diagnostics.complete("error");
    const laterContent = "later-private-value";
    await writeFile(path, laterContent);
    expect(await diagnostics.measure("issue_project_membership", () => readFile(path, "utf8"))).toBe(
      laterContent,
    );
    let laterOriginal: unknown;
    const laterFailure = await diagnostics
      .measure("issue_project_membership", async () => {
        try {
          return await readFile(join(root, "later-missing-private-path"));
        } catch (error) {
          laterOriginal = error;
          throw error;
        }
      })
      .catch((error) => error);
    expect(laterFailure).toBe(laterOriginal);
    diagnostics.complete("ok");
    await new Promise<void>((resolve) => destination.end(resolve));
    const raw = await readFile(join(root, "diagnostic.jsonl"), "utf8");
    const record = JSON.parse(raw);
    expect(record.event).toBe("fleet.projection.timings");
    expect(record.outcome).toBe("error");
    expect(record.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "settings_binding", outcome: "ok" }),
        expect.objectContaining({ phase: "census", outcome: "ok" }),
        expect.objectContaining({ phase: "pc_fleet", outcome: "error" }),
        expect.objectContaining({ phase: "activity", outcome: "error" }),
        expect.objectContaining({ phase: "issue_attribution", outcome: "ok" }),
        expect.objectContaining({ phase: "issue_keeper", outcome: "ok" }),
        ...[
          "issue_proof_local",
          "issue_proof_remote",
          "issue_project_membership",
          "issue_head_assignments",
        ].map((phase) => expect.objectContaining({ phase, outcome: "ok" })),
      ]),
    );
    for (const phase of record.phases) {
      expect(Number.isFinite(phase.durationMs)).toBe(true);
      expect(phase.durationMs).toBeGreaterThanOrEqual(0);
      expect(phase.maxCallMs).toBeLessThanOrEqual(phase.durationMs + 0.001);
      expect(phase.durationMs).toBeLessThanOrEqual(record.durationMs + 0.001);
    }
    expect(raw).not.toContain(content);
    expect(raw).not.toContain(laterContent);
    expect(raw).not.toContain(root);
    expect(raw).not.toContain("missing-private-path");
    expect(raw).not.toContain("ENOENT");
  } finally {
    destination.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
