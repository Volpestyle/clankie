/**
 * Clankie's own bearers in the protected keychain (VUH-2592, extended). The
 * login keychain answers any same-user process without a prompt, so every
 * credential that grants authority over Clankie itself (the captain bearer,
 * the bridge and producer bearers, joined-host tokens, the gateway bearer and
 * its wrapping key) belongs beside the operator credential in the protected
 * keychain, which the worker sandbox denies to hired workers.
 *
 * Readers find a protected copy first and fall back to the login keychain until
 * the owner runs the move; writes land in the protected keychain once it exists.
 * The worker sandbox is what makes the file unreadable to a hire: with
 * `fleet.workerSandbox` off, a same-user process can still unlock it.
 */
import {
  createDefaultCredentialStore,
  type CredentialGroup,
  type CredentialStore,
  type CredentialStoreHealth,
  type ProviderCredential,
} from "./credential-store.ts";
import {
  ensureProtectedKeychain,
  hasProtectedKeychain,
  protectedKeychainPath,
  ProtectedKeychainStore,
} from "./protected-keychain.ts";

/** Exact provider ids that grant authority over Clankie itself. */
export const PROTECTED_CREDENTIAL_IDS: readonly string[] = [
  "clankie_operator",
  "clankie_captain",
  "clankie_discord_bridge",
  "clankie_discord_voice_bridge",
  "clankie_discord_user_bridge",
  "clankie_discord_user_voice_bridge",
  "clankie_activity_producer",
  "clankie_play_voice",
  "clankie-public-gateway",
  "clankie-gateway-encryption",
];
const PROTECTED_PREFIXES = ["clankie-joined-host-"] as const;

export function isProtectedCredentialId(providerId: string): boolean {
  return (
    PROTECTED_CREDENTIAL_IDS.includes(providerId) ||
    PROTECTED_PREFIXES.some((prefix) => providerId.startsWith(prefix))
  );
}

/** One per keychain and process, so a per-request reader unlocks it once. */
const protectedStores = new Map<string, ProtectedKeychainStore>();
function protectedStore(env: NodeJS.ProcessEnv): ProtectedKeychainStore {
  const key = `${protectedKeychainPath(env)}\0${env.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS ?? ""}`;
  let store = protectedStores.get(key);
  if (!store) {
    store = new ProtectedKeychainStore({ env });
    protectedStores.set(key, store);
  }
  return store;
}

/**
 * The broker view an owner process reads Clankie's bearers through: protected
 * ids come from the protected keychain first (once it exists), everything else
 * from `legacy` unchanged. A worker pane's sandbox denying the protected file
 * reads as absent, never as a fault, as the operator credential already does.
 */
export class ProtectedFirstCredentialStore implements CredentialStore {
  private readonly legacy: CredentialStore;
  private readonly primary: CredentialStore;
  private readonly workerPane: boolean;

  public constructor(input: { legacy: CredentialStore; primary: CredentialStore; workerPane?: boolean }) {
    this.legacy = input.legacy;
    this.primary = input.primary;
    this.workerPane = input.workerPane === true;
  }

  // Lock health and grouped updates stay the login keychain's: no protected id is grouped.
  public health(): CredentialStoreHealth {
    return this.legacy.health?.() ?? { state: "ready" };
  }

  public observeHealth(listener: (health: CredentialStoreHealth) => void): () => void {
    return this.legacy.observeHealth?.(listener) ?? (() => undefined);
  }

  public updateMany(
    providerIds: readonly string[],
    transform: (current: CredentialGroup) => Promise<CredentialGroup>,
  ): Promise<CredentialGroup> {
    if (providerIds.some(isProtectedCredentialId))
      return Promise.reject(new Error("Protected credentials are never updated as a group"));
    if (!this.legacy.updateMany) return Promise.reject(new Error("Grouped updates are unavailable"));
    return this.legacy.updateMany(providerIds, transform);
  }

  public async update(
    providerId: string,
    transform: (current: ProviderCredential) => Promise<ProviderCredential>,
  ): Promise<ProviderCredential | undefined> {
    if (isProtectedCredentialId(providerId) && this.primary.update) {
      const updated = await this.primary.update(providerId, transform);
      if (updated !== undefined) return updated;
    }
    if (!this.legacy.update) throw new Error("Credential updates are unavailable");
    return this.legacy.update(providerId, transform);
  }

  public async get(providerId: string): Promise<ProviderCredential | undefined> {
    if (isProtectedCredentialId(providerId)) {
      try {
        const held = await this.primary.get(providerId);
        if (held !== undefined) return held;
      } catch (error) {
        if (!this.workerPane) throw error;
      }
    }
    return this.legacy.get(providerId);
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    return isProtectedCredentialId(providerId)
      ? this.primary.set(providerId, credential)
      : this.legacy.set(providerId, credential);
  }

  public async delete(
    providerId: string,
    beforeDelete?: (current: ProviderCredential) => Promise<void>,
  ): Promise<boolean> {
    if (!isProtectedCredentialId(providerId)) return this.legacy.delete(providerId, beforeDelete);
    const fromPrimary = await this.primary.delete(providerId, beforeDelete);
    // The revocation callback runs once, against whichever copy was current.
    const fromLegacy = await this.legacy.delete(providerId, fromPrimary ? undefined : beforeDelete);
    return fromPrimary || fromLegacy;
  }

  public async list() {
    const legacy = await this.legacy.list();
    let held: Awaited<ReturnType<CredentialStore["list"]>> = {};
    try {
      held = await this.primary.list();
    } catch (error) {
      if (!this.workerPane) throw error;
    }
    return { ...legacy, ...held };
  }
}

/**
 * The store a credential reader uses when the caller injected none: protected
 * first on a Mac that has the protected keychain, otherwise the default store.
 * A file override (tests, scratch stacks) is used as given.
 */
export function createOwnerCredentialStore(env: NodeJS.ProcessEnv = process.env): CredentialStore {
  const legacy = createDefaultCredentialStore({ env });
  if (env.CLANKIE_CREDENTIALS_FILE?.trim() || !hasProtectedKeychain(env)) return legacy;
  return new ProtectedFirstCredentialStore({
    legacy,
    primary: protectedStore(env),
    workerPane: env.CLANKIE_WORKER_PANE === "1",
  });
}

export interface ProtectCredentialsResult {
  /** The protected keychain was created by this call. */
  readonly created: boolean;
  /** Ids moved out of the login keychain by this call. */
  readonly moved: readonly string[];
  /** Ids whose protected copy did not read back; their login copy is kept. */
  readonly failed: readonly string[];
}

/**
 * Moves every protected id still in the login keychain into the protected
 * keychain, deleting each login copy only after its protected copy reads back
 * equal. Idempotent: a second run moves nothing. Values are unchanged, so
 * running services keep working; nothing is printed but ids.
 */
export async function protectStoredCredentials(
  input: { env?: NodeJS.ProcessEnv; legacy?: CredentialStore; primary?: CredentialStore } = {},
): Promise<ProtectCredentialsResult> {
  const env = input.env ?? process.env;
  if (env.CLANKIE_WORKER_PANE === "1")
    throw new Error("Hired workers can't move the owner's credentials. Ask your lead.");
  if (input.primary === undefined && process.platform !== "darwin")
    throw new Error("The protected keychain needs macOS");
  const created = input.primary === undefined ? await ensureProtectedKeychain({ env }) : false;
  const primary = input.primary ?? protectedStore(env);
  const legacy = input.legacy ?? createDefaultCredentialStore({ env });
  const moved: string[] = [];
  const failed: string[] = [];
  for (const providerId of await loginProtectedIds(legacy)) {
    const value = await legacy.get(providerId);
    if (value === undefined) continue;
    await primary.set(providerId, value);
    const copied = await primary.get(providerId);
    if (copied === undefined || JSON.stringify(copied) !== JSON.stringify(value)) {
      failed.push(providerId);
      continue;
    }
    await legacy.delete(providerId);
    moved.push(providerId);
  }
  return { created, moved, failed };
}

/** Protected ids still held by the login keychain (or `legacy`); ids only, never values. */
export async function loginProtectedIds(
  legacy?: CredentialStore,
  env?: NodeJS.ProcessEnv,
): Promise<string[]> {
  const store = legacy ?? createDefaultCredentialStore(env === undefined ? {} : { env });
  return Object.keys(await store.list())
    .filter(isProtectedCredentialId)
    .sort();
}
