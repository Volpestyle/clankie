import { randomBytes, randomUUID, type ECDH, type KeyObject } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  decodeEvidenceLease,
  evidenceCredentialId,
  sameEvidenceBinding,
  type CredentialStore,
  type EvidenceCredential,
} from "@clankie/credential-broker";
import type { EvidenceSessionBinding } from "@clankie/protocol/evidence-credentials";
import { EvidenceRefusal } from "./evidence-store.ts";
import type { EvidenceDestination } from "./evidence-storage.ts";

export interface EvidenceSdkCredential {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}
/** Trusted composition only. Neither settings nor HTTP callers can install this hook. */
export interface EvidenceCredentialProvider {
  credentials(
    destination: Extract<EvidenceDestination, { backend: "s3" }>,
    purpose: "read" | "write",
  ): () => Promise<EvidenceSdkCredential>;
}
export class EvidenceSessionUnavailable extends EvidenceRefusal {
  constructor() {
    super(503, "evidence_session_unavailable");
  }
}
export class EvidenceSessionTransient extends Error {
  constructor() {
    super("evidence_session_transport_unavailable");
  }
}

/** A private composition supplies transport, live host identity and the registered body key.
 * No URL, host credential, bootstrap or activation path is selected here.
 */
type BrokerEvidenceCredentialsOptions = {
  store: CredentialStore;
  binding(
    destination: Extract<EvidenceDestination, { backend: "s3" }>,
    purpose: "read" | "write",
  ): EvidenceSessionBinding | undefined;
  key: ECDH;
  verifyKeys: ReadonlyMap<string, KeyObject>;
  hostExpiresAtMs(): number;
  exchange(
    request: {
      destinationId: string;
      purpose: "read" | "write";
      nonce: string;
      startedAtMs: number;
      reconcile: boolean;
    },
    signal: AbortSignal,
  ): Promise<unknown>;
  clock?: () => number;
};

export class BrokerEvidenceCredentials implements EvidenceCredentialProvider {
  private readonly instanceId = randomUUID();
  private readonly validated = new Map<string, string>();
  private readonly options: BrokerEvidenceCredentialsOptions;
  constructor(options: BrokerEvidenceCredentialsOptions) {
    this.options = options;
  }

  credentials(destination: Extract<EvidenceDestination, { backend: "s3" }>, purpose: "read" | "write") {
    return async () => {
      try {
        return await this.resolve(destination, purpose);
      } catch {
        throw new EvidenceSessionUnavailable();
      }
    };
  }
  private async resolve(
    destination: Extract<EvidenceDestination, { backend: "s3" }>,
    purpose: "read" | "write",
  ): Promise<EvidenceSdkCredential> {
    const o = this.options,
      clock = o.clock ?? Date.now;
    const binding = o.binding(destination, purpose);
    if (
      !binding ||
      binding.bucket !== destination.bucket ||
      binding.region !== destination.region ||
      binding.prefix !== destination.prefix ||
      binding.purpose !== purpose ||
      !o.store.update
    )
      throw 0;
    const id = evidenceCredentialId(binding);
    const deadline = Date.now() + 10_000;
    for (;;) {
      let use: EvidenceCredential["lease"], pending: EvidenceCredential["pending"], epoch: string | undefined;
      await o.store.update(id, async (current) => {
        if (
          current.type !== "evidence-storage" ||
          !current.enabled ||
          !sameEvidenceBinding(current.binding, binding)
        )
          throw 0;
        epoch = current.epoch;
        const now = clock(),
          lease = current.lease;
        const admitted =
          this.validated.get(id) === current.epoch && !!lease && lease.expiresAtMs <= o.hostExpiresAtMs();
        if (admitted && now < (lease.issuedAtMs + lease.expiresAtMs) / 2) {
          use = lease;
          return current;
        }
        if (current.retryAtMs && current.retryAtMs > now) {
          if (admitted && lease.expiresAtMs - now > 60_000) {
            use = lease;
            return current;
          }
          throw 0;
        }
        if (current.pending?.inFlight && now - current.pending.attemptAtMs < 10_000) return current;
        // A deadline or crash leaves the original identity behind. The transport
        // must reconcile that exact exchange, never mint a replacement request.
        pending = current.pending
          ? { ...current.pending, attemptAtMs: now, inFlight: true, reconcile: true }
          : {
              nonce: randomBytes(16).toString("base64url"),
              instanceId: this.instanceId,
              startedAtMs: now,
              attemptAtMs: now,
              inFlight: true,
              reconcile: false,
            };
        return { ...current, pending };
      });
      if (!epoch) throw 0; // Missing entries cannot be created by refresh.
      if (use) return { ...use.session, expiration: new Date(use.expiresAtMs) };
      if (!pending) {
        if (Date.now() >= deadline) throw 0;
        await delay(20);
        continue;
      }
      const claimed = pending;
      let lease: EvidenceCredential["lease"],
        transient = false;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const timeout = new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(new EvidenceSessionTransient()), {
            once: true,
          }),
        );
        const reply = await Promise.race([
          o.exchange(
            {
              destinationId: binding.destinationId,
              purpose,
              nonce: claimed.nonce,
              startedAtMs: claimed.startedAtMs,
              reconcile: claimed.reconcile,
            },
            controller.signal,
          ),
          timeout,
        ]);
        lease = decodeEvidenceLease(reply, {
          binding,
          nonce: claimed.nonce,
          key: o.key,
          verifyKeys: o.verifyKeys,
          nowMs: clock(),
          hostExpiresAtMs: o.hostExpiresAtMs(),
        });
      } catch (error) {
        transient = error instanceof EvidenceSessionTransient;
      } finally {
        clearTimeout(timer);
      }
      let published: EvidenceCredential["lease"];
      let reconciledPreviousProcess = false;
      await o.store.update(id, async (current) => {
        if (
          current.type !== "evidence-storage" ||
          !current.enabled ||
          current.epoch !== epoch ||
          !sameEvidenceBinding(current.binding, binding) ||
          current.pending?.nonce !== claimed.nonce
        )
          return current;
        const { pending: _pending, lease: previous, ...base } = current;
        if (lease) {
          if (claimed.instanceId !== this.instanceId && this.validated.get(id) !== epoch)
            reconciledPreviousProcess = true;
          else published = lease;
          return { ...base, lease, retryAtMs: 0 };
        }
        if (transient) {
          if (
            this.validated.get(id) === epoch &&
            previous &&
            previous.expiresAtMs - clock() > 60_000 &&
            previous.expiresAtMs <= o.hostExpiresAtMs()
          )
            published = previous;
          return {
            ...base,
            pending: { ...claimed, inFlight: false, reconcile: true },
            ...(previous ? { lease: previous } : {}),
            retryAtMs: clock() + 1000,
          };
        }
        // A denial or invalid reply withdraws cached authority immediately.
        this.validated.delete(id);
        return { ...base, epoch: randomUUID(), enabled: false };
      });
      // Reconciliation settles an earlier process's request; it cannot stand in
      // for this process's mandatory fresh fleet check after restart.
      if (reconciledPreviousProcess) continue;
      if (!published) throw 0;
      this.validated.set(id, epoch);
      return { ...published.session, expiration: new Date(published.expiresAtMs) };
    }
  }
}

/** Offline composition / later admitted provider only; refresh itself never enables a grant. */
export async function admitEvidenceSession(store: CredentialStore, binding: EvidenceSessionBinding) {
  if (!store.updateMany) throw new EvidenceSessionUnavailable();
  const id = evidenceCredentialId(binding);
  await store.updateMany([id], async (current) => {
    const previous = current[id];
    if (previous?.type === "evidence-storage" && previous.binding.revision >= binding.revision)
      throw new EvidenceSessionUnavailable();
    return { [id]: { type: "evidence-storage", binding, enabled: true, epoch: randomUUID() } };
  });
}
export async function revokeEvidenceSession(store: CredentialStore, binding: EvidenceSessionBinding) {
  if (!store.update) throw new EvidenceSessionUnavailable();
  await store.update(evidenceCredentialId(binding), async (current) => {
    if (current.type !== "evidence-storage") throw new EvidenceSessionUnavailable();
    return { type: "evidence-storage", binding: current.binding, enabled: false, epoch: randomUUID() };
  });
}
