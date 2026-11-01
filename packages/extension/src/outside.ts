import type { ClankieExtension } from "./index.ts";

/**
 * The frozen v1 surface for extensions that live outside this repository
 * (ADR 0338): the manifest, the narrow `OutsidePorts` and the projection.
 * Built-in extensions keep the composition root's wider core ports; an outside
 * one only ever sees what is here, and only the parts its owner granted.
 *
 * These limits bind honest code, not hostile code. An outside extension runs in
 * the service's own process as the owner's user; it can import `node:fs` and
 * ignore its ports. The permission list makes an honest extension's reach
 * visible and contains its mistakes. It is not a sandbox.
 */

/** The outside contract this SDK describes. */
export const OUTSIDE_CONTRACT_VERSION = 1;

/**
 * The contract versions a host accepts: the current one and the previous one.
 * v1 is the first frozen outside contract, so it is the only one; the
 * manifest-less game modules installed before it (`gameplay.extensions`, game
 * module API 1) still load as the previous form, with the owner naming the id
 * and entry the manifest would have declared.
 */
export const SUPPORTED_OUTSIDE_CONTRACTS: readonly number[] = [OUTSIDE_CONTRACT_VERSION];

/**
 * Each permission is one port or one kind of addition. The owner grants or
 * refuses each one; a refused port is simply absent from the host object.
 */
export const OUTSIDE_PERMISSIONS = [
  /** Read the owner's non-secret options for this extension. */
  "options",
  /** A private directory (0700) for its own durable state. */
  "state",
  /** API keys the owner stored in the broker under its own namespace: `ID` or `ID-*`. */
  "credentials",
  /** Add captain tools. Names must be the id (dashes as underscores) or start with it and `_`. */
  "tools",
  /** Add owner-authenticated HTTP routes under `/v1/ext/ID/` (a game may use `/v1/ID`). */
  "routes",
  /** Games only: the shared durable play ledger and the host's lifecycle wrapper. */
  "play",
  /** Games only: ask the active Discord body to Go Live from a snapshot URL. */
  "go-live",
] as const;
export type OutsidePermission = (typeof OUTSIDE_PERMISSIONS)[number];

/** What a manifest-less game module (game module API 1) was always given. */
export const GAME_MODULE_PERMISSIONS: readonly OutsidePermission[] = OUTSIDE_PERMISSIONS;

export const OUTSIDE_EXTENSION_ID = /^[a-z][a-z0-9-]{0,63}$/u;

/**
 * `clankie-extension.json` at the extension's root, or the `clankie` field of
 * its `package.json`. The host reads it without running any code.
 */
export interface ExtensionManifest {
  readonly id: string;
  readonly version: string;
  /** Outside contract versions the extension supports. */
  readonly contracts: readonly number[];
  /**
   * `extension`: the entry exports `extension`, a `ClankieExtension` over
   * `OutsidePorts`. `game`: the entry exports the game module
   * (`gameExtensionApis`, `gameExtension`, `projectGameExtension`).
   */
  readonly kind: "extension" | "game";
  /** The entry module, relative to the manifest, inside the extension's folder. */
  readonly entry: string;
  readonly permissions: readonly OutsidePermission[];
  readonly description?: string;
}

export const MANIFEST_FILE = "clankie-extension.json";

const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;

/** A relative path that stays inside its folder: no `..`, no absolute path, no NUL. */
export function insideRelativePath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/")) return false;
  return path.split("/").every((part) => part !== ".." && part !== "");
}

/** Validates a manifest. Throws a fixed `manifest_*` code, never echoing the input. */
export function parseExtensionManifest(input: unknown): ExtensionManifest {
  const keys = new Set(["id", "version", "contracts", "kind", "entry", "permissions", "description"]);
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new Error("manifest_invalid");
  for (const key of Object.keys(input)) if (!keys.has(key)) throw new Error("manifest_field_unknown");
  const id = field(input, "id");
  if (typeof id !== "string" || !OUTSIDE_EXTENSION_ID.test(id)) throw new Error("manifest_id_invalid");
  const version = field(input, "version");
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/u.test(version))
    throw new Error("manifest_version_invalid");
  const contracts = field(input, "contracts");
  if (
    !Array.isArray(contracts) ||
    contracts.length === 0 ||
    contracts.length > 8 ||
    !contracts.every((value) => Number.isInteger(value) && value > 0)
  )
    throw new Error("manifest_contracts_invalid");
  const kind = field(input, "kind");
  if (kind !== "extension" && kind !== "game") throw new Error("manifest_kind_invalid");
  const entry = field(input, "entry");
  if (typeof entry !== "string" || !insideRelativePath(entry)) throw new Error("manifest_entry_invalid");
  const permissions = field(input, "permissions");
  if (
    !Array.isArray(permissions) ||
    !permissions.every((value) => (OUTSIDE_PERMISSIONS as readonly unknown[]).includes(value)) ||
    new Set(permissions).size !== permissions.length
  )
    throw new Error("manifest_permissions_invalid");
  if (kind === "extension" && permissions.some((value) => value === "play" || value === "go-live"))
    throw new Error("manifest_permission_game_only");
  const description = field(input, "description");
  if (description !== undefined && (typeof description !== "string" || description.length > 280))
    throw new Error("manifest_description_invalid");
  return Object.freeze({
    id,
    version,
    contracts: Object.freeze([...(contracts as number[])]),
    kind,
    entry,
    permissions: Object.freeze([...(permissions as OutsidePermission[])]),
    ...(description === undefined ? {} : { description: description as string }),
  });
}

/** The newest contract both sides support, or undefined when they share none. */
export function negotiateContract(manifest: Pick<ExtensionManifest, "contracts">): number | undefined {
  const shared = manifest.contracts.filter((version) => SUPPORTED_OUTSIDE_CONTRACTS.includes(version));
  return shared.length === 0 ? undefined : Math.max(...shared);
}

/**
 * The ports an outside extension may name in `needs`. Each comes from one
 * granted permission: `options` from `options`, `stateDirectory` from `state`,
 * `credential` from `credentials`. A port the owner refused is absent; an
 * extension that needs it starts degraded with `permission_refused_NAME`.
 */
export interface OutsidePorts {
  /** Owner-set, non-secret values for this extension, read at service start. */
  readonly options: Readonly<Record<string, string>>;
  /** Private directory (0700) for this extension's durable state, keyed by its id. */
  readonly stateDirectory: string;
  /** An API key the owner stored in the credential broker under `ID` or `ID-*`. */
  credential(name: string): Promise<string | undefined>;
}

/** Which permission grants each port. */
export const OUTSIDE_PORT_PERMISSION: Readonly<Record<keyof OutsidePorts, OutsidePermission>> = {
  options: "options",
  stateDirectory: "state",
  credential: "credentials",
};

/** The authenticated conversation behind one tool call or route request. */
export interface OutsideConversationIdentity {
  readonly conversationId: string;
  /** The exact seat/session/turn binding is still current. */
  readonly current: () => boolean;
}

export interface ExtensionToolResult {
  /** JSON details returned to the caller; also the model's text unless `text` is set. */
  readonly details: Record<string, unknown>;
  readonly text?: string;
  readonly image?: { readonly data: string; readonly mimeType: "image/png" | "image/jpeg" };
}

/**
 * A captain tool. The host binds it to the current turn's authenticated
 * identity; the calling conversation's authority still applies, and what it
 * returns is untrusted model input, never instructions.
 */
export interface ExtensionTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** JSON Schema for the arguments; the tool still validates its own input. */
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(input: unknown): Promise<ExtensionToolResult>;
}

/**
 * What a running outside extension adds. Its health is its doctor row:
 * `clankie doctor` and `clankie extensions` show `degraded` with the reason it
 * reports.
 */
export interface OutsideProjection {
  /** Needs the `tools` permission. */
  tools?(identity: OutsideConversationIdentity | undefined): readonly ExtensionTool[];
  /** Exact paths under `/v1/ext/ID/`; needs `routes`. The host authenticates the owner first. */
  readonly paths?: readonly string[];
  fetch?(request: Request, identity: OutsideConversationIdentity): Promise<Response>;
}

/** What a `kind: "extension"` entry module exports as `extension`. */
export type OutsideExtension<
  Settings = unknown,
  Need extends keyof OutsidePorts = keyof OutsidePorts,
> = ClankieExtension<Settings, OutsidePorts, Need, OutsideProjection>;

/** A tool name an extension may add without shadowing the core's or another extension's. */
export function ownsToolName(id: string, name: string): boolean {
  const prefix = id.replaceAll("-", "_");
  return name === prefix || (name.startsWith(`${prefix}_`) && /^[a-z][a-z0-9_]{0,63}$/u.test(name));
}

/** A route path an extension may add: under `/v1/ext/ID/`, or `/v1/ID` for a game. */
export function ownsRoutePath(id: string, kind: ExtensionManifest["kind"], path: string): boolean {
  if (!/^\/[A-Za-z0-9/_.-]{1,256}$/u.test(path) || path.includes("..") || path.includes("//")) return false;
  if (path.startsWith(`/v1/ext/${id}/`)) return true;
  return kind === "game" && (path === `/v1/${id}` || path.startsWith(`/v1/${id}/`));
}
