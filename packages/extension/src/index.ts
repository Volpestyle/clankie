/**
 * One contract for the parts Clankie can run without (ADR 0328). The core
 * boots and serves the fleet with no extension at all; each extension starts
 * after the core is ready, inside its own boundary, and a failure there marks
 * only that extension degraded.
 */

export type ExtensionHealth = { state: "ready" } | { state: "degraded"; reason: string };

/** The fields every extension declares, games included (ADR 0234). */
export interface ExtensionDescriptor<Settings> {
  readonly contractVersion: 1;
  readonly id: string;
  readonly settings: { readonly key: string; readonly schema: { parse(input: unknown): Settings } };
}

export interface ExtensionRuntime<Projection> {
  /** Resolves once the extension is serving. Long-lived work reports through `health`. */
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  /** Read-only; never joins a world, posts, or spends model tokens. */
  health(): ExtensionHealth | Promise<ExtensionHealth>;
  /** The tools, routes, commands and checks it adds while it runs. */
  projection?(): Projection;
}

/**
 * `needs` names the core ports the extension may use. `create` receives only
 * those, and must be inert: no network, no model call, no join.
 */
export interface ClankieExtension<
  Settings,
  Ports extends object,
  Need extends keyof Ports,
  Projection,
> extends ExtensionDescriptor<Settings> {
  readonly needs: readonly Need[];
  create(host: Readonly<Pick<Ports, Need>>, settings: Settings): ExtensionRuntime<Projection>;
}

export type ExtensionState = "off" | "starting" | "running" | "degraded" | "stopped";

export interface ExtensionReport {
  readonly id: string;
  readonly state: ExtensionState;
  /** A fixed code, never a provider's own message. */
  readonly reason?: string;
}

interface Entry<Projection> {
  readonly id: string;
  /** Aborted when this extension is stopped, so each one can stop on its own. */
  readonly controller: AbortController;
  state: ExtensionState;
  reason?: string;
  runtime?: ExtensionRuntime<Projection>;
  projection?: Projection;
}

const MAX_EXTENSIONS = 64;

/** Trusted in-process composition only: the composition root adds reviewed, bundled extensions. */
export class ExtensionSupervisor<Ports extends object, Projection = never> {
  private readonly entries = new Map<string, Entry<Projection>>();
  private readonly ports: Ports;
  private readonly onDegraded: (id: string, reason: string) => void;

  public constructor(options: { ports: Ports; onDegraded?: (id: string, reason: string) => void }) {
    this.ports = options.ports;
    this.onDegraded = options.onDegraded ?? (() => {});
  }

  /** Adds an extension, off or created but not started. Never throws for the extension's own faults. */
  public add<Settings, Need extends keyof Ports>(
    extension: ClankieExtension<Settings, Ports, Need, Projection>,
    options: { enabled: boolean; settings: unknown },
  ): ExtensionReport {
    if (this.entries.has(extension.id)) throw new Error("extension_already_added");
    if (this.entries.size >= MAX_EXTENSIONS) throw new Error("extension_list_full");
    const entry: Entry<Projection> = { id: extension.id, controller: new AbortController(), state: "off" };
    this.entries.set(extension.id, entry);
    if (!options.enabled) return this.reportOf(entry);
    let settings: Settings;
    try {
      settings = extension.settings.schema.parse(options.settings);
    } catch {
      return this.degrade(entry, "settings_invalid");
    }
    const host: Partial<Pick<Ports, Need>> = {};
    for (const need of extension.needs) host[need] = this.ports[need];
    try {
      entry.runtime = extension.create(Object.freeze(host as Pick<Ports, Need>), settings);
      entry.state = "stopped";
    } catch {
      return this.degrade(entry, "create_failed");
    }
    return this.reportOf(entry);
  }

  /** Starts every created extension, each in its own boundary. Resolves when all have settled. */
  public async start(): Promise<readonly ExtensionReport[]> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const runtime = entry.runtime;
        if (runtime === undefined || entry.state !== "stopped") return;
        entry.state = "starting";
        try {
          await runtime.start(entry.controller.signal);
          if (entry.state !== "starting") return;
          const projection = runtime.projection?.();
          if (projection !== undefined) entry.projection = projection;
          entry.state = "running";
        } catch {
          this.degrade(entry, "start_failed");
        }
      }),
    );
    return this.report();
  }

  /** Reads each extension's health; one that turned unhealthy loses its projection. */
  public async report(): Promise<readonly ExtensionReport[]> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (entry.state !== "running" || entry.runtime === undefined) return;
        let health: ExtensionHealth;
        try {
          health = await entry.runtime.health();
        } catch {
          health = { state: "degraded", reason: "health_failed" };
        }
        if (health.state === "degraded" && entry.state === "running") this.degrade(entry, health.reason);
      }),
    );
    return [...this.entries.values()].map((entry) => this.reportOf(entry));
  }

  /** The last known state of every extension, without reading health. */
  public snapshot(): readonly ExtensionReport[] {
    return [...this.entries.values()].map((entry) => this.reportOf(entry));
  }

  /** What the running extensions add to the core's tools, routes and commands. */
  public projections(): readonly Projection[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.state === "running" && entry.projection !== undefined ? [entry.projection] : [],
    );
  }

  /**
   * Stops the named extensions, or every one, so the composition root can keep
   * each extension's place in its shutdown order.
   */
  public async stop(ids?: readonly string[]): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        if (ids !== undefined && !ids.includes(entry.id)) return;
        entry.controller.abort();
        if (entry.runtime === undefined || entry.state === "off") return;
        delete entry.projection;
        try {
          await entry.runtime.stop();
        } catch {
          // Stopping is best effort at shutdown; the reason is already logged by the extension.
        }
        if (entry.state !== "degraded") entry.state = "stopped";
      }),
    );
  }

  private degrade(entry: Entry<Projection>, reason: string): ExtensionReport {
    entry.state = "degraded";
    entry.reason = reason;
    delete entry.projection;
    try {
      this.onDegraded(entry.id, reason);
    } catch {
      // A logging failure never reaches the fleet.
    }
    return this.reportOf(entry);
  }

  private reportOf(entry: Entry<Projection>): ExtensionReport {
    return entry.reason === undefined
      ? { id: entry.id, state: entry.state }
      : { id: entry.id, state: entry.state, reason: entry.reason };
  }
}
