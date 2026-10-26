/**
 * Clankie's protected keychain (VUH-2592): a keychain file outside the login
 * keychain and its search list, holding the operator credential. Hired workers run
 * under a Seatbelt profile that denies reading this file, so a same-user worker
 * shell cannot read what it holds; the owner's own processes can.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  KeychainCredentialStore,
  KeychainLockedError,
  type CredentialStore,
  type ProviderCredential,
} from "./credential-store.ts";

const PASSWORD_SERVICE = "bot.clankie.keychain";
const PASSWORD_ACCOUNT = "clankie";

/** The protected keychain file; `CLANKIE_PROTECTED_KEYCHAIN` relocates it for isolated proofs. */
export function protectedKeychainPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLANKIE_PROTECTED_KEYCHAIN?.trim();
  return override ? resolve(override) : join(homedir(), "Library", "Keychains", "clankie.keychain-db");
}

interface ProtectedKeychainOptions {
  readonly env?: NodeJS.ProcessEnv;
}

function helperPath(): string {
  for (let ancestor = import.meta.dirname, depth = 0; depth < 8; depth++) {
    const path = join(ancestor, "packages/credential-broker/src/protected-keychain.py");
    if (existsSync(path)) return path;
    const local = join(ancestor, "protected-keychain.py");
    if (existsSync(local)) return local;
    const next = dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  throw new Error("Protected keychain helper is missing; repair this Clankie install");
}

/** Runs one helper operation. The request travels on stdin; output is fixed metadata only. */
function helper(op: "ensure" | "unlock", options: ProtectedKeychainOptions): Promise<{ created?: boolean }> {
  const env = options.env ?? process.env;
  // `CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS` keeps an isolated proof's unlock password
  // out of the owner's login keychain.
  const passwordKeychain = env.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS?.trim();
  const request = {
    op,
    keychain: protectedKeychainPath(env),
    ...(passwordKeychain ? { passwordKeychain: resolve(passwordKeychain) } : {}),
    service: PASSWORD_SERVICE,
    account: PASSWORD_ACCOUNT,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(
      "/usr/bin/python3",
      [helperPath()],
      { timeout: 5_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        let result: { ready?: boolean; created?: boolean; code?: number };
        try {
          result = JSON.parse(stdout);
        } catch {
          reject(new Error("Protected keychain unavailable (native helper failed or timed out)"));
          return;
        }
        if (result.code === -25308 || result.code === -25293) reject(new KeychainLockedError());
        else if (error || !result.ready)
          reject(
            new Error(`Protected keychain unavailable (native Keychain error ${result.code ?? "unknown"})`),
          );
        else resolve(result);
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(request));
  });
}

/** Creates the protected keychain and its unlock password once; an existing file is kept. */
export async function ensureProtectedKeychain(options: ProtectedKeychainOptions = {}): Promise<boolean> {
  return (await helper("ensure", options)).created === true;
}

/** Whether this machine has a protected keychain to read from. */
export function hasProtectedKeychain(env: NodeJS.ProcessEnv = process.env): boolean {
  return process.platform === "darwin" && existsSync(protectedKeychainPath(env));
}

/**
 * The broker store over the protected keychain. After a reboot the file is locked;
 * the store unlocks it with its own password once per process, before the first
 * read, so the underlying store never caches a locked failure.
 */
export class ProtectedKeychainStore implements CredentialStore {
  private readonly store: KeychainCredentialStore;
  private readonly options: ProtectedKeychainOptions;
  private ready: Promise<unknown> | undefined;

  constructor(options: ProtectedKeychainOptions = {}) {
    this.options = options;
    this.store = new KeychainCredentialStore({ keychain: protectedKeychainPath(options.env) });
  }

  private async unlocked<T>(action: () => Promise<T>): Promise<T> {
    this.ready ??= helper("unlock", this.options).catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
    return action();
  }

  get(providerId: string) {
    return this.unlocked(() => this.store.get(providerId));
  }
  set(providerId: string, credential: ProviderCredential) {
    return this.unlocked(() => this.store.set(providerId, credential));
  }
  delete(providerId: string, beforeDelete?: (current: ProviderCredential) => Promise<void>) {
    return this.unlocked(() => this.store.delete(providerId, beforeDelete));
  }
  list() {
    return this.unlocked(() => this.store.list());
  }
}
