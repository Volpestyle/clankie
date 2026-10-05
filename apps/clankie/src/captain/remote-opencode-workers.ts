import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFile, type ChildProcess, type spawn } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import type { HerdrBinding } from "@clankie/protocol";
import type { AgentHostConnection } from "@clankie/settings";
import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import type { OpenCodeHistorySource, OpenCodeHistorySnapshot } from "../opencode-history.ts";
import type { OpenCodeWorkerProfile } from "../opencode-profiles.ts";
import { clientPid } from "../local-fleet-proof.ts";
import { splitFleetQualified, type HerdrFleet, type FleetShellRun } from "../herdr-fleet.ts";
import { createOpenCodeNativeHost } from "./opencode-native-host.ts";
import { createOpenCodeSeatAdapter } from "./opencode-seat-adapter.ts";
import type { OpenCodeCommandTab } from "./opencode-native-host.ts";
import {
  remoteOpenCodeAssets,
  startRemoteOpenCodeRpc,
  openRemoteOpenCodeTunnel,
} from "./remote-opencode-transport.ts";

const execute = promisify(execFile);
const Profile = z
  .object({
    profileId: z.string().regex(/^profile-[A-Za-z0-9]+$/u),
    directory: z.string().startsWith("/"),
    database: z.string().startsWith("/"),
  })
  .strict();
const Binding = z
  .object({
    socketPath: z.string().startsWith("/"),
    session: z.string(),
    runtime: z.enum(["external", "bundled"]),
  })
  .strict();
const Config = z
  .object({ directory: z.string().startsWith("/"), env: z.record(z.string(), z.string()) })
  .strict();
const Source = z
  .object({
    kind: z.literal("opencode-sqlite"),
    machineId: z.literal("local"),
    profileId: z.string().regex(/^profile-[A-Za-z0-9]+$/u),
    database: z.string().startsWith("/"),
    databaseIdentity: z.string().regex(/^\d+:\d+$/u),
    sessionId: z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u),
    version: z.literal("1.18.18"),
    workingDirectory: z.string().startsWith("/"),
  })
  .strict();
interface Options {
  repoRoot: string;
  stateDir: string;
  fleets(): Promise<readonly HerdrFleet[]>;
  shell(fleet: HerdrFleet): FleetShellRun;
  stream(fleet: HerdrFleet): (command: string) => ChildProcess;
  /** OS/SSH seams for integration fixtures only. */
  spawn?: typeof spawn;
  localRun?: (file: string, args: readonly string[]) => Promise<string>;
  timeoutMs?: number;
}
interface Entry {
  close(): Promise<void>;
  adapter: HarnessSeatAdapter;
  createCommandTab(input: OpenCodeCommandTab): Promise<string>;
  read(sessionId: string, options?: { tail?: number; after?: string }): Promise<OpenCodeHistorySnapshot>;
  resolve(sessionId: string): Promise<OpenCodeHistorySource>;
  list(limit?: number): Promise<OpenCodeHistorySnapshot[]>;
}
interface CachedEntry {
  fleetId: string;
  identity: string;
  revision: number;
  entry: Entry;
}

/** The configured SSH target, original controller and native root are all required. */
export class RemoteOpenCodeWorkers {
  private readonly entries = new Map<string, CachedEntry>();
  private readonly revisions = new Map<string, number>();
  private readonly retiring = new Set<Promise<void>>();
  private assets: ReturnType<typeof remoteOpenCodeAssets> | undefined;
  private origin: Promise<string> | undefined;
  private closed = false;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  private originId() {
    return (this.origin ??= (async () => {
      const root = join(this.options.stateDir, "opencode-workers");
      await mkdir(root, { recursive: true, mode: 0o700 });
      const path = join(root, "remote-origin");
      try {
        const value = await readFile(path, "utf8");
        if (!/^[a-f0-9]{32}$/u.test(value)) throw new Error("Remote native origin identity unavailable");
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const value = randomUUID().replaceAll("-", "");
        await writeFile(path, value, { flag: "wx", mode: 0o600 });
        return value;
      }
    })());
  }
  async hosts(): Promise<AgentHostConnection[]> {
    return (await this.options.fleets())
      .filter((fleet) => fleet.ssh.shell === "posix")
      .map((fleet) => ({ id: fleet.id, ssh: fleet.ssh.host, shell: fleet.ssh.shell }));
  }
  private retire(key: string, cached: CachedEntry) {
    this.entries.delete(key);
    const closing = cached.entry.close();
    this.retiring.add(closing);
    void closing.then(
      () => this.retiring.delete(closing),
      () => this.retiring.delete(closing),
    );
  }
  forFleet(fleet: HerdrFleet, admission: () => Promise<void>, revision = 0): Entry {
    if (revision < (this.revisions.get(fleet.id) ?? 0))
      throw new Error("Remote native fleet revision is retired");
    this.revisions.set(fleet.id, revision);
    return this.entry(fleet, admission, revision, "seat");
  }
  private entry(
    fleet: HerdrFleet,
    admission: () => Promise<void>,
    revision: number,
    kind: "seat" | "history",
  ): Entry {
    if (this.closed) throw new Error("Remote native worker transports are closed");
    const identity = JSON.stringify(fleet);
    for (const [key, cached] of this.entries)
      if (cached.fleetId === fleet.id && (cached.revision < revision || cached.identity !== identity))
        this.retire(key, cached);
    // History never captures Captain's admission, and cannot lend its read-only
    // admission to prepared seat RPCs. Revisions retire both domains together.
    const key = JSON.stringify(kind === "history" ? [kind, fleet] : [kind, fleet, revision]);
    const existing = this.entries.get(key);
    if (existing) return existing.entry;
    let retired = false;
    let closing: Promise<void> | undefined;
    const guard = async () => {
      if (retired) throw new Error("Remote native fleet revision is retired");
      if (this.closed) throw new Error("Remote native worker transports are closed");
      await admission();
      const latest = (await this.options.fleets()).find((value) => value.id === fleet.id);
      if (
        retired ||
        this.closed ||
        !latest ||
        JSON.stringify(latest) !== identity ||
        fleet.ssh.shell !== "posix"
      )
        throw new Error("Remote OpenCode machine changed or disconnected; no local fallback");
    };
    let boot: ReturnType<typeof startRemoteOpenCodeRpc> | undefined;
    let transport: Awaited<NonNullable<typeof boot>> | undefined;
    const connect = () =>
      (boot ??= (async () => {
        await guard();
        const origin = createHash("sha256")
          .update(await this.originId())
          .update(identity)
          .digest("hex")
          .slice(0, 32);
        const assets = await (this.assets ??= remoteOpenCodeAssets(
          this.options.repoRoot,
          this.options.stateDir,
        ));
        const connected = await startRemoteOpenCodeRpc({
          fleet,
          shell: this.options.shell(fleet),
          stream: this.options.stream(fleet),
          guard,
          originId: origin,
          assets,
        });
        if (retired || this.closed) {
          connected.rpc.close();
          throw new Error("Remote native fleet revision is retired");
        }
        transport = connected;
        return connected;
      })());
    const call = async (method: string, input: unknown = null) => {
      await guard();
      const value = await (await connect()).rpc.request(method, input, this.options.timeoutMs);
      await guard();
      return value;
    };
    const tunnels = new Map<number, Awaited<ReturnType<typeof openRemoteOpenCodeTunnel>>>();
    const controllers = new Map<number, Parameters<typeof openRemoteOpenCodeTunnel>[0]["controller"]>();
    const localRun =
      this.options.localRun ??
      (async (file, args) =>
        (await execute(file, [...args], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    const host = createOpenCodeNativeHost({
      platform: "darwin",
      fleet: fleet.id,
      binding: async () => Binding.parse(await call("binding")),
      processHelper: "", // The helper address is selected from the owned remote asset receipt.
      ownerUid: async () => (await connect()).uid,
      canonical: async (path) =>
        z
          .string()
          .startsWith("/")
          .parse(await call("canonical", path)),
      run: async (file, args) =>
        z.string().parse(
          await call("observe", {
            file,
            args:
              file === "/usr/bin/python3"
                ? ["-I", join((await connect()).root, "process-birth.py"), args[2]]
                : args,
          }),
        ),
      request: async (binding: HerdrBinding, method, params) => call("request", { binding, method, params }),
      socketOwner: async (socket, pid) => {
        const tunnel = tunnels.get(socket.localPort!);
        if (!tunnel?.alive() || !socket.remotePort) return false;
        // Both ends must be owned: the exact private SSH child here, and the
        // captured native foreground root on the other Mac. A bearer is insufficient.
        const local = await localRun("/usr/sbin/lsof", [
          "-nP",
          "-a",
          "-iTCP:" + socket.localPort,
          "-sTCP:ESTABLISHED",
          "-Fpn",
        ]);
        if (clientPid(local, socket.remotePort, socket.localPort!) !== tunnel.pid) return false;
        const remote = z.string().parse(await call("socket", tunnel.port));
        const owners = new Set<number>();
        let currentPid: number | undefined;
        for (const line of remote.split("\n")) {
          if (/^p\d+$/u.test(line)) currentPid = Number(line.slice(1));
          if (
            new RegExp("^n127\\.0\\.0\\.1:\\d+->127\\.0\\.0\\.1:" + tunnel.port + "$", "u").test(line) &&
            currentPid
          )
            owners.add(currentPid);
        }
        return tunnel.alive() && owners.size === 1 && owners.has(pid);
      },
    });
    const native = {
      createCommandTab: host.createCommandTab,
      capture: (paneId: string, executable: string, cwd: string) => {
        const pane = splitFleetQualified(paneId);
        if (!pane || pane.fleet !== fleet.id) throw new Error("Remote native pane belongs to another fleet");
        return host.capture(pane.id, executable, cwd);
      },
    };
    const adapter = createOpenCodeSeatAdapter({
      repoRoot: this.options.repoRoot,
      stateDir: join(
        this.options.stateDir,
        "remote-opencode",
        createHash("sha256").update(identity).digest("hex"),
      ),
      native,
      ...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
      discover: async (launch) => {
        const selected = z
          .object({
            executable: z.string().startsWith("/"),
            version: z.literal("1.18.18"),
            cwd: z.string().startsWith("/"),
          })
          .parse(await call("discover", { cwd: launch.cwd }));
        if (selected.cwd !== launch.cwd) throw new Error("Remote native working directory must be canonical");
        return selected;
      },
      profiles: {
        allocate: async () => Profile.parse(await call("allocate")) as OpenCodeWorkerProfile,
        register: async (profile, sessionId, cwd, verify) => {
          await verify();
          Source.parse(await call("register", { profileId: profile.profileId, sessionId, cwd }));
          await verify();
        },
      },
      configure: async (launch, profile, controller) => {
        const tunnel = await openRemoteOpenCodeTunnel({
          fleet,
          controller,
          guard,
          ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
          ...(this.options.timeoutMs ? { timeoutMs: this.options.timeoutMs } : {}),
        });
        const port = Number(new URL(controller.endpoint).port);
        tunnels.set(port, tunnel);
        controllers.set(port, controller);
        try {
          const config = Config.parse(
            await call("configure", {
              profileId: profile.profileId,
              env: launch.env ?? {},
              endpoint: "ws://127.0.0.1:" + tunnel.port + "/worker",
              token: controller.token,
            }),
          );
          await guard();
          if (!tunnel.alive()) throw new Error("Remote native forward disconnected during configuration");
          return {
            env: config.env,
            cwd: launch.cwd,
            retire: async () => {
              tunnels.delete(port);
              controllers.delete(port);
              tunnel.close();
              await call("retire", config.directory);
            },
          };
        } catch (error) {
          tunnels.delete(port);
          controllers.delete(port);
          tunnel.close();
          throw error;
        }
      },
    });
    const source = (value: unknown): OpenCodeHistorySource => ({
      ...Source.parse(value),
      machineId: fleet.id,
    });
    const snapshot = (value: unknown): OpenCodeHistorySnapshot => {
      // Shared native projection is produced by the shipped helper. Check its
      // metadata and entries again before it crosses the API boundary.
      const page = z
        .object({
          source: Source,
          title: z.string(),
          modifiedAt: z.string(),
          entries: z.array(SeatTranscriptUploadSchema.shape.entries.element),
          cursor: z.string(),
          projectionBytes: z
            .number()
            .int()
            .max(4 * 1024 * 1024),
          scope: z.literal("stored-v1-export"),
          stagedRevert: z.boolean(),
        })
        .passthrough()
        .parse(value);
      return { ...page, source: source(page.source) } as OpenCodeHistorySnapshot;
    };
    const entry: Entry = {
      close: () => {
        if (closing) return closing;
        // Revoke synchronously before any await; an in-flight old generation
        // must not revive after a same-target drop/return. Kill only owned IO.
        retired = true;
        transport?.rpc.close();
        for (const tunnel of tunnels.values()) tunnel.close();
        tunnels.clear();
        const active = [...controllers.values()];
        controllers.clear();
        closing = (async () => {
          await Promise.allSettled(active.map((controller) => controller.close()));
          if (boot) await boot.then((value) => value.rpc.close()).catch(() => {});
        })();
        return closing;
      },
      adapter,
      createCommandTab: native.createCommandTab,
      resolve: async (sessionId) => {
        const value = source(await call("resolve", sessionId));
        if (value.sessionId !== sessionId) throw new Error("Remote native session source changed");
        return value;
      },
      read: async (sessionId, options = {}) => {
        const value = snapshot(await call("read", { sessionId, options }));
        if (value.source.sessionId !== sessionId) throw new Error("Remote native history source changed");
        return value;
      },
      list: async (limit = 20) =>
        z
          .array(z.unknown())
          .parse(await call("list", limit))
          .map(snapshot),
    };
    this.entries.set(key, { fleetId: fleet.id, identity, revision, entry });
    return entry;
  }
  private async history(hostId: string) {
    const fleet = (await this.options.fleets()).find((value) => value.id === hostId);
    if (!fleet) throw new Error("Unknown remote native OpenCode host; no local fallback");
    return this.entry(fleet, async () => {}, this.revisions.get(hostId) ?? 0, "history");
  }
  async list(hostId: string, limit = 20) {
    return (await this.history(hostId)).list(limit);
  }
  async read(hostId: string, sessionId: string, options: { tail?: number; after?: string } = {}) {
    return (await this.history(hostId)).read(sessionId, options);
  }
  async resolve(hostId: string, sessionId: string) {
    const host = (await this.hosts()).find((value) => value.id === hostId);
    if (!host) throw new Error("Unknown remote native OpenCode host");
    const source = await (await this.history(hostId)).resolve(sessionId);
    return {
      ref: hostId + ":" + sessionId,
      host,
      sessionId,
      workingDirectory: source.workingDirectory,
      source,
    };
  }
  async close() {
    this.closed = true;
    for (const [key, cached] of this.entries) this.retire(key, cached);
    await Promise.allSettled(this.retiring);
  }
}
