import { mkdtemp, readFile } from "node:fs/promises";
import { JsonlEventStore } from "@clankie/event-store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runSelfBuildLab } from "../src/lab.ts";

describe("lead-agent self-build lab", () => {
  it("detects, repairs, verifies, governs, and evaluates a faulty change", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "clankie-eval-artifacts-"));
    const run = await runSelfBuildLab({ outputDirectory, generatedAt: "2026-07-10T00:00:00.000Z" });
    expect(run.report.passed).toBe(true);
    expect(run.report.criticalFailures).toEqual([]);
    expect(run.garden.agents.some((agent) => agent.location === "recovery_shed")).toBe(true);
    const markdown = await readFile(join(outputDirectory, "self-build-report.md"), "utf8");
    expect(markdown).toContain("**Result:** PASS");
    const audit = await new JsonlEventStore(join(outputDirectory, "self-build-audit.jsonl")).verify();
    expect(audit).toMatchObject({ valid: true, count: run.events.length });
  });
});
