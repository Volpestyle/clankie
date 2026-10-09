import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, openSync, closeSync, fsyncSync, constants } from "node:fs";
import { z } from "zod";
import { privateDirectory, readPrivateJson, writePrivateJson } from "../../tui/bin/update-files.ts";
import { join, win32 } from "node:path";
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

const text = z.string().min(1).max(4096);
const processIdentity = z.object({ pid: z.number().int().positive(), startTime: text }).strict();
const Binding = z
  .object({
    fleet: text,
    machine: text,
    pane: text,
    conversationId: text,
    workingDirectory: text,
    connectionKey: text,
    nativeOccupantId: text,
    shell: processIdentity,
  })
  .strict();
const Proof = z
  .object({
    fleet: text,
    pane: text,
    nativeOccupantId: text,
    shell: processIdentity,
    binding: z.object({ socketPath: text, session: text.optional() }).strict(),
    processes: z.array(processIdentity).min(1),
    workspace: z
      .object({ machineId: text, platform: z.enum(["windows", "posix"]), canonicalPath: text })
      .strict()
      .optional(),
    nativeSessionPending: z.literal(true).optional(),
    privateSeat: z.literal(true).optional(),
  })
  .strict();
const Record = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    binding: Binding,
    proof: Proof.optional(),
    revoked: z.boolean(),
  })
  .strict();

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Owner launch intent survives restart; each request re-proves the original native lifetime. */
export class RemoteLeadDelegations {
  private readonly grants = new Map<string, Delegation>();
  private readonly revoked = new Set<string>();
  private readonly directory: string | undefined;
  private readonly admit: (binding: RemoteLeadBinding) => Promise<void>;
  constructor(admit: (binding: RemoteLeadBinding) => Promise<void>, directory?: string) {
    this.admit = admit;
    this.directory = directory;
    if (directory) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      privateDirectory(directory);
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        const key = name.slice(0, -5);
        try {
          const record = Record.parse(readPrivateJson(join(directory, name)));
          if (record.revoked) this.revoked.add(key);
          // A launch never observed before shutdown cannot prove the same process on recovery.
          else if (record.proof) {
            const { workspace, nativeSessionPending, privateSeat, binding, ...proof } = record.proof;
            this.grants.set(key, {
              id: record.id,
              binding: Object.freeze({
                ...record.binding,
                shell: Object.freeze({ ...record.binding.shell }),
              }),
              proof: {
                ...proof,
                binding: {
                  socketPath: binding.socketPath,
                  ...(binding.session === undefined ? {} : { session: binding.session }),
                },
                ...(workspace === undefined ? {} : { workspace }),
                ...(nativeSessionPending === undefined ? {} : { nativeSessionPending }),
                ...(privateSeat === undefined ? {} : { privateSeat }),
              },
              abort: new AbortController(),
            });
          }
        } catch {
          // Unreadable or incompatible private records carry no authority.
        }
      }
    }
  }

  private save(key: string, grant: Delegation, revoked = false): void {
    if (!this.directory) return;
    const path = join(this.directory, `${key}.json`);
    writePrivateJson(
      path,
      Record.parse({ schemaVersion: 1, id: grant.id, binding: grant.binding, proof: grant.proof, revoked }),
    );
    for (const target of [path, this.directory]) {
      const file = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
    }
  }

  isRevoked(request: Request): boolean {
    const bearer = request.headers.get("authorization");
    return bearer?.startsWith("Bearer ") === true && this.revoked.has(digest(bearer.slice(7)));
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
    this.save(digest(token), grant);
    this.grants.set(digest(token), grant);
    return { id: grant.id, token, binding: grant.binding };
  }

  revoke(id: string): boolean {
    for (const [key, grant] of this.grants) {
      if (grant.id !== id) continue;
      this.save(key, grant, true);
      this.revoked.add(key);
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
      if (!grant.proof) {
        const pinned = { ...grant, proof: structuredClone(proof) };
        this.save(key, pinned);
        grant.proof = pinned.proof;
      }
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
