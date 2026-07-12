import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { publishProviderReadinessSignal } from "../src/provider-readiness-signal.ts";

describe("runner provider readiness signal", () => {
  it("publishes a private nonce-bound ready signal only for the exact production fleet", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "clankie-runner-ready-")), "readiness.json");
    const signal = await publishProviderReadinessSignal({
      path,
      nonce: "a".repeat(32),
      runnerId: "runner-live",
      reports: [
        { provider: "codex", workerId: "codex-implementation", status: "ready", issues: [] },
        { provider: "claude", workerId: "claude-verification", status: "ready", issues: [] },
        { provider: "pi", workerId: "pi-debugging", status: "ready", issues: [] },
      ],
    });
    expect(signal.status).toBe("ready");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(signal);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("records provider-factory boundary failures without credential content", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "clankie-runner-unready-")), "readiness.json");
    const signal = await publishProviderReadinessSignal({
      path,
      nonce: "b".repeat(32),
      runnerId: "runner-live",
      reports: [
        {
          provider: "codex",
          workerId: "codex-implementation",
          status: "unavailable",
          issues: [{ code: "tool_boundary_unavailable", message: "SECRET must not persist" }],
        },
        { provider: "claude", workerId: "claude-verification", status: "ready", issues: [] },
        {
          provider: "pi",
          workerId: "pi-debugging",
          status: "unavailable",
          issues: [{ code: "isolation_unavailable", message: "Seatbelt missing" }],
        },
      ],
    });
    expect(signal.status).toBe("unavailable");
    expect(JSON.stringify(signal)).toContain("tool_boundary_unavailable");
    expect(JSON.stringify(signal)).toContain("isolation_unavailable");
    expect(JSON.stringify(signal)).not.toContain("SECRET");
    expect(JSON.stringify(signal)).not.toContain("Seatbelt missing");
  });
});
