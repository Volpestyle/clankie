import { statSync, type BigIntStats } from "node:fs";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  ClankieSettingsSchema,
  assertNoSecretShapedValue,
  dropRetiredSettings,
  migrateLegacyFleetWorkingPreferences,
  emptySettings,
  LinearWakeSettingsSchema,
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptySettings();
      // Permission and I/O failures must not replace narrowed authority with defaults.
      throw error;
    }
    return this.parse(raw);
  }

  /** Read one file generation; its final freshness check must run without an intervening await. */
  public async loadFenced(): Promise<{ settings: ClankieSettings; assertCurrent(): void }> {
    const changed = () => new Error(`settings_changed: ${this.filePath}`);
    const same = (a: BigIntStats, b: BigIntStats) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs;
    let file;
    try {
      file = await open(this.filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        settings: emptySettings(),
        assertCurrent: () => {
          try {
            statSync(this.filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw error;
          }
          throw changed();
        },
      };
    }
    try {
      // The identity belongs to the descriptor that supplied the bytes, not
      // the path, which an atomic settings update may already have replaced.
      const before = await file.stat({ bigint: true });
      const raw = await file.readFile("utf8");
      const after = await file.stat({ bigint: true });
      if (!same(before, after)) throw changed();
      return {
        settings: this.parse(raw),
        assertCurrent: () => {
          if (!same(after, statSync(this.filePath, { bigint: true }))) throw changed();
        },
      };
    } finally {
      await file.close();
    }
  }

  private parse(raw: string): ClankieSettings {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`settings_file_invalid_json: ${this.filePath}`);
    }
    // A malformed settings file fails loudly rather than silently reverting to
    // defaults, which would quietly widen an allowlist the operator narrowed.
    // Retired sections, unchanged legacy Linear defaults and legacy working
    // preferences migrate on read; the next ordinary write persists the format.
    return machineSettings(
      migrateLegacyFleetWorkingPreferences(migrateLinearWakeDefaults(dropRetiredSettings(parsed))),
    );
  }

  /** Apply a transform atomically under a serialized queue. */
  public update(
    mutate: (current: ClankieSettings) => ClankieSettings,
    guard?: () => Promise<void>,
  ): Promise<ClankieSettings> {
    const run = async (): Promise<ClankieSettings> => {
      const current = await this.load();
      const next = machineSettings(mutate(current), current);
      assertNoSecretShapedValue(next);
      await this.persist(next, guard);
      return next;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async persist(settings: ClankieSettings, guard?: () => Promise<void>): Promise<void> {
    const parentDirectory = dirname(this.filePath);
    await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
    await chmod(parentDirectory, 0o700);
    const temporaryPath = `${this.filePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(storedMachineSettings(settings), null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await guard?.();
      await rename(temporaryPath, this.filePath);
      const directory = await open(parentDirectory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    await chmod(this.filePath, 0o600);
  }
}

const LegacyLinearWakeSettingsSchema = LinearWakeSettingsSchema.omit({ ownerUserEmails: true }).required();

/** Owner IDs record setup identity; only unchanged legacy event rules migrate. */
function migrateLinearWakeDefaults(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const settings = parsed as Record<string, unknown>;
  const webhook = settings.linearWebhook;
  if (webhook === null || typeof webhook !== "object" || Array.isArray(webhook)) return parsed;
  const value = webhook as Record<string, unknown>;
  // The strict old shape lacks ownerUserEmails. Its presence marks the new
  // format, including a later deliberate choice to allow all event types.
  const legacy = LegacyLinearWakeSettingsSchema.safeParse(value.wake);
  if (!legacy.success) return parsed;
  const wake = legacy.data;
  if (
    wake.actors.length !== 1 ||
    wake.actors[0] !== "owner" ||
    wake.userIds.length !== 0 ||
    wake.notificationTypes.length !== 0 ||
    wake.excludedNotificationTypes.length !== 1 ||
    wake.excludedNotificationTypes[0] !== "issueSubscribed"
  )
    return parsed;
  return {
    ...settings,
    linearWebhook: {
      ...value,
      wake: LinearWakeSettingsSchema.parse({ ownerUserIds: wake.ownerUserIds }),
    },
  };
}

/** Materialize compatibility views; only machines own SSH transport on disk. */
function machineSettings(raw: unknown, previous?: ClankieSettings): ClankieSettings {
  const data = structuredClone(raw) as ClankieSettings;
  data.machines ??= [];
  data.agentHosts ??= { connections: [] };
  data.execution ??= { connections: [] };
  if (new Set(data.agentHosts.connections.map((host) => host.id)).size !== data.agentHosts.connections.length)
    throw new Error("Agent host IDs must be unique");
  if (new Set(data.machines.map((machine) => machine.id)).size !== data.machines.length)
    throw new Error("Machine IDs must be unique");
  // Old host writers remain aliases, including deletion. Never redirect an existing ID.
  if (previous && JSON.stringify(data.agentHosts) !== JSON.stringify(previous.agentHosts)) {
    const removed = previous.agentHosts.connections.filter(
      (old) => !data.agentHosts.connections.some((host) => host.id === old.id),
    );
    data.machines = data.machines.filter(
      (machine) => !removed.some((host) => machine.id === host.id || machine.aliases.includes(host.id)),
    );
    data.execution.connections = data.execution.connections.filter(
      (connection) =>
        !removed.some(
          (host) =>
            previous.machines
              .find((machine) => machine.id === connection.machine)
              ?.aliases.includes(host.id) || connection.machine === host.id,
        ),
    );
  }
  function register(id: string, ssh: string, shell: "posix" | "powershell", transcript: boolean) {
    let machine = data.machines.find((entry) => entry.ssh === ssh && entry.shell === shell);
    if (!machine) {
      let name = id;
      let suffix = 2;
      while (data.machines.some((entry) => entry.id === name)) name = `${id.slice(0, 58)}-${suffix++}`;
      machine = { id: name, ssh, shell, aliases: [] };
      data.machines.push(machine);
    }
    if (transcript && id !== machine.id && !machine.aliases.includes(id)) machine.aliases.push(id);
    return machine;
  }
  for (const host of data.agentHosts.connections) register(host.id, host.ssh, host.shell, true);
  for (const connection of data.execution.connections) {
    if (connection.ssh)
      connection.machine = register(connection.id, connection.ssh.host, connection.ssh.shell, false).id;
    else if (connection.machine && connection.machine !== "local") {
      const machine = data.machines.find((entry) => entry.id === connection.machine);
      if (!machine) throw new Error(`Unknown machine ${connection.machine}`);
      connection.ssh = { host: machine.ssh, shell: machine.shell };
    } else connection.machine = "local";
  }
  data.agentHosts.connections = data.machines.flatMap(({ id, ssh, shell, aliases }) =>
    [id, ...aliases].map((name) => ({ id: name, ssh, shell })),
  );
  return ClankieSettingsSchema.parse(data);
}

function storedMachineSettings(settings: ClankieSettings) {
  const { agentHosts: _hosts, ...stored } = structuredClone(settings);
  for (const connection of stored.execution.connections) delete connection.ssh;
  return stored;
}
