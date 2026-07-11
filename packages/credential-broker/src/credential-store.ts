import { randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

/**
 * Typed at-rest credentials for LLM providers.
 *
 * - `api`: a long-lived API key, plus optional non-secret metadata.
 * - `oauth`: an access/refresh token pair. `expires` is epoch milliseconds; 0 means no expiry.
 * - `wellknown`: a key/token pair for providers that authenticate with both.
 */
export const ProviderCredentialSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("api"),
    key: z.string().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    type: z.literal("oauth"),
    access: z.string(),
    refresh: z.string(),
    expires: z.number().int().nonnegative(),
    accountId: z.string().optional(),
  }),
  z.object({
    type: z.literal("wellknown"),
    key: z.string(),
    token: z.string(),
  }),
]);
export type ProviderCredential = z.infer<typeof ProviderCredentialSchema>;

/** Secret-free summary of a credential, safe for `/auth list` UIs and structured logs. */
export type RedactedCredential =
  | { type: "api"; key: string }
  | { type: "oauth"; accountId?: string; expires: number }
  | { type: "wellknown" };

/** Reduces a credential to a display-safe summary. Never returns raw secrets. */
export function redactCredential(credential: ProviderCredential): RedactedCredential {
  switch (credential.type) {
    case "api":
      return { type: "api", key: `${credential.key.slice(0, 4)}…` };
    case "oauth":
      return credential.accountId === undefined
        ? { type: "oauth", expires: credential.expires }
        : { type: "oauth", accountId: credential.accountId, expires: credential.expires };
    case "wellknown":
      return { type: "wellknown" };
  }
}

/**
 * Storage for provider credentials keyed by providerId. Every method normalizes the
 * providerId (trim, lowercase, strip trailing "/"), and `list()` only ever returns
 * redacted summaries — callers needing the secret must `get()` a specific provider.
 */
export interface CredentialStore {
  get(providerId: string): Promise<ProviderCredential | undefined>;
  set(providerId: string, credential: ProviderCredential): Promise<void>;
  delete(providerId: string): Promise<boolean>;
  list(): Promise<Record<string, RedactedCredential>>;
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

/**
 * Fallback store: a single JSON file (`Record<providerId, ProviderCredential>`) with
 * 0600 permissions inside a 0700 parent directory. Writes are atomic (temp file +
 * rename). A corrupt file is a hard error — it is never silently overwritten — while
 * individual invalid entries are skipped on read and surfaced via `loadIssues()`.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly filePath: string;
  private readonly queueKey: string;

  public constructor(filePath: string) {
    this.filePath = filePath;
    this.queueKey = `file:${resolve(filePath)}`;
  }

  public async get(providerId: string): Promise<ProviderCredential | undefined> {
    const { credentials } = await this.load();
    return credentials[normalizeProviderId(providerId)];
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    const id = normalizeProviderId(providerId);
    const parsed = ProviderCredentialSchema.parse(credential);
    return this.enqueue(async () => {
      const { credentials } = await this.load();
      credentials[id] = parsed;
      await this.persist(credentials);
    });
  }

  public delete(providerId: string): Promise<boolean> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async () => {
      const { credentials } = await this.load();
      if (!(id in credentials)) return false;
      delete credentials[id];
      await this.persist(credentials);
      return true;
    });
  }

  public async list(): Promise<Record<string, RedactedCredential>> {
    const { credentials } = await this.load();
    return Object.fromEntries(
      Object.entries(credentials).map(([id, credential]) => [id, redactCredential(credential)]),
    );
  }

  /** Re-reads the file and reports entries that failed validation (skipped by get/list). */
  public async loadIssues(): Promise<CredentialLoadIssue[]> {
    return (await this.load()).issues;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueSerialized(this.queueKey, operation);
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

const execFileAsync = promisify(execFileCallback);

async function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync(file, args);
  return { stdout, stderr };
}

/** Account name that holds the JSON array of providerIds, so list() never dumps the keychain. */
const INDEX_ACCOUNT = "__index__";
const SECURITY_CLI = "/usr/bin/security";

export interface KeychainCredentialStoreOptions {
  /** Keychain service name; defaults to "bot.clankie.credentials". */
  service?: string;
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
  private readonly queueKey: string;
  private readonly execFile: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

  public constructor(options: KeychainCredentialStoreOptions = {}) {
    this.service = options.service ?? "bot.clankie.credentials";
    this.queueKey = `keychain:${this.service}`;
    this.execFile = options.execFile ?? defaultExecFile;
  }

  public get(providerId: string): Promise<ProviderCredential | undefined> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(() => this.getDirect(id));
  }

  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    const id = normalizeProviderId(providerId);
    const parsed = ProviderCredentialSchema.parse(credential);
    return this.enqueue(async () => {
      const previous = await this.read(id);
      const index = await this.readIndex();
      const indexChanged = !index.includes(id);
      try {
        // Publish the index before creating a new secret. If the index write
        // fails, no unindexed credential can be orphaned in the Keychain.
        if (indexChanged) await this.writeIndex([...index, id].sort());
        await this.write(id, JSON.stringify(parsed));
      } catch (error) {
        if (indexChanged) await this.writeIndex(index).catch(() => undefined);
        await this.restore(id, previous).catch(() => undefined);
        throw error;
      }
    });
  }

  public delete(providerId: string): Promise<boolean> {
    const id = normalizeProviderId(providerId);
    return this.enqueue(async () => {
      const previous = await this.read(id);
      if (previous === undefined) return false;
      const index = await this.readIndex();
      if (!(await this.deleteDirect(id))) return false;
      // A failed index update leaves only a stale index entry: list() skips the
      // missing item, and a future mutation repairs the index. Restoring the
      // secret here would be a more dangerous partial-failure state.
      if (index.includes(id)) await this.writeIndex(index.filter((entry) => entry !== id));
      return true;
    });
  }

  public list(): Promise<Record<string, RedactedCredential>> {
    return this.enqueue(async () => {
      const redacted: Record<string, RedactedCredential> = {};
      for (const id of await this.readIndex()) {
        try {
          const credential = await this.getDirect(id);
          if (credential !== undefined) redacted[id] = redactCredential(credential);
        } catch {
          // A missing or malformed entry must not break listing the rest.
        }
      }
      return redacted;
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return enqueueSerialized(this.queueKey, operation);
  }

  private async getDirect(id: string): Promise<ProviderCredential | undefined> {
    const raw = await this.read(id);
    if (raw === undefined) return undefined;
    return ProviderCredentialSchema.parse(JSON.parse(raw));
  }

  private async read(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.execFile(SECURITY_CLI, [
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        account,
        "-w",
      ]);
      return stdout.replace(/\r?\n$/, "");
    } catch (error) {
      if (isKeychainNotFound(error)) return undefined;
      throw error;
    }
  }

  private async write(account: string, secret: string): Promise<void> {
    // -U updates an existing item in place instead of failing with "already exists".
    await this.execFile(SECURITY_CLI, [
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
      await this.execFile(SECURITY_CLI, ["delete-generic-password", "-s", this.service, "-a", account]);
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

  private async readIndex(): Promise<string[]> {
    const raw = await this.read(INDEX_ACCOUNT);
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
