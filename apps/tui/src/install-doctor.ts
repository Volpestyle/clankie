import { execFile as execFileCallback } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import {
  createDefaultCredentialStore,
  type CredentialStore,
  type RedactedCredential,
} from "@clankie/credential-broker";
import {
  loadConfig,
  parseModelRef,
  type ClankieConfig,
  type LoadConfigResult,
} from "@clankie/model-provider";
import { SettingsStore, defaultSettingsPath, type ClankieSettings } from "@clankie/settings";
import { commandHost } from "./command/io.ts";

const execFileAsync = promisify(execFileCallback);
const PROBE_TIMEOUT_MS = 5_000;

const VERSION_PROBES = [
  ["herdr", ["--version"]],
  ["ffmpeg", ["-version"]],
  ["yt-dlp", ["--version"]],
] as const;

/** `herdr-lead --version` opens the board TUI; presence is PATH-only. */
const PATH_ONLY_COMMANDS = ["herdr-lead"] as const;

export type InstallKind = "checkout" | "release";

interface CommandPresence {
  readonly present: boolean;
  readonly detail?: string;
}

interface InstallDoctorCredential {
  readonly id: string;
  readonly type: RedactedCredential["type"];
}

interface HerdrPluginReport {
  readonly bundled: boolean;
  readonly bundlePath?: string;
  readonly linked?: boolean;
  readonly enabled?: boolean;
  readonly manifestPath?: string;
}

export interface InstallDoctorReport {
  readonly ok: true;
  readonly kind: InstallKind;
  readonly version: string;
  readonly repoRoot: string;
  readonly model: string | null;
  readonly imageModel: string | null;
  readonly videoModel: string | null;
  readonly persona: { readonly displayName: string };
  readonly discord: {
    readonly activeBody: ClankieSettings["discord"]["activeBody"];
    readonly textIngressEnabled: boolean;
    readonly voiceEnabled: boolean;
    readonly userSessionEnabled: boolean;
    readonly machineGrantUsers: number;
    readonly machineGrantGuilds: number;
  };
  readonly voice: {
    readonly realtimeProvider: ClankieSettings["voice"]["realtimeProvider"];
    readonly ttsProvider: ClankieSettings["voice"]["ttsProvider"];
  };
  readonly gameplay: {
    readonly pokeagentMmoEnabled: boolean;
  };
  readonly emailConfigured: boolean;
  readonly mcpServers: readonly string[];
  readonly credentials: readonly InstallDoctorCredential[];
  readonly commands: { readonly [name: string]: CommandPresence };
  readonly herdrPlugin: HerdrPluginReport;
  /** Where another harness reaches his lane-scoped tool bank over MCP (VUH-1085). */
  readonly laneTools: { readonly url: string; readonly reachable: boolean };
  readonly selectedModel: SelectedModelReport | null;
  readonly remediations: readonly string[];
}

/**
 * What the captain's selected model actually resolves to. `doctor` reporting a
 * healthy install while every turn fails is the failure this closes: a ref can
 * name a provider that is unreachable, a model the endpoint does not serve, or
 * an endpoint that wants a key nothing has stored.
 */
interface SelectedModelReport {
  readonly ref: string;
  readonly providerId: string;
  readonly modelId: string;
  /** Present only for a provider declared in clankie.json with its own baseURL. */
  readonly endpoint?: {
    readonly baseURL: string;
    readonly reachable: boolean;
    /** The endpoint answered an unauthenticated probe with 401/403. */
    readonly authRequired: boolean;
    readonly credentialStored: boolean;
    /** The ref's model id is one this provider declares. */
    readonly declaresModel: boolean;
  };
}

export type ExecFileImpl = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

export interface InspectInstallOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: SettingsStore;
  readonly credentialStore?: CredentialStore;
  readonly loadConfigImpl?: (input: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<LoadConfigResult>;
  readonly execFileImpl?: ExecFileImpl;
  readonly fetchImpl?: typeof fetch;
}

/** A release ships `libexec/node` and `release.json`; a checkout does not. */
export function inspectInstallKind(repoRoot: string): InstallKind {
  return existsSync(join(repoRoot, "libexec", "node")) && existsSync(join(repoRoot, "release.json"))
    ? "release"
    : "checkout";
}

function defaultExecFile(env: NodeJS.ProcessEnv): ExecFileImpl {
  return async (command, args) => {
    const result = await execFileAsync(command, [...args], {
      timeout: PROBE_TIMEOUT_MS,
      env,
      encoding: "utf8",
    });
    return { stdout: result.stdout, stderr: result.stderr };
  };
}

export async function inspectInstall(options: InspectInstallOptions): Promise<InstallDoctorReport> {
  const env = options.env ?? process.env;
  const kind = inspectInstallKind(options.repoRoot);
  const settings = await (options.settings ?? new SettingsStore(defaultSettingsPath(env))).load();
  const config = await (options.loadConfigImpl ?? loadConfig)({ cwd: options.repoRoot, env });
  const credentials = await listCredentialIds(
    options.credentialStore ?? createDefaultCredentialStore({ env }),
  );
  const execute = options.execFileImpl ?? defaultExecFile(env);
  const herdrBinary =
    settings.herdr.runtime === "bundled" ||
    (settings.herdr.runtime === "auto" && settings.herdr.session === "default" && env.HERDR_ENV !== "1")
      ? join(options.repoRoot, kind === "release" ? "libexec/herdr" : ".data/herdr/bin/herdr")
      : "herdr";
  const execFile: ExecFileImpl = (command, args) =>
    execute(command === "herdr" ? herdrBinary : command, args);
  const commands = await probeCommands(execFile, env);
  const pluginBundle = join(options.repoRoot, "integrations", "herdr-plugin");
  const bundled = existsSync(join(pluginBundle, "herdr-plugin.toml"));
  const herdrPlugin = await inspectHerdrPlugin(
    execFile,
    herdrBinary === "herdr" && commands.herdr?.present === true,
    bundled,
    pluginBundle,
  );
  const laneTools = await inspectLaneTools(commandHost({ env }), options.fetchImpl ?? fetch);
  const model = unsetToNull(config.config.model);
  const credentialIds = new Set(credentials.map((entry) => entry.id));
  const selectedModel = await inspectSelectedModel(
    model,
    config.config,
    credentialIds,
    options.fetchImpl ?? fetch,
  );
  const remediations = collectRemediations({
    model,
    discord: settings.discord,
    credentialIds,
    commands,
    herdrPlugin,
    selectedModel,
  });

  return {
    ok: true,
    kind,
    version: await readInstallVersion(options.repoRoot, kind),
    repoRoot: options.repoRoot,
    model,
    imageModel: unsetToNull(config.config.image_model),
    videoModel: unsetToNull(config.config.video_model),
    persona: { displayName: settings.persona.displayName },
    discord: {
      activeBody: settings.discord.activeBody,
      textIngressEnabled: settings.discord.textIngressEnabled,
      voiceEnabled: settings.discord.voiceEnabled,
      userSessionEnabled: settings.discord.userSessionEnabled,
      machineGrantUsers: settings.discord.systemActorUserIds.length,
      machineGrantGuilds: settings.discord.systemActorGuildIds.length,
    },
    voice: {
      realtimeProvider: settings.voice.realtimeProvider,
      ttsProvider: settings.voice.ttsProvider,
    },
    gameplay: {
      pokeagentMmoEnabled: settings.gameplay.pokeagentMmoEnabled,
    },
    emailConfigured:
      settings.email.username !== undefined ||
      settings.email.fromAddress !== undefined ||
      settings.email.imapHost !== undefined,
    mcpServers: settings.mcp.servers.filter((server) => server.enabled).map((server) => server.id),
    credentials,
    commands,
    herdrPlugin,
    laneTools,
    selectedModel,
    remediations,
  };
}

/**
 * The MCP route answers 401 unauthenticated, and that is the signal worth
 * reporting: the route is served and it wants a lane bearer. Anything else —
 * a refusal to connect, a 404 from an older service — means a seat pointed
 * here would find nothing.
 */
async function inspectLaneTools(
  host: string,
  fetchImpl: typeof fetch,
): Promise<{ readonly url: string; readonly reachable: boolean }> {
  const url = `${host.replace(/\/+$/u, "")}/v1/mcp`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return { url, reachable: response.status === 401 };
  } catch {
    return { url, reachable: false };
  }
}

/**
 * Probes the selected ref's endpoint when it is one clankie.json declares. The
 * probe is deliberately unauthenticated: a 401 is the positive signal that the
 * endpoint wants a key, which is what makes the credential check evidence-based
 * rather than a guess about how the provider resolves auth.
 */
async function inspectSelectedModel(
  model: string | null,
  config: ClankieConfig,
  credentialIds: ReadonlySet<string>,
  fetchImpl: typeof fetch,
): Promise<SelectedModelReport | null> {
  if (model === null) return null;
  const parsed = parseModelRef(model);
  if (parsed === undefined) return null;
  const { providerId, modelId } = parsed;
  const declared = config.provider?.[providerId];
  const baseURL = typeof declared?.options?.baseURL === "string" ? declared.options.baseURL : undefined;
  if (declared === undefined || baseURL === undefined) return { ref: model, providerId, modelId };

  let reachable = false;
  let authRequired = false;
  try {
    const response = await fetchImpl(`${baseURL.replace(/\/+$/u, "")}/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    reachable = true;
    authRequired = response.status === 401 || response.status === 403;
  } catch {
    reachable = false;
  }
  return {
    ref: model,
    providerId,
    modelId,
    endpoint: {
      baseURL,
      reachable,
      authRequired,
      credentialStored: credentialIds.has(providerId),
      declaresModel: Object.hasOwn(declared.models ?? {}, modelId),
    },
  };
}

function unsetToNull(value: string | undefined): string | null {
  return value === undefined || value.length === 0 ? null : value;
}

async function readInstallVersion(repoRoot: string, kind: InstallKind): Promise<string> {
  if (kind === "release") {
    const fromManifest = await readJsonStringField(join(repoRoot, "release.json"), "version");
    if (fromManifest !== undefined) return fromManifest;
  }
  return (await readJsonStringField(join(repoRoot, "package.json"), "version")) ?? "unknown";
}

async function readJsonStringField(path: string, field: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

async function listCredentialIds(store: CredentialStore): Promise<readonly InstallDoctorCredential[]> {
  try {
    const listed = await store.list();
    return Object.entries(listed)
      .map(([id, redacted]) => ({ id, type: redacted.type }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch {
    return [];
  }
}

async function probeCommands(
  execFile: ExecFileImpl,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly [name: string]: CommandPresence }> {
  const versioned = await Promise.all(
    VERSION_PROBES.map(async ([name, args]) => [name, await probeCommand(execFile, name, args)] as const),
  );
  const pathOnly = PATH_ONLY_COMMANDS.map(
    (name) =>
      [name, commandOnPath(name, env) ? { present: true as const } : { present: false as const }] as const,
  );
  return Object.fromEntries([...versioned, ...pathOnly]);
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsSync(join(dir, command)));
}

async function probeCommand(
  execFile: ExecFileImpl,
  command: string,
  args: readonly string[],
): Promise<CommandPresence> {
  try {
    const result = await execFile(command, args);
    const detail = firstLine(`${result.stdout}${result.stderr}`);
    return detail === undefined ? { present: true } : { present: true, detail };
  } catch (error) {
    if (isCommandMissing(error)) return { present: false };
    const detail = firstLine(execErrorText(error));
    return detail === undefined ? { present: true } : { present: true, detail };
  }
}

async function inspectHerdrPlugin(
  execFile: ExecFileImpl,
  herdrPresent: boolean,
  bundled: boolean,
  bundlePath: string,
): Promise<HerdrPluginReport> {
  const bundledFields = bundled ? { bundled: true as const, bundlePath } : { bundled: false as const };
  if (!herdrPresent) return bundledFields;
  try {
    const { stdout } = await execFile("herdr", ["plugin", "list", "--plugin", "clankie", "--json"]);
    const parsed = JSON.parse(stdout) as { result?: { plugins?: readonly HerdrPluginListEntry[] } };
    const plugin = parsed.result?.plugins?.[0];
    if (plugin === undefined) return { ...bundledFields, linked: false };
    return {
      ...bundledFields,
      linked: true,
      enabled: plugin.enabled === true,
      ...(typeof plugin.manifest_path === "string" ? { manifestPath: plugin.manifest_path } : {}),
    };
  } catch {
    return { ...bundledFields, linked: false };
  }
}

interface HerdrPluginListEntry {
  readonly enabled?: unknown;
  readonly manifest_path?: unknown;
}

function collectRemediations(input: {
  readonly model: string | null;
  readonly discord: ClankieSettings["discord"];
  readonly credentialIds: ReadonlySet<string>;
  readonly commands: { readonly [name: string]: CommandPresence };
  readonly herdrPlugin: HerdrPluginReport;
  readonly selectedModel: SelectedModelReport | null;
}): string[] {
  const remediations: string[] = [];
  if (input.model === null) {
    remediations.push("Pick a captain model with `clankie model set provider/model` or `/model`.");
  }
  const endpoint = input.selectedModel?.endpoint;
  const selectedProvider = input.selectedModel?.providerId;
  if (endpoint !== undefined && selectedProvider !== undefined) {
    if (!endpoint.reachable) {
      remediations.push(
        `Start the runtime behind ${endpoint.baseURL}; every captain turn on ${input.selectedModel?.ref} fails until it answers.`,
      );
    }
    if (endpoint.authRequired && !endpoint.credentialStored) {
      remediations.push(
        `${endpoint.baseURL} requires a key and none is stored for ${selectedProvider}; add it with \`/auth ${selectedProvider}\`.`,
      );
    }
    if (!endpoint.declaresModel) {
      remediations.push(
        `Provider ${selectedProvider} declares no model ${input.selectedModel?.modelId}; re-probe with \`clankie model add-local --id ${selectedProvider} --base-url ${endpoint.baseURL}\`.`,
      );
    }
  }
  const discordInUse =
    input.discord.textIngressEnabled || input.discord.voiceEnabled || input.discord.userSessionEnabled;
  if (discordInUse && input.discord.activeBody === "bot" && !input.credentialIds.has("discord_bot")) {
    remediations.push("Store a Discord bot token with /discord.");
  }
  if (
    discordInUse &&
    input.discord.activeBody === "user_session" &&
    !input.credentialIds.has("discord_user_session")
  ) {
    remediations.push("Store the personal-lab Discord user token with /discord.");
  }
  if (
    input.commands.herdr?.present === true &&
    input.herdrPlugin.bundled &&
    input.herdrPlugin.bundlePath !== undefined &&
    input.herdrPlugin.linked === false
  ) {
    remediations.push(`herdr plugin link ${input.herdrPlugin.bundlePath}`);
  }
  return remediations;
}

function isCommandMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function execErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const stdout = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  const combined = `${stdout}${stderr}`.trim();
  if (combined.length > 0) return combined;
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string | undefined {
  const line = text.trim().split("\n")[0]?.trim();
  return line === undefined || line.length === 0 ? undefined : line;
}
