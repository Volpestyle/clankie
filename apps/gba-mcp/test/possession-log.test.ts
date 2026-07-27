import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PossessionLease } from "../src/possession.ts";
import { createPossessionEventLog, parsePossessionEventLog } from "../src/possession-log.ts";

describe("possession event log", () => {
  it("records every lease transition durably, not just on stderr", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "possession-log-"));
    const at = { value: 1_000 };
    const log = createPossessionEventLog({
      rootDir,
      clock: () => new Date("2026-07-27T02:00:00.000Z"),
    });
    // The real producer: a lease wired the way the stdio entrypoint wires it.
    const lease = new PossessionLease({
      allowedHolders: ["claude-code", "codex"],
      ttlMs: 500,
      now: () => at.value,
      onEvent: (event) => log.append(event),
    });

    const grant = lease.acquire("claude-code");
    expect(() => lease.acquire("intruder")).toThrow(/not_allowed/);
    lease.release(grant.token);
    lease.acquire("claude-code");
    at.value += 1_000; // TTL passes: the next look expires the idle holder.
    expect(lease.current()).toBeNull();
    lease.acquire("claude-code");
    lease.acquire("codex", { force: true });

    const records = parsePossessionEventLog(readFileSync(log.path, "utf8"));
    expect(records.map((record) => record.type)).toEqual([
      "acquired",
      "refused",
      "released",
      "acquired",
      "expired",
      "acquired",
      "stolen",
    ]);
    expect(records[1]).toMatchObject({ holderId: "intruder", reason: "holder_not_allowed" });
    expect(records[6]).toMatchObject({ holderId: "codex", previousHolderId: "claude-code" });
    expect(records.every((record) => record.at === "2026-07-27T02:00:00.000Z")).toBe(true);
  });

  it("reports an append failure instead of blocking the lease", () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), "possession-log-error-"));
    const errors: unknown[] = [];
    const log = createPossessionEventLog({ rootDir, onError: (error) => errors.push(error) });
    rmSync(rootDir, { recursive: true, force: true });
    log.append({ type: "acquired", holderId: "claude-code" });
    expect(errors).toHaveLength(1);
  });
});
