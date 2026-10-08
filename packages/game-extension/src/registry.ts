import {
  GameExtensionDescriptorSchema,
  GameExtensionCatalogSchema,
  type GameExtensionCatalog,
  type GameExtensionDescriptor,
} from "@clankie/protocol";
import { GameExtensionBusyError, type GameExtension, type GameExtensionRuntime } from "./index.ts";

interface Registration<Projection> {
  descriptor: GameExtensionDescriptor;
  runtime: Pick<
    GameExtensionRuntime<{ sessionId: string }, unknown>,
    "status" | "health" | "reconcileStopped" | "deactivate"
  >;
  retiring: boolean;
  projection?: Projection;
}

/** Trusted in-process composition only. Descriptors are never executable manifests. */
export class GameExtensionRegistry<Projection = never> {
  private readonly entries = new Map<string, Registration<Projection>>();
  private revision = 0;

  public register<
    Request extends { sessionId: string },
    Result,
    Settings,
    Host,
    Runtime extends GameExtensionRuntime<Request, Result>,
  >(
    extension: GameExtension<Request, Result, Settings, Host> & { create(host: Host): Runtime },
    host: Host,
    project?: (runtime: Runtime) => Projection,
  ): Runtime {
    const descriptor = GameExtensionDescriptorSchema.parse({
      contractVersion: extension.contractVersion,
      id: extension.id,
      connector: extension.connector,
      skill: extension.skill,
      settings: { key: extension.settings.key },
      activity: extension.activity,
    });
    if (this.entries.has(descriptor.id)) throw new Error("game_extension_already_registered");
    if (this.entries.size >= 64) throw new Error("game_extension_catalog_full");
    const runtime = (extension as { create(host: Host): Runtime }).create(host);
    const entry: Registration<Projection> = {
      descriptor,
      runtime,
      retiring: false,
      ...(project === undefined ? {} : { projection: project(runtime) }),
    };
    this.entries.set(descriptor.id, entry);
    this.revision++;
    const current = () => this.entries.get(descriptor.id) === entry && !entry.retiring;
    runtime.bindRegistrationGuard?.(() => {
      if (!current()) throw new Error("game_extension_not_registered");
    });
    const start: GameExtensionRuntime<Request, Result>["start"] = async (request, control, onRunning) => {
      if (!current()) throw new Error("game_extension_not_registered");
      const status = await runtime.status();
      if (!current()) throw new Error("game_extension_not_registered");
      if (status.state !== "idle") throw new GameExtensionBusyError(status);
      // No asynchronous gap between final membership check and runtime admission.
      return runtime.start(request, control, onRunning);
    };
    // Preserve native runtime fields and class/private-field method receivers.
    return new Proxy(runtime, {
      get(target, property) {
        if (property === "start") return start;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  public projections(): readonly Projection[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.retiring || entry.projection === undefined ? [] : [entry.projection],
    );
  }

  /** Removal is host-only and refuses held or uncertain connector ownership. */
  public async unregister(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (entry.retiring) throw new Error("game_extension_removal_in_progress");
    const initial = await entry.runtime.status();
    if (initial.state !== "idle") throw new GameExtensionBusyError(initial);
    if (this.entries.get(id) !== entry || entry.retiring) throw new Error("game_extension_catalog_changed");
    entry.retiring = true;
    try {
      const status = await entry.runtime.status();
      if (status.state !== "idle") throw new GameExtensionBusyError(status);
      await entry.runtime.deactivate?.();
      this.entries.delete(id);
      this.revision++;
    } finally {
      entry.retiring = false;
    }
  }

  /** Called only inside the core's exact, incarnation-fenced recovery operation. */
  public async reconcileStopped(id: string, proof: () => Promise<boolean>): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry || entry.retiring) return false;
    const status = await entry.runtime.status();
    if (this.entries.get(id) !== entry || entry.retiring) return false;
    if (status.state === "idle") return true;
    if (entry.runtime.reconcileStopped === undefined) return false;
    const confirmed = await entry.runtime.reconcileStopped(status.sessionId, proof);
    return confirmed && this.entries.get(id) === entry && !entry.retiring;
  }

  /** Local metadata/lifecycle reads. Exceptions never disclose provider diagnostics. */
  public async catalog(): Promise<GameExtensionCatalog> {
    const revision = this.revision;
    const extensions = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        try {
          const [status, health] = await Promise.all([entry.runtime.status(), entry.runtime.health()]);
          return GameExtensionCatalogSchema.shape.extensions.element.parse({
            ...entry.descriptor,
            status,
            health,
          });
        } catch {
          return {
            ...entry.descriptor,
            status: { state: "uncertain" as const, sessionId: "unavailable" },
            health: { state: "degraded" as const, reason: "extension_unavailable" as const },
          };
        }
      }),
    );
    if (revision !== this.revision) throw new Error("game_extension_catalog_changed");
    return GameExtensionCatalogSchema.parse({ extensions });
  }
}
