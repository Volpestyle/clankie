import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema — deliberately lenient (looseObject) so configs written by newer
// clankie versions still load. The one hard rule: secrets never live in
// config files; they belong to the credential broker.
// ---------------------------------------------------------------------------

/** Matches authorization, API-key, token, and secret fields in any casing/style. */
function isSecretOptionKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const normalized = words.join("");
  return (
    words.includes("authorization") ||
    normalized.endsWith("apikey") ||
    words.includes("token") ||
    words.includes("secret")
  );
}

function rejectSecretOptionKeys(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectSecretOptionKeys(entry, ctx, [...path, index]));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = [...path, key];
    if (!isSecretOptionKey(key)) {
      rejectSecretOptionKeys(entry, ctx, entryPath);
      continue;
    }
    ctx.addIssue({
      code: "custom",
      path: entryPath,
      message:
        `Secrets never live in config files. Remove provider option "${key}" and run \`/auth\` ` +
        `to store the credential in the credential broker (@clankie/credential-broker) instead.`,
    });
  }
}

const ProviderOptionsSchema = z.record(z.string(), z.unknown()).superRefine((options, ctx) => {
  rejectSecretOptionKeys(options, ctx);
});

export const ProviderConfigSchema = z.looseObject({
  /** Display name override for this provider. */
  name: z.string().optional(),
  /** AI SDK package that speaks this provider's protocol, e.g. "@ai-sdk/openai-compatible". */
  npm: z.string().optional(),
  /** Environment variables that can hold this provider's API key. */
  env: z.array(z.string()).optional(),
  /** Non-secret provider options (baseURL, timeouts, …). Secret-shaped keys are rejected. */
  options: ProviderOptionsSchema.optional(),
  /** Partial ModelEntry overlays keyed by model id; merged into the catalog via applyCustomProviders. */
  models: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ClankieConfigSchema = z.looseObject({
  /** Primary model as a "providerId/modelId" ref. */
  model: z.string().optional(),
  /** Cheap/fast model for auxiliary tasks, as a "providerId/modelId" ref. */
  small_model: z.string().optional(),
  /** Voice pipeline model, as a "providerId/modelId" ref. */
  voice_model: z.string().optional(),
  /** Selected variant per model ref, e.g. { "anthropic/claude-opus-4-5": "think-16k" }. */
  variant: z.record(z.string(), z.string()).optional(),
  /** When non-empty, ONLY these providers are enabled. */
  enabled_providers: z.array(z.string()).optional(),
  /** Providers to drop even when otherwise available. */
  disabled_providers: z.array(z.string()).optional(),
  /** Custom provider declarations and catalog overrides, keyed by provider id. */
  provider: z.record(z.string(), ProviderConfigSchema).optional(),
});
export type ClankieConfig = z.infer<typeof ClankieConfigSchema>;

// ---------------------------------------------------------------------------
// Config file locations
// ---------------------------------------------------------------------------

/** Global config file: `${XDG_CONFIG_HOME ?? ~/.config}/clankie/clankie.json`. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configHome =
    env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(configHome, "clankie", "clankie.json");
}

/** Nearest `.clankie.json` walking up from `cwd` to the filesystem root. */
export function findRepoConfigPath(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, ".clankie.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Loading — never throws. A file that fails to parse or validate becomes an
// issue and is skipped; missing files are simply absent.
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  path: string;
  message: string;
}

export interface LoadConfigResult {
  config: ClankieConfig;
  /** Files that loaded successfully, in merge order (global first, repo last). */
  sources: string[];
  issues: ConfigIssue[];
}

export interface LoadConfigOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Reads the global config then the nearest repo config and deep-merges repo
 * over global: objects merge per key, arrays and scalars replace.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadConfigResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const paths = [globalConfigPath(env)];
  const repoPath = findRepoConfigPath(cwd);
  if (repoPath !== undefined && !paths.includes(repoPath)) paths.push(repoPath);

  const sources: string[] = [];
  const issues: ConfigIssue[] = [];
  let config: ClankieConfig = {};
  for (const path of paths) {
    const layer = await readConfigLayer(path, issues);
    if (layer === undefined) continue;
    sources.push(path);
    config = mergeConfigLayers(config, layer);
  }
  return { config, sources, issues };
}

async function readConfigLayer(path: string, issues: ConfigIssue[]): Promise<ClankieConfig | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      issues.push({ path, message: String(error) });
    }
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    issues.push({ path, message: `Invalid JSON: ${String(error)}` });
    return undefined;
  }
  const result = ClankieConfigSchema.safeParse(parsed);
  if (!result.success) {
    issues.push({
      path,
      message: result.error.issues
        .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; "),
    });
    return undefined;
  }
  return result.data;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: objects merge recursively; arrays and scalars in `patch` replace `base`. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

function mergeConfigLayers(base: ClankieConfig, patch: ClankieConfig): ClankieConfig {
  return ClankieConfigSchema.parse(deepMerge(base, patch));
}

// ---------------------------------------------------------------------------
// Updating — global config only, serialized and atomic.
// ---------------------------------------------------------------------------

export interface UpdateGlobalConfigOptions {
  env?: NodeJS.ProcessEnv;
}

let updateQueue: Promise<unknown> = Promise.resolve();

/**
 * Loads the global config, applies `mutate` (the mutator may edit the draft
 * in place or return a replacement), validates the result, and writes it
 * atomically (temp file + rename, directories created, pretty JSON).
 * Concurrent updates within this process are serialized through a queue, so
 * both of two racing updates land. A global config file with invalid JSON or
 * a failing schema is a hard error — it is never silently overwritten.
 */
export function updateGlobalConfig(
  mutate: (config: ClankieConfig) => ClankieConfig | void,
  options: UpdateGlobalConfigOptions = {},
): Promise<ClankieConfig> {
  const run = async (): Promise<ClankieConfig> => {
    const path = globalConfigPath(options.env ?? process.env);
    const current = await readGlobalForUpdate(path);
    const draft = structuredClone(current);
    const next = ClankieConfigSchema.parse(mutate(draft) ?? draft);
    await mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, path);
    return next;
  };
  const result = updateQueue.then(run);
  updateQueue = result.catch(() => undefined);
  return result;
}

async function readGlobalForUpdate(path: string): Promise<ClankieConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Global config ${path} contains invalid JSON; refusing to overwrite it. ` +
        `Repair or remove the file manually. (${String(error)})`,
    );
  }
  return ClankieConfigSchema.parse(parsed);
}

// ---------------------------------------------------------------------------
// Model refs — "providerId/modelId", split on the FIRST slash because model
// ids may themselves contain slashes (e.g. fireworks "accounts/x/models/y").
// ---------------------------------------------------------------------------

export interface ModelRef {
  providerId: string;
  modelId: string;
}

export function parseModelRef(ref: string): ModelRef | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}

export function formatModelRef(parts: ModelRef): string {
  return `${parts.providerId}/${parts.modelId}`;
}
