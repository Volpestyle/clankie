import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { evidenceCredentialId, providerCredentialBearer, redactCredential } from "@clankie/credential-broker";
import {
  admitEvidenceSession,
  BrokerEvidenceCredentials,
  revokeEvidenceSession,
} from "../src/evidence-credentials.ts";
import { evidenceS3Client } from "../src/evidence-storage.ts";
import { ClankieSettingsSchema } from "@clankie/settings";
import { fleetFixture } from "./fixtures/evidence-session/fleet.ts";

it("keeps defaults local and managed credentials closed; renews once across concurrent broker instances, refuses expiry/outage and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-session-"));
  const f = await fleetFixture(root);
  const credentials = f.provider.credentials(f.destination, "read");
  try {
    expect(ClankieSettingsSchema.parse({ schemaVersion: 1 }).evidence).toEqual({ backend: "local" });
    expect(f.calls).toBe(0);
    const missing = evidenceS3Client(f.destination, "read", { managedEvidence: true });
    try {
      await expect(missing.config.credentials()).rejects.toThrow("evidence_session_unavailable");
    } finally {
      missing.destroy();
    }
    const first = await credentials();
    const concurrent = new BrokerEvidenceCredentials(f.providerOptions);
    // A new process/provider must perform fresh admission once, even with persisted bytes.
    await concurrent.credentials(f.destination, "read")();
    const before = f.calls;
    f.advance(450_001);
    const renewed = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        index % 2 ? concurrent.credentials(f.destination, "read")() : credentials(),
      ),
    );
    expect(f.calls).toBe(before + 1);
    expect(renewed.every((value) => value.accessKeyId === renewed[0]!.accessKeyId)).toBe(true);
    expect(renewed[0]!.accessKeyId === first.accessKeyId).toBe(false);
    f.advance(450_001);
    f.mode("outage");
    expect((await credentials()).accessKeyId === renewed[0]!.accessKeyId).toBe(true);
    f.advance(391_000);
    await expect(credentials()).rejects.toThrow("evidence_session_unavailable");
    const restarted = new BrokerEvidenceCredentials(f.providerOptions);
    await expect(restarted.credentials(f.destination, "read")()).rejects.toThrow(
      "evidence_session_unavailable",
    );
    expect(await f.broker.list()).toEqual({});
    const entry = (await f.broker.get(evidenceCredentialId(f.binding("read"))))!;
    expect(providerCredentialBearer(entry)).toBeUndefined();
    const captured = JSON.stringify([
      redactCredential(entry),
      ClankieSettingsSchema.parse({ schemaVersion: 1 }),
    ]);
    expect(f.markers.some((secret) => captured.includes(secret))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const field of [
  "tenantId",
  "installationId",
  "bodyKeyId",
  "encryptionKeyId",
  "audience",
  "destinationId",
  "bucket",
  "region",
  "prefix",
  "purpose",
  "revision",
  "nonce",
  "expired",
  "malformed",
  "future",
  "overlong",
] as const) {
  it(`refuses a signed but incorrectly bound ${field} reply and clears prior authority`, async () => {
    const root = await mkdtemp(join(tmpdir(), "evidence-refusal-"));
    const f = await fleetFixture(root),
      resolve = f.provider.credentials(f.destination, "read");
    try {
      await resolve();
      f.advance(450_001);
      f.transform((lease) => {
        if (field === "malformed") return { bad: true };
        if (field === "expired") return { ...lease, expiresAtMs: f.now - 1 };
        if (field === "future") return { ...lease, issuedAtMs: f.now + 5000 };
        if (field === "overlong") return { ...lease, expiresAtMs: f.now + 900_001 };
        if (field === "nonce") return { ...lease, nonce: "x".repeat(22) };
        return {
          ...lease,
          binding: {
            ...lease.binding,
            [field]:
              field === "revision"
                ? 2
                : field === "purpose"
                  ? "write"
                  : field === "bodyKeyId" || field === "encryptionKeyId"
                    ? "x".repeat(43)
                    : "wrong",
          },
        };
      });
      await expect(resolve()).rejects.toThrow("evidence_session_unavailable");
      const current = await f.broker.get(evidenceCredentialId(f.binding("read")));
      expect(current?.type === "evidence-storage" && !current.enabled && !current.lease).toBe(true);
      await expect(
        new BrokerEvidenceCredentials(f.providerOptions).credentials(f.destination, "read")(),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
it("refuses response replay, explicit denial, missing/disabled admission, foreign destinations and late renewal after durable revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-revoke-"));
  try {
    for (const mode of ["deny", "replay", "revoke", "missing", "disabled"] as const) {
      const f = await fleetFixture(join(root, mode)),
        resolve = f.provider.credentials(f.destination, "read");
      await resolve();
      f.advance(450_001);
      if (mode === "deny") f.mode("deny");
      if (mode === "replay") f.replay();
      if (mode === "missing") await f.broker.delete(evidenceCredentialId(f.binding("read")));
      if (mode === "disabled") await revokeEvidenceSession(f.broker, f.binding("read"));
      if (mode === "revoke") {
        let release!: () => void, entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const barrier = new Promise<void>((resolve) => {
          release = resolve;
        });
        f.hold(async () => {
          entered();
          await barrier;
        });
        const held = resolve();
        await started;
        await revokeEvidenceSession(f.broker, f.binding("read"));
        release();
        await expect(held).rejects.toThrow("evidence_session_unavailable");
      } else await expect(resolve()).rejects.toThrow("evidence_session_unavailable");
      await expect(
        new BrokerEvidenceCredentials(f.providerOptions).credentials(f.destination, "read")(),
      ).rejects.toThrow();
      await expect(
        f.provider.credentials({ ...f.destination, bucket: "foreign-tenant-bucket" }, "read")(),
      ).rejects.toThrow();
      await expect(
        f.provider.credentials({ ...f.destination, prefix: "foreign" }, "read")(),
      ).rejects.toThrow();
      const raw = await readFile(join(root, mode, "broker.json"), "utf8");
      if (mode === "revoke" || mode === "deny" || mode === "replay")
        expect(f.markers.some((secret) => raw.includes(secret))).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reconciles an uncertain exchange with its original identity; refuses unknown signing keys, invalid signatures and malformed envelopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-uncertain-"));
  try {
    const f = await fleetFixture(join(root, "uncertain"));
    f.mode("uncertain");
    const credentials = f.provider.credentials(f.destination, "read");
    await expect(credentials()).rejects.toThrow("evidence_session_unavailable");
    f.advance(1001);
    f.mode("ok");
    await credentials();
    expect(f.requests.length).toBe(2);
    expect(f.requests[0]!.nonce === f.requests[1]!.nonce).toBe(true);
    expect(f.requests[1]!.reconcile).toBe(true);
    for (const failure of ["unknown-key", "signature", "malformed"] as const) {
      const invalid = await fleetFixture(join(root, failure));
      invalid.wire((reply) =>
        failure === "malformed"
          ? { bad: true }
          : {
              ...(reply as object),
              [failure === "unknown-key" ? "kid" : "signature"]: "x".repeat(
                failure === "unknown-key" ? 16 : 86,
              ),
            },
      );
      await expect(invalid.provider.credentials(invalid.destination, "read")()).rejects.toThrow(
        "evidence_session_unavailable",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses a stale signed grant revision after admission replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-revision-"));
  try {
    const f = await fleetFixture(root);
    await f.provider.credentials(f.destination, "read")();
    const next = { ...f.binding("read"), revision: 2 };
    await admitEvidenceSession(f.broker, next);
    f.providerOptions.binding = () => next;
    await expect(f.provider.credentials(f.destination, "read")()).rejects.toThrow(
      "evidence_session_unavailable",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds a hung exchange to ten seconds and retains its identity for reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-deadline-"));
  try {
    const f = await fleetFixture(root);
    let aborted = false;
    f.providerOptions.exchange = async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("offline exchange aborted"));
          },
          { once: true },
        );
      });
    const started = Date.now();
    await expect(f.provider.credentials(f.destination, "read")()).rejects.toThrow(
      "evidence_session_unavailable",
    );
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(10_000);
    const current = await f.broker.get(evidenceCredentialId(f.binding("read")));
    expect(
      current?.type === "evidence-storage" &&
        current.pending?.reconcile === true &&
        current.lease === undefined,
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("requires fresh admission after reconciling an earlier process's uncertain exchange", async () => {
  const root = await mkdtemp(join(tmpdir(), "evidence-restart-uncertain-"));
  try {
    const f = await fleetFixture(root);
    f.mode("uncertain");
    await expect(f.provider.credentials(f.destination, "read")()).rejects.toThrow(
      "evidence_session_unavailable",
    );
    f.advance(1001);
    f.mode("deny");
    const restarted = new BrokerEvidenceCredentials(f.providerOptions);
    await expect(restarted.credentials(f.destination, "read")()).rejects.toThrow(
      "evidence_session_unavailable",
    );
    expect(f.requests.length).toBe(3);
    expect(f.requests[0]!.nonce === f.requests[1]!.nonce).toBe(true);
    expect(f.requests[1]!.reconcile).toBe(true);
    expect(f.requests[2]!.nonce === f.requests[1]!.nonce).toBe(false);
    expect(f.requests[2]!.reconcile).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
