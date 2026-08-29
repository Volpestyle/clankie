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
import { loadConfig, type LoadConfigResult } from "@clankie/model-provider";
import { SettingsStore, defaultSettingsPath, type ClankieSettings } from "@clankie/settings";

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
    readonly pokemonEmulatorEnabled: boolean;
    readonly pokeagentMmoEnabled: boolean;
  };
  readonly emailConfigured: boolean;
  readonly mcpServers: readonly string[];
  readonly credentials: readonly InstallDoctorCredential[];
  readonly commands: { readonly [name: string]: CommandPresence };
  readonly herdrPlugin: HerdrPluginReport;
  readonly remediations: readonly string[];
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
  const execFile = options.execFileImpl ?? defaultExecFile(env);
  const commands = await probeCommands(execFile, env);
  const pluginBundle = join(options.repoRoot, "integrations", "herdr-plugin");
  const bundled = existsSync(join(pluginBundle, "herdr-plugin.toml"));
  const herdrPlugin = await inspectHerdrPlugin(
    execFile,
    commands.herdr?.present === true,
    bundled,
    pluginBundle,
  );
  const model = unsetToNull(config.config.model);
  const remediations = collectRemediations({
    model,
    discord: settings.discord,
    credentialIds: new Set(credentials.map((entry) => entry.id)),
    commands,
    herdrPlugin,
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
      pokemonEmulatorEnabled: settings.gameplay.pokemonEmulatorEnabled,
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
    remediations,
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
}): string[] {
  const remediations: string[] = [];
  if (input.model === null) remediations.push("Pick a captain model in the operator console with /model.");
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
    input.herdrPlugin.linked !== true
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
