import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { acquireBodyLock, BodyBusyError, BODY_LOCK_FILENAME } from "../src/body-lock.ts";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "body-lock-"));
}

describe("body lock", () => {
  it("refuses a second holder while the first is alive", () => {
    const rootDir = root();
    const first = acquireBodyLock({ rootDir, holderId: "free-play-live", pid: 4242, isAlive: () => true });
    expect(() => acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: () => true })).toThrow(
      BodyBusyError,
    );

    // The refusal names who to stop — a bare "busy" would leave you guessing
    // which of three entrypoints has the body.
    try {
      acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: () => true });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain("free-play-live");
      expect((error as Error).message).toContain("4242");
    }

    first.release();
    expect(existsSync(path.join(rootDir, BODY_LOCK_FILENAME))).toBe(false);
  });

  it("reclaims a lock whose holder died", () => {
    const rootDir = root();
    acquireBodyLock({ rootDir, holderId: "crashed-run", pid: 4242, isAlive: () => true });

    // A crash must not brick the body until someone deletes a file by hand.
    const second = acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: (pid) => pid !== 4242 });
    expect(second.holder.holderId).toBe("gba-mcp");
  });

  it("reclaims an unparseable lock", () => {
    const rootDir = root();
    writeFileSync(path.join(rootDir, BODY_LOCK_FILENAME), "{ truncated");
    const lock = acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: () => true });
    expect(lock.holder.holderId).toBe("gba-mcp");
  });

  it("does not release a lock that was reclaimed by someone else", () => {
    const rootDir = root();
    const stale = acquireBodyLock({ rootDir, holderId: "crashed-run", pid: 4242, isAlive: () => true });
    // Its process died; a live entrypoint took the body over.
    const live = acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: (pid) => pid !== 4242 });

    // The dead holder's cleanup must not unlock the new one — that would hand
    // the body to a third process while the second is mid-playthrough.
    stale.release();
    expect(existsSync(path.join(rootDir, BODY_LOCK_FILENAME))).toBe(true);
    expect(() => acquireBodyLock({ rootDir, holderId: "third", pid: 7, isAlive: () => true })).toThrow(
      BodyBusyError,
    );
    live.release();
  });

  it("treats a permission error as alive", () => {
    // A lock owned by another user's process exists; refusing is correct.
    const rootDir = root();
    acquireBodyLock({ rootDir, holderId: "other-user", pid: 4242, isAlive: () => true });
    expect(() => acquireBodyLock({ rootDir, holderId: "gba-mcp", pid: 99, isAlive: () => true })).toThrow(
      BodyBusyError,
    );
  });
});
