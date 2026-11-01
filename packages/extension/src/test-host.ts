import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionHealth } from "./index.ts";
import {
  OUTSIDE_PORT_PERMISSION,
  ownsRoutePath,
  ownsToolName,
  parseExtensionManifest,
  type ExtensionManifest,
  type ExtensionTool,
  type OutsideConversationIdentity,
  type OutsideExtension,
  type OutsidePermission,
  type OutsidePorts,
} from "./outside.ts";

export interface TestHostOptions {
  /** The extension's manifest, checked like the real host checks it. */
  readonly manifest: unknown;
  /** Permissions the pretend owner grants; defaults to everything the manifest asks for. */
  readonly granted?: readonly OutsidePermission[];
  readonly options?: Readonly<Record<string, string>>;
  /** Broker contents by name; the extension still reads only its own namespace. */
  readonly credentials?: Readonly<Record<string, string>>;
  /** Defaults to a fresh temporary directory, removed by `stop`. */
  readonly stateDirectory?: string;
}

export interface TestHost {
  readonly manifest: ExtensionManifest;
  /** Exactly the ports the real host would hand over. */
  readonly ports: Readonly<Partial<OutsidePorts>>;
  /** Creates and starts the extension; rejects with `permission_refused_NAME` like the real host degrades. */
  start(extension: OutsideExtension<unknown, keyof OutsidePorts>): Promise<void>;
  health(): Promise<ExtensionHealth>;
  /** The tools the host would put in the bank, after the ownership and permission filters. */
  tools(identity?: OutsideConversationIdentity): readonly ExtensionTool[];
  /** Calls one of its routes as the authenticated owner would. */
  fetch(path: string, init?: RequestInit, identity?: OutsideConversationIdentity): Promise<Response>;
  stop(): Promise<void>;
}

const ownerIdentity: OutsideConversationIdentity = {
  conversationId: "test-conversation",
  current: () => true,
};

/**
 * Runs an outside extension against fake ports with the real host's rules
 * (ADR 0338): manifest validation, per-permission grants, the credential
 * namespace, and the tool-name and route-path ownership filters. For an
 * extension author's own tests; it does not run games, which need the host's
 * play ledger.
 */
export function createTestHost(options: TestHostOptions): TestHost {
  const manifest = parseExtensionManifest(options.manifest);
  if (manifest.kind !== "extension") throw new Error("test_host_games_unsupported");
  const granted = new Set(
    (options.granted ?? manifest.permissions).filter((permission) =>
      manifest.permissions.includes(permission),
    ),
  );
  const temporary = options.stateDirectory === undefined;
  const stateDirectory = options.stateDirectory ?? mkdtempSync(join(tmpdir(), `${manifest.id}-state-`));
  const all: OutsidePorts = {
    options: Object.freeze({ ...options.options }),
    stateDirectory,
    async credential(name) {
      if (name !== manifest.id && !name.startsWith(`${manifest.id}-`)) return undefined;
      return options.credentials?.[name];
    },
  };
  const ports: Partial<OutsidePorts> = {};
  for (const key of Object.keys(OUTSIDE_PORT_PERMISSION) as (keyof OutsidePorts)[])
    if (granted.has(OUTSIDE_PORT_PERMISSION[key])) Object.assign(ports, { [key]: all[key] });
  Object.freeze(ports);
  let runtime: ReturnType<OutsideExtension["create"]> | undefined;
  const projection = () => (runtime === undefined ? undefined : runtime.projection?.());
  return {
    manifest,
    ports,
    async start(extension) {
      if (extension.id !== manifest.id) throw new Error("id_mismatch");
      for (const need of extension.needs)
        if (!(need in ports)) throw new Error(`permission_refused_${OUTSIDE_PORT_PERMISSION[need]}`);
      const host: Partial<OutsidePorts> = {};
      for (const need of extension.needs) Object.assign(host, { [need]: ports[need] });
      runtime = extension.create(
        Object.freeze(host) as OutsidePorts,
        extension.settings.schema.parse(all.options),
      );
      await runtime.start(new AbortController().signal);
    },
    async health() {
      if (runtime === undefined) return { state: "degraded", reason: "not_started" };
      return runtime.health();
    },
    tools(identity = ownerIdentity) {
      if (!granted.has("tools")) return [];
      return (projection()?.tools?.(identity) ?? []).filter((tool) => ownsToolName(manifest.id, tool.name));
    },
    async fetch(path, init, identity = ownerIdentity) {
      const current = projection();
      const allowed =
        granted.has("routes") &&
        current?.fetch !== undefined &&
        (current.paths ?? []).includes(path) &&
        ownsRoutePath(manifest.id, manifest.kind, path);
      if (!allowed) return Response.json({ error: "not_found" }, { status: 404 });
      return current.fetch!(new Request(`http://127.0.0.1${path}`, init), identity);
    },
    async stop() {
      await runtime?.stop();
      runtime = undefined;
      if (temporary) rmSync(stateDirectory, { recursive: true, force: true });
    },
  };
}
