import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { z } from "zod";
import lockfile from "proper-lockfile";
import { EvidenceCredentialSchema } from "./evidence-credential.ts";

export const ProviderAccountSchema = z
  .object({
    provider: z.literal("linear"),
    connectionId: z.string().uuid(),
    userId: z.string().min(1),
    workspaceId: z.string().min(1),
    email: z.string().min(1).optional(),
    /** Provider-verified actor kind; older user connections omit it. */
    actor: z.enum(["user", "app"]).optional(),
    name: z.string().min(1),
    workspaceName: z.string().min(1),
    verifiedAt: z.string().datetime(),
  })
  .strict();
export type ProviderAccount = z.infer<typeof ProviderAccountSchema>;

/**
 * Typed at-rest credentials for LLM providers.
 *
 * - `api`: a long-lived API key, plus optional non-secret metadata.
 * - `oauth`: an access/refresh token pair. `expires` is epoch milliseconds; 0 means no expiry.
 * - `wellknown`: a key/token pair for providers that authenticate with both.
 */
export const ProviderCredentialSchema = z.discriminatedUnion("type", [
  EvidenceCredentialSchema,
  z.object({
    type: z.literal("api"),
    key: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    account: ProviderAccountSchema.optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    access: z.string(),
    refresh: z.string(),
    expires: z.number().int().nonnegative(),
    accountId: z.string().optional(),
    /** Dynamic-registration client id (Linear MCP OAuth). */
    clientId: z.string().optional(),
    /** Dynamic-registration client secret, when the AS issued one. */
    clientSecret: z.string().optional(),
    /** API-audience app/user tokens never authenticate the legacy MCP audience. */
    linearAuth: z.enum(["app", "api"]).optional(),
    /** Body-owned Google OAuth; unrelated harness tokens are never eligible. */
    googleAuth: z.literal("user").optional(),
    /** Broker-only connection metadata, including actual provider-granted scopes. */
    metadata: z.record(z.string(), z.string()).optional(),
    account: ProviderAccountSchema.optional(),
  }),
  z.object({
    type: z.literal("wellknown"),
    key: z.string(),
    token: z.string(),
  }),
]);
export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;

/** Secret-free summary of a credential, safe for `/auth list` UIs and structured logs. */
export type RedactedCredential = (
  | { type: "api"; key: string }
  | { type: "oauth"; accountId?: string; expires: number }
  | { type: "wellknown" }
  | { type: "evidence-storage"; enabled: boolean }
) & { account?: ProviderAccount };

/** Reduces a credential to a display-safe summary. Never returns raw secrets. */
export function redactCredential(credential: ProviderCredential): RedactedCredential {
  const account =
    "account" in credential && credential.account !== undefined ? { account: credential.account } : {};
  switch (credential.type) {
    case "evidence-storage":
      return { type: "evidence-storage", enabled: credential.enabled };
    case "api":
      return { type: "api", key: `${credential.key.slice(0, 4)}…`, ...account };
    case "oauth":
      return credential.accountId === undefined
        ? { type: "oauth", expires: credential.expires, ...account }
        : { type: "oauth", accountId: credential.accountId, expires: credential.expires, ...account };
    case "wellknown":
      return { type: "wellknown" };
  }
}

/**
 * Storage for provider credentials keyed by providerId. Every method normalizes the
 * providerId (trim, lowercase, strip trailing "/"), and `list()` only ever returns
 * redacted summaries — callers needing the secret must `get()` a specific provider.
 */
export type CredentialGroup = Record<string, ProviderCredential | undefined>;

export interface CredentialStoreHealth {
  state: "ready" | "locked" | "unavailable";
  message?: string;
  retryAt?: string;
}

export class KeychainLockedError extends Error {
  constructor(
    message = "Keychain locked: unlock it in Keychain Access; Clankie will retry without opening password dialogs.",
  ) {
    super(message);
    this.name = "KeychainLockedError";
  }
}

/**
 * On a Mac without Apple's Command Line Tools, `/usr/bin/python3` is only their
 * installer stub, so the lock check cannot run. Like a locked keychain, the
 * refusal comes before `security` runs and nothing changes.
 */
export class CommandLineToolsMissingError extends KeychainLockedError {
  constructor() {
    super(
      "Apple's Command Line Tools are missing, so Clankie can't check the Keychain: run `xcode-select --install`, then retry.",
    );
    this.name = "CommandLineToolsMissingError";
  }
}

export interface CredentialStore {
  health?(): CredentialStoreHealth;
  observeHealth?(listener: (health: CredentialStoreHealth) => void): () => void;
  get(providerId: string): Promise<ProviderCredential | undefined>;
  set(providerId: string, credential: ProviderCredential): Promise<void>;
  /** Revoke the exact current credential under the mutation lock before deleting it; callback must not call this store again. */
  delete(providerId: string, beforeDelete?: (current: ProviderCredential) => Promise<void>): Promise<boolean>;
  list(): Promise<Record<string, RedactedCredential>>;
  /** One broker lock for related Google grants. Callbacks must not call this store. */
  updateMany?(
    providerIds: readonly string[],
    transform: (current: CredentialGroup) => Promise<CredentialGroup>,
  ): Promise<CredentialGroup>;
  /**
   * Transform an existing entry under the same cross-process lock as set/delete.
   * Missing entries stay missing. The callback must not call this store again.
   * Stores without this capability cannot refresh provider credentials safely.
   */
  update?(
    providerId: string,
    transform: (current: ProviderCredential) => Promise<ProviderCredential>,
  ): Promise<ProviderCredential | undefined>;
}

/** Normalizes a providerId: trim, lowercase, strip trailing "/". Throws when empty. */
export function normalizeProviderId(providerId: string): string {
  const normalized = providerId.trim().toLowerCase().replace(/\/+$/, "");
  if (normalized.length === 0) throw new Error("providerId must be non-empty after normalization");
  return normalized;
}

/** An entry in the credential file that failed schema validation and was skipped on read. */
export interface CredentialLoadIssue {
  providerId: string;
  message: string;
}

const operationQueues = new Map<string, Promise<unknown>>();

function enqueueSerialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationQueues.get(key) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  operationQueues.set(key, settled);
  void settled.finally(() => {
    if (operationQueues.get(key) === settled) operationQueues.delete(key);
  });
  return result;
}

/** Serializes the CLI and service as well as separate instances in one process. */
function withCredentialLock<T>(path: string, operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
  // ponytail: one lock per store also serializes unrelated provider writes.
  // Use provider locks plus an index lock if measured contention warrants it.
  return enqueueSerialized(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(path, {
      realpath: false,
      stale: 60_000,
      update: 10_000,
      retries: { retries: 12, minTimeout: 25, maxTimeout: 5_000 },
      onCompromised: (error) => {
        compromised = error;
      },
    });
    const assertHeld = () => {
      if (compromised !== undefined) throw compromised;
    };
    try {
      const result = await operation(assertHeld);
      assertHeld();
      return result;
    } finally {
      await release();
    }
  });
}

/**
 * Fallback store: a single JSON file (`Record<providerId, ProviderCredential>`) with
 * 0600 permissions inside a 0700 parent directory. Writes are atomic (temp file +
 * rename). A corrupt file is a hard error — it is never silently overwritten — while
 * individual invalid entries are skipped on read and surfaced via `loadIssues()`.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;

  public constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  public async get(providerId: string): Promise<ProviderCredential | undefined> {
    const { credentials } = await this.load();
    return credentials[normalizeProviderId(providerId)];
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    const id = normalizeProviderId(providerId);
    const parsed = ProviderCredentialSchema.parse(credential);
    return this.enqueue(async (assertHeld) => {
      const { credentials } = await this.load();
      credentials[id] = parsed;
      assertHeld();
      await this.persist(credentials);
    });
  }

  public delete(
    providerId: string,
    beforeDelete?: (current: ProviderCredential) => Promise<void>,
  ): Promise<boolean> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async (assertHeld) => {
      const { credentials } = await this.load();
      const current = credentials[id];
      if (current === undefined) return false;
      await beforeDelete?.(current);
      assertHeld();
      delete credentials[id];
      assertHeld();
      await this.persist(credentials);
      return true;
    });
  }

  public update(
    providerId: string,
    transform: (current: ProviderCredential) => Promise<ProviderCredential>,
  ): Promise<ProviderCredential | undefined> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async (assertHeld) => {
      const { credentials } = await this.load();
      const current = credentials[id];
      if (current === undefined) return undefined;
      const transformed = await transform(current);
      const next = ProviderCredentialSchema.parse(transformed);
      assertHeld();
      if (transformed === current) return next;
      credentials[id] = next;
      await this.persist(credentials);
      return next;
    });
  }

  public updateMany(
    providerIds: readonly string[],
    transform: (current: CredentialGroup) => Promise<CredentialGroup>,
  ): Promise<CredentialGroup> {
    const ids = [...new Set(providerIds.map(normalizeProviderId))];
    return this.enqueue(async (assertHeld) => {
      const { credentials } = await this.load();
      const next = await transform(Object.fromEntries(ids.map((id) => [id, credentials[id]])));
      let changed = false;
      for (const id of ids) {
        const value = next[id];
        if (value === credentials[id]) continue;
        changed = true;
        if (value === undefined) delete credentials[id];
        else credentials[id] = ProviderCredentialSchema.parse(value);
      }
      assertHeld();
      if (changed) await this.persist(credentials);
      return Object.fromEntries(ids.map((id) => [id, credentials[id]]));
    });
  }

  public async list(): Promise<Record<string, RedactedCredential>> {
    const { credentials } = await this.load();
    return Object.fromEntries(
      Object.entries(credentials)
        .filter(([id, credential]) => id !== "google-oauth-app" && credential.type !== "evidence-storage")
        .map(([id, credential]) => [id, redactCredential(credential)]),
    );
  }

  /** Re-reads the file and reports entries that failed validation (skipped by get/list). */
  public async loadIssues(): Promise<CredentialLoadIssue[]> {
    return (await this.load()).issues;
  }

  private enqueue<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
    return withCredentialLock(this.filePath, operation);
  }

  private async load(): Promise<{
    credentials: Record<string, ProviderCredential>;
    issues: CredentialLoadIssue[];
  }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { credentials: {}, issues: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Credential file ${this.filePath} contains invalid JSON; refusing to touch it. ` +
          `Repair or remove the file manually. (${String(error)})`,
      );
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Credential file ${this.filePath} must contain a JSON object keyed by providerId`);
    }
    const credentials: Record<string, ProviderCredential> = {};
    const issues: CredentialLoadIssue[] = [];
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const result = ProviderCredentialSchema.safeParse(value);
      if (!result.success) {
        issues.push({
          providerId: id,
          message: result.error.issues.map((issue) => issue.message).join("; "),
        });
        continue;
      }
      try {
        credentials[normalizeProviderId(id)] = result.data;
      } catch (error) {
        issues.push({ providerId: id, message: String(error) });
      }
    }
    return { credentials, issues };
  }

  private async persist(credentials: Record<string, ProviderCredential>): Promise<void> {
    const parentDirectory = dirname(this.filePath);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    await chmod(parentDirectory, 0o700);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(credentials, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

function keychainHelperPath(): string {
  for (const root of [import.meta.dirname, process.argv[1] ? dirname(resolve(process.argv[1])) : undefined]) {
    if (!root) continue;
    let ancestor = root;
    for (let depth = 0; depth < 8; depth++) {
      const path = join(ancestor, "packages/credential-broker/src/keychain-status.py");
      if (existsSync(path)) return path;
      const next = dirname(ancestor);
      if (next === ancestor) break;
      ancestor = next;
    }
  }
  throw new Error("Keychain status helper is missing; repair this Clankie install");
}

type KeychainCommandObserver = (event: {
  command: "lock-check" | "read" | "write";
  phase: "start" | "exit";
  pid: number;
}) => void;

async function assertKeychainUnlocked(keychain?: string, observe?: KeychainCommandObserver): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFileCallback(
      "/usr/bin/python3",
      [keychainHelperPath()],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (child.pid) observe?.({ command: "lock-check", phase: "exit", pid: child.pid });
        let result: { code?: number; path?: string };
        try {
          result = JSON.parse(stdout);
        } catch {
          execFileCallback("/usr/bin/xcode-select", ["-p"], { timeout: 3_000 }, (missing) =>
            reject(
              missing
                ? new CommandLineToolsMissingError()
                : new Error("Keychain read unavailable (native helper failed or timed out)"),
            ),
          );
          return;
        }
        if (result.code === -25308 || result.code === -25293) {
          reject(new KeychainLockedError());
          return;
        }
        if (error || result.code) {
          reject(new Error("Keychain read unavailable (native Keychain error)"));
          return;
        }
        if (!result.path) {
          reject(new Error("Keychain path unavailable"));
          return;
        }
        resolve(result.path);
      },
    );
    if (child.pid) observe?.({ command: "lock-check", phase: "start", pid: child.pid });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ keychain }));
  });
}

async function defaultExecFile(
  file: string,
  args: string[],
  keychain?: string,
  observe?: KeychainCommandObserver,
): Promise<{ stdout: string; stderr: string }> {
  // One bounded security command at a time across CLI/service processes.
  // This is separate from the OAuth mutation lock, which may span network I/O.
  const path = join(homedir(), ".config", "clankie", "credential-locks", "keychain-io");
  // A locked CLI must not wait behind another process's I/O lock.
  let actualKeychain = await enqueueSerialized(`${path}:checks`, () =>
    assertKeychainUnlocked(keychain, observe),
  );
  const checkedAt = Date.now();
  return withCredentialLock(path, async () => {
    if (Date.now() - checkedAt > 100) actualKeychain = await assertKeychainUnlocked(actualKeychain, observe);
    // Existing Keychain ACLs continue to recognize security(1). A native,
    // noninteractive lock check prevents it from opening unlock dialogs. The
    // deadline bounds the race where the owner locks the keychain after the check.
    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        const command = args[0] === "find-generic-password" ? "read" : "write";
        const child = execFileCallback(
          file,
          [...args, actualKeychain],
          { timeout: 3_000 },
          (error, stdout, stderr) => {
            if (child.pid) observe?.({ command, phase: "exit", pid: child.pid });
            if (error) reject(error);
            else resolve({ stdout, stderr });
          },
        );
        if (child.pid) observe?.({ command, phase: "start", pid: child.pid });
      });
      return { stdout, stderr };
    } catch (error) {
      if (isKeychainNotFound(error)) throw new Error("Keychain item could not be found");
      throw new Error("Keychain operation unavailable (locked, denied, or timed out)");
    }
  });
}

interface KeychainReadState {
  revisions: Map<string, string>;
  values: Map<string, string | undefined>;
  reads: Map<string, Promise<string | undefined>>;
  failure?: { error: Error; until: number };
  health: CredentialStoreHealth;
  listeners: Set<(health: CredentialStoreHealth) => void>;
}
const keychainStates = new WeakMap<object, Map<string, KeychainReadState>>();

/** Account name that holds the JSON array of providerIds, so list() never dumps the keychain. */
const INDEX_ACCOUNT = "__index__";
const SECURITY_CLI = "/usr/bin/security";

export interface KeychainCredentialStoreOptions {
  /** Keychain service name; defaults to "bot.clankie.credentials". */
  service?: string;
  /** Explicit keychain path, for isolated native proofs; never changes the OS search list. */
  keychain?: string;
  /** Fixed process metadata for native evidence; never includes argv or secrets. */
  observeCommand?: KeychainCommandObserver;
  /** Injectable command runner so tests never touch the real keychain. */
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * macOS Keychain store backed by the `security` CLI. One generic password per provider
 * (service = options.service, account = providerId, password = credential JSON), plus an
 * index item under account "__index__" listing known providerIds.
 *
 * Secrets are always passed as `execFile` argv values — never interpolated into a shell
 * string — so they cannot be injected or expanded. The `-w <json>` argv is briefly visible
 * to `ps` on the local machine while `security` runs; this tradeoff is accepted because the
 * alternative (piping via stdin) is not supported by `add-generic-password` non-interactively.
 */
export class KeychainCredentialStore implements CredentialStore {
  private readonly service: string;
  private readonly state: KeychainReadState;
  private readonly revisionPath: string;
  private readonly lockPath: string;
  private readonly execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  public constructor(options: KeychainCredentialStoreOptions = {}) {
    this.service = options.service ?? "bot.clankie.credentials";
    this.lockPath = join(
      homedir(),
      ".config",
      "clankie",
      "credential-locks",
      createHash("sha256")
        .update(options.keychain ? `${this.service}:${options.keychain}` : this.service)
        .digest("hex"),
    );
    this.revisionPath = `${this.lockPath}.revision`;
    const runner = options.execFile ?? defaultExecFile;
    let states = keychainStates.get(runner);
    if (!states) {
      states = new Map();
      keychainStates.set(runner, states);
    }
    const key = `${this.lockPath}:${options.keychain ?? "default"}`;
    let state = states.get(key);
    if (!state) {
      state = {
        values: new Map(),
        revisions: new Map(),
        reads: new Map(),
        health: { state: "ready" },
        listeners: new Set(),
      };
      states.set(key, state);
    }
    this.state = state;
    this.execFile =
      options.execFile ??
      ((file, args) => defaultExecFile(file, args, options.keychain, options.observeCommand));
  }

  public get(providerId: string): Promise<ProviderCredential | undefined> {
    const id = normalizeProviderId(providerId);
    // Keychain reads one atomically published item. Do not wait behind an
    // unrelated provider's OAuth network refresh holding the store write lock.
    // Index reads and all read-modify-write operations remain serialized.
    return this.getDirect(id);
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    const id = normalizeProviderId(providerId);
    const parsed = ProviderCredentialSchema.parse(credential);
    return this.enqueue((assertHeld) => this.setDirect(id, parsed, assertHeld));
  }

  public update(
    providerId: string,
    transform: (current: ProviderCredential) => Promise<ProviderCredential>,
  ): Promise<ProviderCredential | undefined> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async (assertHeld) => {
      const current = await this.getDirect(id, true);
      if (current === undefined) return undefined;
      const transformed = await transform(current);
      const next = ProviderCredentialSchema.parse(transformed);
      assertHeld();
      if (transformed === current) return next;
      await this.setDirect(id, next, assertHeld);
      return next;
    });
  }

  public updateMany(
    providerIds: readonly string[],
    transform: (current: CredentialGroup) => Promise<CredentialGroup>,
  ): Promise<CredentialGroup> {
    const ids = [...new Set(providerIds.map(normalizeProviderId))];
    return this.enqueue(async (assertHeld) => {
      const current: CredentialGroup = {};
      for (const id of ids) current[id] = await this.getDirect(id, true);
      const previous = { ...current };
      const next = await transform(current);
      // Validate the entire group before the first Keychain publication.
      for (const id of ids) if (next[id] !== undefined) ProviderCredentialSchema.parse(next[id]);
      // All Google consumers resolve under this same lock. Disable/revoke is
      // published before another consumer can refresh any sibling capability.
      for (const id of ids) {
        assertHeld();
        const value = next[id];
        if (value === previous[id]) continue;
        if (value === undefined) {
          if (previous[id] !== undefined) {
            await this.deleteDirect(id);
            const index = await this.readIndex(true);
            await this.writeIndex(index.filter((entry) => entry !== id));
          }
        } else await this.setDirect(id, ProviderCredentialSchema.parse(value), assertHeld);
      }
      return next;
    });
  }

  private async setDirect(id: string, parsed: ProviderCredential, assertHeld: () => void): Promise<void> {
    const previous = await this.read(id, true);
    const index = await this.readIndex(true);
    const indexChanged = !index.includes(id);
    try {
      // Publish the index before creating a new secret. If the index write
      // fails, no unindexed credential can be orphaned in the Keychain.
      assertHeld();
      if (indexChanged) await this.writeIndex([...index, id].sort());
      assertHeld();
      await this.write(id, JSON.stringify(parsed));
    } catch (error) {
      if (error instanceof KeychainLockedError) throw error;
      assertHeld();
      if (indexChanged) await this.writeIndex(index).catch(() => undefined);
      assertHeld();
      await this.restore(id, previous).catch(() => undefined);
      throw error;
    }
  }

  public delete(
    providerId: string,
    beforeDelete?: (current: ProviderCredential) => Promise<void>,
  ): Promise<boolean> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async (assertHeld) => {
      const previous = await this.read(id, true);
      if (previous === undefined) return false;
      if (beforeDelete) await beforeDelete(ProviderCredentialSchema.parse(JSON.parse(previous)));
      assertHeld();
      const index = await this.readIndex(true);
      assertHeld();
      if (!(await this.deleteDirect(id))) return false;
      // A failed index update leaves only a stale index entry: list() skips the
      // missing item, and a future mutation repairs the index. Restoring the
      // secret here would be a more dangerous partial-failure state.
      assertHeld();
      if (index.includes(id)) await this.writeIndex(index.filter((entry) => entry !== id));
      return true;
    });
  }

  public list(): Promise<Record<string, RedactedCredential>> {
    return enqueueSerialized(`${this.lockPath}:list`, async () => {
      const redacted: Record<string, RedactedCredential> = {};
      for (const id of await this.readIndex()) {
        if (id === "google-oauth-app") continue;
        try {
          const credential = await this.getDirect(id);
          if (credential !== undefined && credential.type !== "evidence-storage")
            redacted[id] = redactCredential(credential);
        } catch (error) {
          if (this.state.failure) throw error;
          // A missing or malformed entry must not break listing the rest.
        }
      }
      return redacted;
    });
  }

  public health(): CredentialStoreHealth {
    return { ...this.state.health };
  }

  public observeHealth(listener: (health: CredentialStoreHealth) => void): () => void {
    this.state.listeners.add(listener);
    listener(this.health());
    return () => {
      this.state.listeners.delete(listener);
    };
  }

  private reportHealth(health: CredentialStoreHealth): void {
    const changed = this.state.health.state !== health.state;
    this.state.health = health;
    if (changed)
      for (const listener of this.state.listeners) {
        try {
          listener({ ...health });
        } catch {
          /* Diagnostics never break credential operations. */
        }
      }
  }

  private enqueue<T>(operation: (assertHeld: () => void) => Promise<T>): Promise<T> {
    // Reads validate their account's publication witness after taking this lock;
    // unchanged cached entries remain authoritative, including no-op OAuth checks.
    return withCredentialLock(this.lockPath, operation);
  }

  private accountRevisionPath(account: string): string {
    return `${this.revisionPath}.${createHash("sha256").update(account).digest("hex")}`;
  }

  private async published(account: string): Promise<void> {
    // Secret-free witness, published under the cross-process mutation lock.
    // Fail closed if a writer cannot tell other processes about a change.
    const revision = randomUUID();
    const path = this.accountRevisionPath(account);
    const temporary = `${path}.${process.pid}.tmp`;
    this.state.values.delete(account);
    await writeFile(temporary, revision, { mode: 0o600 });
    await rename(temporary, path);
    this.state.revisions.set(account, revision);
  }

  private async getDirect(id: string, durable = false): Promise<ProviderCredential | undefined> {
    const raw = await this.read(id, durable);
    if (raw === undefined) return undefined;
    return ProviderCredentialSchema.parse(JSON.parse(raw));
  }

  private async read(account: string, durable = false): Promise<string | undefined> {
    let revision: string;
    try {
      revision = await readFile(this.accountRevisionPath(account), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      revision = "absent";
    }
    if (revision !== this.state.revisions.get(account)) {
      this.state.values.delete(account);
      this.state.revisions.set(account, revision);
    }
    if (revision.startsWith("pending:") && !durable)
      throw new Error("Credential change in progress; retry shortly");
    if (this.state.values.has(account)) return this.state.values.get(account);
    if (this.state.failure && Date.now() < this.state.failure.until) throw this.state.failure.error;
    const readKey = `${revision}:${account}`;
    const pending = this.state.reads.get(readKey);
    if (pending) return pending;
    const read = enqueueSerialized(`${this.lockPath}:reads`, async () => {
      if (this.state.failure && Date.now() < this.state.failure.until) throw this.state.failure.error;
      try {
        let value: string | undefined;
        try {
          const { stdout } = await this.execFile(SECURITY_CLI, [
            "find-generic-password",
            "-s",
            this.service,
            "-a",
            account,
            "-w",
          ]);
          value = stdout.replace(/\r?\n$/, "");
        } catch (error) {
          if (!isKeychainNotFound(error)) throw error;
        }
        // An overlapping mutation invalidates this read's cache publication.
        if (this.state.revisions.get(account) === revision) this.state.values.set(account, value);
        delete this.state.failure;
        this.reportHealth({ state: "ready" });
        return value;
      } catch (error) {
        throw this.rememberFailure(error);
      }
    });
    this.state.reads.set(readKey, read);
    try {
      return await read;
    } finally {
      if (this.state.reads.get(readKey) === read) this.state.reads.delete(readKey);
    }
  }

  private async changing(account: string): Promise<void> {
    const path = this.accountRevisionPath(account);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `pending:${randomUUID()}`, { mode: 0o600 });
    await rename(temporary, path);
    this.state.values.delete(account);
  }

  private rememberFailure(error: unknown): Error {
    const failure =
      error instanceof KeychainLockedError
        ? error
        : new Error("Keychain unavailable; retrying in 30 seconds");
    const until = Date.now() + 30_000;
    this.state.failure = { error: failure, until };
    this.reportHealth({
      state:
        error instanceof KeychainLockedError && !(error instanceof CommandLineToolsMissingError)
          ? "locked"
          : "unavailable",
      message: failure.message,
      retryAt: new Date(until).toISOString(),
    });
    return failure;
  }

  private async command(account: string, args: string[]): Promise<void> {
    if (this.state.failure && Date.now() < this.state.failure.until) throw this.state.failure.error;
    const revision = this.state.revisions.get(account) ?? "absent";
    const cached = this.state.values.has(account);
    const previous = this.state.values.get(account);
    await this.changing(account);
    try {
      await this.execFile(SECURITY_CLI, args);
    } catch (error) {
      if (error instanceof KeychainLockedError) {
        // The native preflight refused before spawning security: no item changed.
        // Restore that exact witness and cache instead of leaving a permanent hold.
        const path = this.accountRevisionPath(account);
        const temporary = `${path}.${process.pid}.tmp`;
        await writeFile(temporary, revision, { mode: 0o600 });
        await rename(temporary, path);
        this.state.revisions.set(account, revision);
        if (cached) this.state.values.set(account, previous);
        throw this.rememberFailure(error);
      }
      // A timed-out command may have published. Invalidate cached authorization
      // and let the next read observe the durable truth, never a stuck pending marker.
      await this.published(account);
      throw error;
    }
    await this.published(account);
  }

  private async write(account: string, secret: string): Promise<void> {
    // -U updates an existing item in place instead of failing with "already exists".
    await this.command(account, [
      "add-generic-password",
      "-U",
      "-s",
      this.service,
      "-a",
      account,
      "-w",
      secret,
    ]);
  }

  private async deleteDirect(account: string): Promise<boolean> {
    try {
      await this.command(account, ["delete-generic-password", "-s", this.service, "-a", account]);
      return true;
    } catch (error) {
      if (isKeychainNotFound(error)) return false;
      throw error;
    }
  }

  private async restore(account: string, previous: string | undefined): Promise<void> {
    if (previous === undefined) {
      await this.deleteDirect(account);
      return;
    }
    await this.write(account, previous);
  }

  private async readIndex(durable = false): Promise<string[]> {
    const raw = await this.read(INDEX_ACCOUNT, durable);
    if (raw === undefined) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("index is not an array");
      if (parsed.some((entry) => typeof entry !== "string")) {
        throw new Error("index contains a non-string providerId");
      }
      return parsed;
    } catch (error) {
      throw new Error(`Keychain credential index is malformed: ${String(error)}`);
    }
  }

  private async writeIndex(ids: string[]): Promise<void> {
    await this.write(INDEX_ACCOUNT, JSON.stringify(ids));
  }
}

function isKeychainNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("could not be found")) return true;
  const stderr = (error as Error & { stderr?: unknown }).stderr;
  return typeof stderr === "string" && stderr.includes("could not be found");
}

export interface DefaultCredentialStoreOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

/**
 * Picks the platform-appropriate store: the macOS Keychain on darwin, otherwise a 0600
 * JSON file at `${XDG_CONFIG_HOME ?? ~/.config}/clankie/credentials.json`. Setting
 * `CLANKIE_CREDENTIALS_FILE` always forces the file backend at that path (tests/CI).
 */
export function createDefaultCredentialStore(options: DefaultCredentialStoreOptions = {}): CredentialStore {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const override = env.CLANKIE_CREDENTIALS_FILE;
  if (override !== undefined && override.length > 0) return new FileCredentialStore(override);
  if (platform === "darwin") return new KeychainCredentialStore();
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return new FileCredentialStore(join(configHome, "clankie", "credentials.json"));
}
