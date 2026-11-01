import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  GAME_MODULE_PERMISSIONS,
  OUTSIDE_EXTENSION_ID,
  OUTSIDE_PERMISSIONS,
  insideRelativePath,
  negotiateContract,
  readExtensionManifest,
  type OutsidePermission,
} from "@clankie/extension";
import {
  EXTENSIONS_PATH,
  ExtensionStatesSchema,
  UpdateExtensionSchema,
  type ExtensionStates,
  type UpdateExtension,
} from "@clankie/protocol";
import {
  InstalledExtensionSchema,
  SettingsStore,
  defaultSettingsPath,
  type InstalledExtension,
} from "@clankie/settings";
import { commandHost } from "./io.ts";

const run = promisify(execFile);

export interface ExtensionsCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly settings?: SettingsStore;
}

const USAGE = [
  "Usage: clankie extensions [status] | on ID | off ID",
  "       clankie extensions add FOLDER|GIT_URL [--commit SHA] [--path SUBDIR] [--id ID] [--entry FILE]",
  "                              [--grant all|PERMISSION,...] [KEY=VALUE...]",
  "       clankie extensions grant|refuse ID all|PERMISSION...",
  "       clankie extensions remove ID",
].join("\n");

/** Said at every install: the permissions bind honest code, they are not a sandbox (ADR 0338). */
const TRUST_NOTE =
  "An outside extension runs inside Clankie's service as your user. Its permissions keep an honest extension's reach visible; they are not a sandbox, and its code can still do anything you can. Add only code you trust.";

/** One installed outside extension, as the owner's settings hold it. */
export interface InstalledExtensionRow {
  readonly id: string;
  readonly source: string;
  readonly asks?: readonly OutsidePermission[];
  readonly granted: readonly OutsidePermission[];
  readonly refused: readonly OutsidePermission[];
  readonly switch: "on" | "off";
  /** Why the manifest could not be read here, as a fixed code. */
  readonly manifest?: string;
}

export type ExtensionsCommandResult =
  | (ExtensionStates & { readonly installed?: readonly InstalledExtensionRow[] })
  | {
      readonly ok: true;
      readonly extension: InstalledExtensionRow;
      readonly settingsFile: string;
      readonly restart: "clankie restart";
      readonly note?: string;
      readonly next?: string;
    }
  | {
      readonly ok: true;
      readonly removed: string;
      readonly settingsFile: string;
      readonly restart: "clankie restart";
      readonly files?: string;
    };

function store(options: ExtensionsCommandOptions): SettingsStore {
  return options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
}

function stateRoot(env: NodeJS.ProcessEnv): string {
  return resolve(env.CLANKIE_STATE?.trim() || join(homedir(), ".clankie"));
}

/** The service reads the same path (`extensionCheckout` in apps/clankie). */
function checkoutOf(env: NodeJS.ProcessEnv, id: string, commit: string): string {
  return join(stateRoot(env), "extensions", id, commit);
}

function folderOf(env: NodeJS.ProcessEnv, item: InstalledExtension): string {
  if (item.source.kind === "folder") return item.source.path;
  const checkout = checkoutOf(env, item.id, item.source.commit);
  return item.source.path === undefined ? checkout : join(checkout, item.source.path);
}

function describeSource(item: InstalledExtension): string {
  return item.source.kind === "folder"
    ? item.source.path
    : `${item.source.url}@${item.source.commit}${item.source.path === undefined ? "" : `#${item.source.path}`}`;
}

/** What the extension asks for, read from its manifest without running it. */
function asksOf(
  env: NodeJS.ProcessEnv,
  item: InstalledExtension,
): { asks?: readonly OutsidePermission[]; manifest?: string } {
  try {
    const manifest = readExtensionManifest(folderOf(env, item));
    if (manifest !== undefined) return { asks: manifest.permissions };
    return item.entry === undefined ? { manifest: "manifest_missing" } : { asks: GAME_MODULE_PERMISSIONS };
  } catch (error) {
    return {
      manifest:
        error instanceof Error && /^manifest_[a-z_]+$/u.test(error.message)
          ? error.message
          : "source_unreadable",
    };
  }
}

function rowOf(
  env: NodeJS.ProcessEnv,
  item: InstalledExtension,
  switches: Readonly<Record<string, string>>,
): InstalledExtensionRow {
  const { asks, manifest } = asksOf(env, item);
  const granted =
    asks === undefined ? item.granted : asks.filter((permission) => item.granted.includes(permission));
  return {
    id: item.id,
    source: describeSource(item),
    ...(asks === undefined ? {} : { asks }),
    granted,
    refused: asks === undefined ? [] : asks.filter((permission) => !item.granted.includes(permission)),
    switch: switches[item.id] === "off" ? "off" : "on",
    ...(manifest === undefined ? {} : { manifest }),
  };
}

function parsePermissions(
  values: readonly string[],
  asks: readonly OutsidePermission[],
): OutsidePermission[] {
  if (values.length === 1 && values[0] === "all") return [...asks];
  const permissions = values.flatMap((value) => value.split(",")).filter((value) => value !== "");
  for (const permission of permissions)
    if (!(OUTSIDE_PERMISSIONS as readonly string[]).includes(permission))
      throw new Error(`Unknown permission ${permission}; permissions are ${OUTSIDE_PERMISSIONS.join(", ")}.`);
  const unasked = permissions.filter((permission) => !asks.includes(permission as OutsidePermission));
  if (unasked.length > 0) throw new Error(`The extension does not ask for ${unasked.join(", ")}.`);
  return permissions as OutsidePermission[];
}

/**
 * Each extension's state after a fresh health read, the owner's switches
 * (ADR 0328), and the outside extensions the owner installed (ADR 0338).
 * `on`/`off` change one switch; `add`, `grant`, `refuse` and `remove` change
 * the owner's install list. Every change takes effect at the next start.
 */
export async function runExtensionsCommand(
  args: readonly string[],
  options: ExtensionsCommandOptions = {},
): Promise<ExtensionsCommandResult> {
  const env = options.env ?? process.env;
  const verb = args[0] ?? "status";
  if (verb === "add") return addExtension(args.slice(1), options);
  if (verb === "remove") {
    if (args.length !== 2) throw new Error(USAGE);
    return removeExtension(args[1]!, options);
  }
  if (verb === "grant" || verb === "refuse") {
    if (args.length < 3) throw new Error(USAGE);
    return changeGrants(verb, args[1]!, args.slice(2), options);
  }
  let change: UpdateExtension | undefined;
  if (verb === "on" || verb === "off") {
    const parsed = UpdateExtensionSchema.safeParse({ schemaVersion: 1, id: args[1], switch: verb });
    if (args.length !== 2 || !parsed.success) throw new Error(USAGE);
    change = parsed.data;
  } else if (verb !== "status" || args.length > 1) throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Operator credential unavailable; run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(
    `${commandHost(options).replace(/\/+$/u, "")}${EXTENSIONS_PATH}`,
    {
      method: change === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(change === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(change === undefined ? {} : { body: JSON.stringify(change) }),
      signal: AbortSignal.timeout(5000),
    },
  );
  if (response.status === 404 && change !== undefined) {
    // Installed since the service started: the switch is still the owner's to set.
    const local = await switchInstalled(change, options);
    if (local !== undefined) return local;
    throw new Error(`No extension named ${change.id}; run clankie extensions for the list.`);
  }
  if (!response.ok) throw new Error(`Extensions unavailable (${response.status}); run clankie doctor.`);
  const states = ExtensionStatesSchema.parse(await response.json());
  const installed = await installedRows(options);
  return installed === undefined || installed.length === 0 ? states : { ...states, installed };
}

async function installedRows(
  options: ExtensionsCommandOptions,
): Promise<readonly InstalledExtensionRow[] | undefined> {
  const env = options.env ?? process.env;
  try {
    const settings = await store(options).load();
    return (settings.installedExtensions ?? []).map((item) => rowOf(env, item, settings.extensions));
  } catch {
    return undefined; // The service's own list above still answers.
  }
}

async function switchInstalled(
  change: UpdateExtension,
  options: ExtensionsCommandOptions,
): Promise<ExtensionsCommandResult | undefined> {
  const settings = store(options);
  const current = await settings.load();
  if (!(current.installedExtensions ?? []).some((item) => item.id === change.id)) return undefined;
  const updated = await settings.update((value) => ({
    ...value,
    extensions: { ...value.extensions, [change.id]: change.switch },
  }));
  return {
    schemaVersion: 1,
    extensions: [],
    switches: updated.extensions,
    restartRequired: true,
    installed: (await installedRows(options)) ?? [],
  };
}

interface AddFlags {
  source: string;
  commit?: string;
  path?: string;
  id?: string;
  entry?: string;
  grant?: string;
  options: Record<string, string>;
}

function parseAdd(args: readonly string[]): AddFlags {
  const [source, ...rest] = args;
  if (source === undefined || source.startsWith("--")) throw new Error(USAGE);
  const flags: AddFlags = { source, options: {} };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    const flag = /^--(commit|path|id|entry|grant)$/u.exec(arg)?.[1] as
      | "commit"
      | "path"
      | "id"
      | "entry"
      | "grant"
      | undefined;
    if (flag !== undefined) {
      const value = rest[++index];
      if (value === undefined) throw new Error(`${arg} needs a value.\n${USAGE}`);
      flags[flag] = value;
      continue;
    }
    const split = arg.indexOf("=");
    if (split <= 0 || arg.startsWith("--")) throw new Error(USAGE);
    flags.options[arg.slice(0, split)] = arg.slice(split + 1);
  }
  return flags;
}

/** `github:owner/repo` is shorthand for its https URL. */
function gitUrl(source: string): string | undefined {
  const github = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/u.exec(source);
  if (github !== null) return `https://github.com/${github[1]!.replace(/\.git$/u, "")}.git`;
  if (/^(https:\/\/|file:\/\/\/|git@)/u.test(source)) return source;
  return undefined;
}

const git = async (cwd: string, ...args: string[]) =>
  (
    await run("git", ["-C", cwd, ...args], { timeout: 300_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 })
  ).stdout.trim();

/**
 * Fetches exactly one commit into a fresh folder: no branch, no tag, nothing
 * that can move. A partial clone with a sparse checkout keeps a large
 * repository's other folders out.
 */
async function fetchPinned(
  url: string,
  commit: string,
  path: string | undefined,
  into: string,
): Promise<void> {
  mkdirSync(into, { recursive: true, mode: 0o700 });
  await git(into, "init", "-q");
  await git(into, "remote", "add", "origin", url);
  if (path !== undefined) {
    await git(into, "config", "core.sparseCheckout", "true");
    await git(into, "sparse-checkout", "set", "--no-cone", `/${path}/`);
  }
  await git(
    into,
    "-c",
    "protocol.version=2",
    "fetch",
    "-q",
    "--depth",
    "1",
    "--filter=blob:none",
    "origin",
    commit,
  );
  await git(into, "checkout", "-q", "--detach", commit);
  if ((await git(into, "rev-parse", "HEAD")) !== commit)
    throw new Error("The fetched checkout is not the pinned commit.");
}

/** Installs a fetched extension's own dependencies from its lockfile, with every lifecycle script off. */
async function installDependencies(folder: string): Promise<void> {
  const manifestPath = join(folder, "package.json");
  if (!existsSync(manifestPath)) return;
  const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, string> };
  if (Object.keys(pkg.dependencies ?? {}).length === 0) return;
  if (existsSync(join(folder, "pnpm-lock.yaml")))
    await run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts", "--prod", "--ignore-workspace"], {
      cwd: folder,
      timeout: 600_000,
    });
  else if (existsSync(join(folder, "package-lock.json")))
    await run("npm", ["ci", "--ignore-scripts", "--omit=dev"], { cwd: folder, timeout: 600_000 });
  else throw new Error("A pinned extension with dependencies needs a pnpm-lock.yaml or package-lock.json.");
}

async function addExtension(
  args: readonly string[],
  options: ExtensionsCommandOptions,
): Promise<ExtensionsCommandResult> {
  const env = options.env ?? process.env;
  const flags = parseAdd(args);
  const url = gitUrl(flags.source);
  let source: InstalledExtension["source"];
  let folder: string;
  let incoming: string | undefined;
  if (url === undefined) {
    if (flags.commit !== undefined || flags.path !== undefined)
      throw new Error("--commit and --path are for git sources; a folder is used as it is.");
    folder = resolve(flags.source);
    if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`${folder} is not a folder.`);
    source = { kind: "folder", path: folder };
  } else {
    if (flags.commit === undefined || !/^[0-9a-f]{40}$/u.test(flags.commit))
      throw new Error(
        "A git source needs --commit with the full 40-character sha; Clankie never follows a branch or tag.",
      );
    if (flags.path !== undefined && !insideRelativePath(flags.path))
      throw new Error("--path must be a folder inside the repository.");
    incoming = join(stateRoot(env), "extensions", `.incoming-${randomUUID()}`);
    await fetchPinned(url, flags.commit, flags.path, incoming);
    folder = flags.path === undefined ? incoming : join(incoming, flags.path);
    source = {
      kind: "git",
      url,
      commit: flags.commit,
      ...(flags.path === undefined ? {} : { path: flags.path }),
    };
  }
  try {
    const manifest = readExtensionManifest(folder);
    let id: string;
    let asks: readonly OutsidePermission[];
    if (manifest !== undefined) {
      if (flags.id !== undefined && flags.id !== manifest.id)
        throw new Error(`The manifest names this extension ${manifest.id}.`);
      if (negotiateContract(manifest) === undefined)
        throw new Error(
          `This Clankie supports outside contract 1; the extension supports ${manifest.contracts.join(", ")}.`,
        );
      id = manifest.id;
      asks = manifest.permissions;
    } else {
      // The previous form: a game module with no manifest. The owner names what a manifest would.
      if (flags.id === undefined || flags.entry === undefined)
        throw new Error(
          "No clankie-extension.json here. For a game module without one, give --id ID and --entry FILE.",
        );
      if (!OUTSIDE_EXTENSION_ID.test(flags.id))
        throw new Error("--id must be lowercase letters, digits and dashes.");
      if (!insideRelativePath(flags.entry) || !existsSync(join(folder, flags.entry)))
        throw new Error("--entry must name a file inside the extension's folder.");
      id = flags.id;
      asks = GAME_MODULE_PERMISSIONS;
    }
    const granted = flags.grant === undefined ? [] : parsePermissions([flags.grant], asks);
    if (incoming !== undefined && source.kind === "git") {
      const checkout = checkoutOf(env, id, source.commit);
      if (existsSync(checkout)) rmSync(incoming, { recursive: true, force: true });
      else {
        mkdirSync(dirname(checkout), { recursive: true, mode: 0o700 });
        renameSync(incoming, checkout);
      }
      incoming = undefined;
      folder = source.path === undefined ? checkout : join(checkout, source.path);
      await installDependencies(folder);
    }
    const item = InstalledExtensionSchema.parse({
      id,
      source,
      ...(manifest === undefined ? { entry: flags.entry } : {}),
      ...(Object.keys(flags.options).length === 0 ? {} : { options: flags.options }),
      granted,
    });
    const settings = store(options);
    const updated = await settings.update((current) => ({
      ...current,
      installedExtensions: [
        ...(current.installedExtensions ?? []).filter((installed) => installed.id !== id),
        item,
      ],
    }));
    const row = rowOf(env, item, updated.extensions);
    return {
      ok: true,
      extension: row,
      settingsFile: settings.path,
      restart: "clankie restart",
      note: TRUST_NOTE,
      ...(row.refused.length === 0
        ? {}
        : {
            next: `Refused until granted: ${row.refused.join(", ")}. Grant with clankie extensions grant ${id} PERMISSION...`,
          }),
    };
  } finally {
    if (incoming !== undefined) rmSync(incoming, { recursive: true, force: true });
  }
}

async function changeGrants(
  verb: "grant" | "refuse",
  id: string,
  values: readonly string[],
  options: ExtensionsCommandOptions,
): Promise<ExtensionsCommandResult> {
  const env = options.env ?? process.env;
  const settings = store(options);
  const current = await settings.load();
  const item = (current.installedExtensions ?? []).find((installed) => installed.id === id);
  if (item === undefined) throw new Error(`No installed outside extension named ${id}.`);
  const asks = asksOf(env, item).asks ?? OUTSIDE_PERMISSIONS;
  const permissions = parsePermissions(values, asks);
  const granted =
    verb === "grant"
      ? [...new Set([...item.granted, ...permissions])]
      : item.granted.filter((permission) => !permissions.includes(permission));
  const next = InstalledExtensionSchema.parse({ ...item, granted });
  const updated = await settings.update((value) => ({
    ...value,
    installedExtensions: (value.installedExtensions ?? []).map((installed) =>
      installed.id === id ? next : installed,
    ),
  }));
  return {
    ok: true,
    extension: rowOf(env, next, updated.extensions),
    settingsFile: settings.path,
    restart: "clankie restart",
  };
}

async function removeExtension(
  id: string,
  options: ExtensionsCommandOptions,
): Promise<ExtensionsCommandResult> {
  const env = options.env ?? process.env;
  const settings = store(options);
  const current = await settings.load();
  const item = (current.installedExtensions ?? []).find((installed) => installed.id === id);
  if (item === undefined) throw new Error(`No installed outside extension named ${id}.`);
  await settings.update((value) => {
    const installedExtensions = (value.installedExtensions ?? []).filter((installed) => installed.id !== id);
    const { [id]: _switch, ...extensions } = value.extensions;
    const { installedExtensions: _old, ...rest } = value;
    return { ...rest, extensions, ...(installedExtensions.length === 0 ? {} : { installedExtensions }) };
  });
  return {
    ok: true,
    removed: id,
    settingsFile: settings.path,
    restart: "clankie restart",
    // A fetched checkout stays for its state and a later re-add; the owner may delete it.
    ...(item.source.kind === "git" ? { files: join(stateRoot(env), "extensions", id) } : {}),
  };
}
