import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  ClankieSettingsSchema,
  assertNoSecretShapedValue,
  emptySettings,
  type ClankieSettings,
} from "./schema.ts";

/**
 * Settings live beside the broker's credential file so an operator has one
 * place to look, with the same 0700/0600 permissions — but in a separate file,
 * because these values are not secrets and are displayed unredacted.
 */
export function defaultSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLANKIE_SETTINGS_FILE;
  if (override !== undefined && override.length > 0) return override;
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "clankie", "settings.json");
}

export class SettingsStore {
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();

  public constructor(filePath: string = defaultSettingsPath()) {
    this.filePath = filePath;
  }

  public get path(): string {
    return this.filePath;
  }

  /** Read settings, returning defaults when the file is absent. */
  public async load(): Promise<ClankieSettings> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch {
      return emptySettings();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`settings_file_invalid_json: ${this.filePath}`);
    }
    // A malformed settings file fails loudly rather than silently reverting to
    // defaults, which would quietly widen an allowlist the operator narrowed.
    return ClankieSettingsSchema.parse(parsed);
  }

  /** Apply a transform atomically under a serialized queue. */
  public update(mutate: (current: ClankieSettings) => ClankieSettings): Promise<ClankieSettings> {
    const run = async (): Promise<ClankieSettings> => {
      const current = await this.load();
      const next = ClankieSettingsSchema.parse(mutate(current));
      assertNoSecretShapedValue(next);
      await this.persist(next);
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(settings: ClankieSettings): Promise<void> {
    const parentDirectory = dirname(this.filePath);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    await chmod(parentDirectory, 0o700);
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}
