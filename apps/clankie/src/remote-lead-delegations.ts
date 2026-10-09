import { createHash, randomBytes, randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";

/** Host-authored launch identity. No request can select or change these fields. */
export interface RemoteLeadBinding {
  readonly fleet: string;
  readonly machine: string;
  readonly pane: string;
  readonly conversationId: string;
  readonly workingDirectory: string;
  readonly connectionKey: string;
  readonly nativeOccupantId: string;
  readonly shell: { readonly pid: number; readonly startTime: string };
}

interface Delegation {
  readonly id: string;
  readonly binding: RemoteLeadBinding;
  readonly abort: AbortController;
  proof?: ProjectProcessProof;
}

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Ephemeral by design: a service restart revokes every outstanding delegation. */
export class RemoteLeadDelegations {
  private readonly grants = new Map<string, Delegation>();
  private readonly admit: (binding: RemoteLeadBinding) => Promise<void>;
  constructor(admit: (binding: RemoteLeadBinding) => Promise<void>) {
    this.admit = admit;
  }

  /** Called only by the owner-authorized launcher, never by a fleet request. */
  async issue(binding: RemoteLeadBinding) {
    await this.admit(binding);
    if (binding.fleet === "default" || binding.machine === "local")
      throw new Error("remote_lead_machine_required");
    const token = randomBytes(32).toString("base64url");
    const grant: Delegation = {
      id: randomUUID(),
      binding: Object.freeze({ ...binding, shell: Object.freeze({ ...binding.shell }) }),
      abort: new AbortController(),
    };
    this.grants.set(digest(token), grant);
    return { id: grant.id, token, binding: grant.binding };
  }

  revoke(id: string): boolean {
    for (const [key, grant] of this.grants) {
      if (grant.id !== id) continue;
      this.grants.delete(key);
      grant.abort.abort();
      return true;
    }
    return false;
  }

  close(): void {
    for (const grant of this.grants.values()) grant.abort.abort();
    this.grants.clear();
  }

  async authorize(request: Request, identity: LocalFleetIdentity | undefined) {
    const bearer = request.headers.get("authorization");
    if (!bearer?.startsWith("Bearer ") || !identity) return undefined;
    const token = bearer.slice(7);
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    const key = digest(token);
    const grant = this.grants.get(key);
    if (!grant) return undefined;
    const { binding } = grant;
    const current = () =>
      this.grants.get(key) === grant && !grant.abort.signal.aborted && identity.current?.() === true;
    const matches = (proof: ProjectProcessProof | undefined): proof is ProjectProcessProof =>
      proof !== undefined &&
      !proof.nativeSessionPending &&
      proof.fleet === binding.fleet &&
      proof.workspace?.machineId === binding.machine &&
      win32.normalize(proof.workspace.canonicalPath).toLowerCase() ===
        win32.normalize(binding.workingDirectory).toLowerCase() &&
      proof.pane === binding.pane &&
      isDeepStrictEqual(proof.shell, binding.shell) &&
      proof.nativeOccupantId === binding.nativeOccupantId;
    const observe = async () => {
      if (!current() || identity.fleet !== binding.fleet || identity.pane !== binding.pane) return undefined;
      await this.admit(binding);
      if (!(await identity.validate())) return undefined;
      const proof = await identity.projectProof?.();
      if (!matches(proof) || !(await identity.validate()) || !current()) return undefined;
      if (grant.proof && !isDeepStrictEqual(grant.proof, proof)) return undefined;
      grant.proof ??= structuredClone(proof);
      return proof;
    };
    const initial = await observe();
    if (!initial) return undefined;
    return {
      id: grant.id,
      binding,
      signal: grant.abort.signal,
      current,
      authorize: async () => isDeepStrictEqual(await observe(), initial) && current(),
    };
  }
}
