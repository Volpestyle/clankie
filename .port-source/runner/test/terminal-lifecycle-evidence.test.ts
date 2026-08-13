import { describe, expect, it } from "vitest";

describe("terminal lifecycle evidence fixture", () => {
  it("records self-validated sanitized observations from the direct runner scenario", async () => {
    const { artifact } = await import("../src/terminal-lifecycle-evidence.ts");
    expect(artifact.visualReconnect).toMatchObject({
      alternateBuffer: true,
      color: "indexed-red",
      cursorAddressed: true,
      cursorHidden: true,
      unicodeScalars: 2,
      snapshotSequence: 1,
      tailSequences: [2, 3, 4, 5],
      finalGeometry: { columns: 40, rows: 12 },
    });
    expect(artifact.visualReconnect.uninterruptedStateSha256).toBe(
      artifact.visualReconnect.reconstructedStateSha256,
    );
    expect(artifact.burstSlowConsumer).toMatchObject({
      emittedFrames: 500,
      queueLimit: 3,
      outcome: "snapshot-resync-and-close",
    });
    expect(artifact.leaseExitRestart).toMatchObject({
      observation: "lease-free",
      missingControl: "rejected",
      successfulControlInputCount: 1,
      contention: "rejected",
      positiveRenewal: "accepted",
      explicitRelease: "accepted",
      staleAfterRelease: "rejected",
      expiredControl: "rejected",
      observeOnlyInput: "rejected",
      observeOnlyResize: "rejected",
      outputCloseOrder: ["output", "closed"],
      restartOrphansClosed: 1,
      discoveryAfterRestart: 0,
      orphanLeaseAfterRestart: "revoked",
    });
    expect(artifact.nativePty).toMatchObject({
      provider: "native_pty",
      source: "runner_pty",
      ttyIdentity: "stdin-and-stdout-tty",
      geometry: { columns: 73, rows: 19 },
      successfulInputCount: 1,
      inputTriggeredResponse: "observed",
      ordering: ["output", "closed"],
      exitCode: 0,
    });
    expect(artifact.nativePty.outputByteCount).toBeGreaterThan(0);
    expect(artifact.nativePty.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
