/** Integration-owned Paper process, auth provisioning and private RCON. */
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, rm, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createDefaultCredentialStore, type CredentialStore } from "@clankie/credential-broker";
import { z } from "zod";

const exec = promisify(execFile);
import {
  MinecraftHostAdminCommandSchema,
  MinecraftHostUsernameSchema,
  MinecraftHostSettingsSchema,
  type MinecraftHostAdminCommand,
} from "@clankie/protocol";
const username = MinecraftHostUsernameSchema;
export const HostAdminSchema = MinecraftHostAdminCommandSchema;
type HostAdmin = MinecraftHostAdminCommand;
export function serializeHostAdmin(input: unknown): string {
  const c = HostAdminSchema.parse(input);
  switch (c.operation) {
    case "whitelist_add":
      return `whitelist add ${c.username}`;
    case "whitelist_remove":
      return `whitelist remove ${c.username}`;
    case "kick":
    case "ban":
      return `${c.operation} ${c.username}${c.reason ? ` ${c.reason}` : ""}`;
    case "pardon":
      return `pardon ${c.username}`;
    case "gamerule":
      return `gamerule ${c.rule} ${c.value}`;
    case "time":
      return `time set ${c.value}`;
    case "weather":
      return `weather ${c.value}${c.durationSeconds ? ` ${c.durationSeconds}s` : ""}`;
    case "gamemode":
      return `gamemode ${c.value} ${c.username}`;
    case "say":
      return `say ${c.text}`;
    case "tell":
      return `tell ${c.username} ${c.text}`;
    case "list":
      return "list";
  }
}
const PAPER = {
  file: "paper.jar",
  sha256: "5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc",
  url: "https://fill-data.papermc.io/v1/objects/5ee4f542f628a14c644410b08c94ea42e772ef4d29fe92973636b6813d4eaffc/paper-1.21.4-232.jar",
};
const HOST_ARTIFACTS = [
  PAPER,
  {
    file: "plugins/FastLoginBukkit.jar",
    sha256: "f758d0c3be28990860d334c9ce79b2f342c998f7d2fb4c423d41f1479a58671a",
    url: "https://github.com/TuxCoding/FastLogin/releases/download/1.12-kick-toggle/FastLoginBukkit.jar",
  },
  {
    file: "plugins/ProtocolLib.jar",
    sha256: "ee2e7ab9b5386f2d103081c4d108e61b1035df2ca692b53d6e2409fb1f5caccf",
    url: "https://github.com/dmulloy2/ProtocolLib/releases/download/5.4.0/ProtocolLib.jar",
  },
  {
    file: "plugins/AuthMe.jar",
    sha256: "80371ba80087c14e49fad908c581ea7677943db4b968760c053d3bb0d26764d1",
    url: "https://github.com/AuthMe/AuthMeReloaded/releases/download/5.6.0/AuthMe-5.6.0.jar",
  },
] as const;
const BOT_PROVIDER = "clankie_minecraft_host_bot";
const RCON_PROVIDER = "clankie_minecraft_host_rcon";
const BOT = "ClankieLocal26";
type HostStatus = {
  phase: "stopped" | "starting" | "running" | "stopping" | "backoff" | "failed";
  authReady: boolean;
  version: "1.21.4";
  gamePort: number;
  botUsername: string;
  retryAt?: number;
  failure?: string;
  gameEndpoint: { host: "127.0.0.1"; port: number; version: "1.21.4"; username: string; auth: "offline" };
  lastBackup?: { filename: string; at: number };
  eulaApprovedAt: "2026-10-04";
};
type HostOptions = {
  dataDir?: string;
  gamePort?: number;
  rconPort?: number;
  java?: string;
  memoryMiB?: number;
  credentials?: CredentialStore;
  fetch?: typeof fetch;
  spawn?: typeof spawn;
  command?: (command: string) => Promise<string>;
  backupIntervalMs?: number;
  retention?: number;
  codeTtlMs?: number;
  idleTimeoutMs?: number;
  maxUptimeMs?: number;
  onUnavailable?: () => Promise<void>;
};
const HostConfigurationSchema = MinecraftHostSettingsSchema.refine(
  (settings) => settings.gamePort !== settings.rconPort,
  "Minecraft ports must differ",
);
export const HostConfigurationPatchSchema = MinecraftHostSettingsSchema.partial();
type HostConfiguration = z.infer<typeof HostConfigurationSchema>;
/** Replaceable host lifecycle boundary; this wave supplies only the local Paper implementation. */
export interface MinecraftHostingPort {
  readonly dataDir: string;
  status(): HostStatus;
  configuration(): Promise<HostConfiguration>;
  configure(patch: unknown): Promise<HostConfiguration>;
  start(): Promise<HostStatus>;
  stop(): Promise<HostStatus>;
  restart(): Promise<HostStatus>;
  backup(): Promise<HostStatus["lastBackup"]>;
  admin(command: unknown): Promise<{ command: HostAdmin; outcome: string; players?: string[] }>;
  enroll(
    username: string,
  ): Promise<{ username: string; classification: "premium" | "nonpremium"; providerId?: string }>;
  revokeCode(username: string): Promise<{ revoked: boolean }>;
  botLogin(endpoint: { host: string; port: number; username: string }): Promise<string | null>;
}
/** This method deliberately never returns secrets or raw RCON responses to MCP. */
export class MinecraftHost implements MinecraftHostingPort {
  readonly dataDir: string;
  private readonly options: HostOptions;
  private readonly credentials: CredentialStore;
  private settings: HostConfiguration;
  private loadedSettings = false;
  private child: ChildProcess | null = null;
  private state: HostStatus;
  private desired = false;
  private restarts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private rconPassword = "";
  private botPassword = "";
  private sensitive = new Set<string>();
  private codes = new Map<
    string,
    { provider: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }
  >();
  private enrolled = new Set<string>();
  private runStartedAt = 0;
  private runGeneration = 0;
  private lastOccupiedAt = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private checkingIdle = false;
  constructor(options: HostOptions = {}) {
    this.options = options;
    this.credentials = options.credentials ?? createDefaultCredentialStore();
    this.settings = HostConfigurationSchema.parse({
      gamePort: 25684,
      rconPort: 25685,
      memoryMiB: 1024,
      backupIntervalMs: 86400000,
      backupRetention: 7,
      idleTimeoutMs: 900000,
      maxUptimeMs: 21600000,
      ...Object.fromEntries(
        Object.entries(options).filter(
          ([key, value]) =>
            [
              "gamePort",
              "rconPort",
              "java",
              "memoryMiB",
              "backupIntervalMs",
              "idleTimeoutMs",
              "maxUptimeMs",
            ].includes(key) && value !== undefined,
        ),
      ),
      ...(options.retention ? { backupRetention: options.retention } : {}),
    });
    this.dataDir = options.dataDir ?? join(homedir(), ".local", "share", "clankie", "minecraft-host");
    for (const timeout of [options.idleTimeoutMs, options.maxUptimeMs, options.codeTtlMs])
      if (timeout !== undefined) z.number().int().min(100).max(86400000).parse(timeout);
    const gamePort = z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .parse(options.gamePort ?? 25684);
    const rconPort = z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .parse(options.rconPort ?? 25685);
    if (gamePort === rconPort) throw new Error("Minecraft host ports must differ");
    this.state = {
      phase: "stopped",
      authReady: false,
      version: "1.21.4",
      gamePort,
      botUsername: BOT,
      eulaApprovedAt: "2026-10-04",
      gameEndpoint: { host: "127.0.0.1", port: gamePort, version: "1.21.4", username: BOT, auth: "offline" },
    };
  }
  status(): HostStatus {
    return structuredClone(this.state);
  }
  private async loadSettings(): Promise<void> {
    if (this.loadedSettings) return;
    try {
      this.settings = HostConfigurationSchema.parse(
        JSON.parse(await readFile(join(this.dataDir, "settings.json"), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Minecraft host settings invalid");
    }
    this.loadedSettings = true;
    this.state.gamePort = this.settings.gamePort;
    this.state.gameEndpoint.port = this.settings.gamePort;
  }
  async configuration(): Promise<HostConfiguration> {
    await this.loadSettings();
    return structuredClone(this.settings);
  }
  configure(patch: unknown): Promise<HostConfiguration> {
    return this.serial(async () => {
      if (this.child || !["stopped", "failed"].includes(this.state.phase) || this.desired)
        throw new Error("Stop Minecraft host before configuring it");
      await this.loadSettings();
      const updates = HostConfigurationPatchSchema.parse(patch);
      const settings = HostConfigurationSchema.parse({ ...this.settings, ...updates });
      await this.privateWrite("settings.json", JSON.stringify(settings, null, 2) + "\n");
      this.settings = settings;
      this.state.gamePort = settings.gamePort;
      this.state.gameEndpoint.port = settings.gamePort;
      return structuredClone(settings);
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private async secret(id: string): Promise<string> {
    let credential = await this.credentials.get(id);
    if (!credential) {
      await this.credentials.set(id, { type: "api", key: randomBytes(12).toString("hex") });
      credential = await this.credentials.get(id);
    }
    if (credential?.type !== "api" || !/^[0-9a-f]{24}$/u.test(credential.key))
      throw new Error("Minecraft host broker credential invalid");
    this.sensitive.add(credential.key);
    return credential.key;
  }
  private async privateWrite(file: string, value: string): Promise<void> {
    const path = join(this.dataDir, file);
    await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${path}.new`;
    await writeFile(temporary, value, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  }
  async prepare(): Promise<void> {
    await this.loadSettings();
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await chmod(this.dataDir, 0o700);
    for (const artifact of HOST_ARTIFACTS) {
      const path = join(this.dataDir, artifact.file);
      let data: Buffer | undefined;
      try {
        data = await readFile(path);
      } catch {}
      if (data && createHash("sha256").update(data).digest("hex") !== artifact.sha256)
        throw new Error("Minecraft pinned artifact checksum mismatch");
      if (!data) {
        const response = await (this.options.fetch ?? fetch)(artifact.url, {
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok || Number(response.headers.get("content-length")) > 100 * 1024 * 1024)
          throw new Error("Minecraft pinned artifact download failed");
        data = Buffer.from(await response.arrayBuffer());
        if (
          data.length > 100 * 1024 * 1024 ||
          createHash("sha256").update(data).digest("hex") !== artifact.sha256
        )
          throw new Error("Minecraft pinned artifact checksum mismatch");
        await mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
        await writeFile(`${path}.new`, data, { mode: 0o600 });
        await rename(`${path}.new`, path);
      }
    }
    this.rconPassword = await this.secret(RCON_PROVIDER);
    this.botPassword = await this.secret(BOT_PROVIDER);
    await this.privateWrite("eula.txt", "# Owner James accepted 2026-10-04\neula=true\n");
    await this.privateWrite(
      "server.properties",
      [
        "server-ip=127.0.0.1",
        `server-port=${this.state.gameEndpoint.port}`,
        "online-mode=false",
        "enforce-secure-profile=false",
        "white-list=true",
        "enforce-whitelist=true",
        "enable-query=false",
        "enable-rcon=true",
        `rcon.port=${this.settings.rconPort}`,
        `rcon.password=${this.rconPassword}`,
        "broadcast-rcon-to-ops=false",
        "broadcast-console-to-ops=false",
        "log-admin-commands=false",
        "spawn-protection=0",
        "view-distance=6",
        "simulation-distance=4",
        "difficulty=normal",
        "gamemode=survival",
        "max-players=12",
        "motd=Clankie's Minecraft world",
        "",
      ].join("\n"),
    );
    await this.privateWrite(
      "config/paper-global.yml",
      "_version: 29\nproxies:\n  proxy-protocol: true\n  velocity:\n    enabled: false\n",
    );
    await this.privateWrite(
      "plugins/FastLogin/config.yml",
      "autoRegister: true\nsecondAttemptCracked: false\nswitchMode: false\npremiumUuid: false\nnameChangeCheck: false\nforwardSkin: true\nautoLogin: true\nuseProxyAgnosticResolver: true\nverifyClientKeys: false\nauto-register-unknown: false\nautoLoginFloodgate: false\nallowFloodgateNameConflict: false\nautoRegisterFloodgate: false\nmojang-request-limit: 600\nantibot:\n  enabled: true\n  connections: 100\n  expire: 10\n  action: block\nanti-bot:\n  enabled: true\n  connections: 100\n  expire: 10\n  action: block\ndriver: sqlite\ndatabase: '{pluginDir}/FastLogin.db'\n",
    );
    await this.privateWrite(
      "plugins/AuthMe/config.yml",
      `settings:\n  useAsyncTasks: false\n  sessions:\n    enabled: false\n  restrictions:\n    allowChat: false\n    allowMovement: false\n    ProtectInventoryBeforeLogIn: true\n    AllowRestrictedUser: true\n    AllowedRestrictedUser:\n    - '${BOT};127.0.0.1'\n    kickNonRegistered: false\n    timeout: 30\n    maxRegPerIp: 0\n    allowCommands:\n    - /login\n    - /l\n  registration:\n    enabled: false\n    force: true\n  security:\n    minPasswordLength: 12\n    passwordMaxLength: 30\n  unrestrictions:\n    UnrestrictedName: []\nProtection:\n  enableAntiBot: true\n`,
    );
    await this.privateWrite("ops.json", "[]\n");
  }
  private async java(): Promise<string> {
    const candidates = [
      this.settings.java,
      process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : undefined,
      "/opt/homebrew/opt/openjdk@21/bin/java",
      "java",
    ].filter((v): v is string => !!v);
    for (const file of candidates) {
      try {
        const { stderr } = await exec(file, ["-version"], { timeout: 5000 });
        if (/version "21[."]/u.test(stderr)) return file;
      } catch {}
    }
    throw new Error("Minecraft hosting requires Java 21");
  }
  start(): Promise<HostStatus> {
    return this.serial(async () => {
      if (!this.desired) {
        this.runGeneration++;
        this.runStartedAt = Date.now();
        this.lastOccupiedAt = this.runStartedAt;
        this.restarts = 0;
      }
      this.desired = true;
      await this.startNow();
      return this.status();
    });
  }
  private async startNow(): Promise<void> {
    if (this.child) {
      if (this.state.phase === "running") return;
      throw new Error("Minecraft server transition in progress");
    }
    this.state.phase = "starting";
    this.state.authReady = false;
    delete this.state.failure;
    delete this.state.retryAt;
    try {
      await this.options.onUnavailable?.();
      await this.prepare();
      if (Date.now() - this.runStartedAt >= this.settings.maxUptimeMs) {
        this.desired = false;
        this.state.phase = "stopped";
        return;
      }
      const classification = await this.classify(BOT);
      if (classification !== "offline") throw new Error("Minecraft bot name is now premium");
      const java = await this.java();
      const child = (this.options.spawn ?? spawn)(
        java,
        ["-Xms256M", `-Xmx${this.settings.memoryMiB}M`, "-jar", "paper.jar", "--nogui"],
        { cwd: this.dataDir, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
      );
      this.child = child;
      const done = new Promise<void>((resolve, reject) => {
        let tail = "";
        const timeout = setTimeout(() => reject(new Error("Minecraft server startup timeout")), 120000);
        let logLine = "";
        const consume = (chunk: Buffer) => {
          logLine += String(chunk);
          const lines = logLine.split("\n");
          logLine = lines.pop() ?? "";
          for (const line of lines) this.consumeAuthLog(line);
          tail = (tail + String(chunk)).slice(-32000);
          if (/Done \([\d.]+s\)!/u.test(tail)) {
            clearTimeout(timeout);
            resolve();
          }
        };
        child.stdout?.on("data", consume);
        child.stderr?.on("data", consume);
        child.once("error", () => {
          clearTimeout(timeout);
          reject(new Error("Minecraft server process failed"));
        });
        child.once("exit", () => {
          clearTimeout(timeout);
          reject(new Error("Minecraft server exited before readiness"));
        });
      });
      child.once("exit", () => {
        if (this.child !== child) return;
        this.child = null;
        this.state.authReady = false;
        if (this.watchdog) {
          clearInterval(this.watchdog);
          this.watchdog = null;
        }
        void this.options.onUnavailable?.().catch(() => {});
        if (this.backupTimer) {
          clearInterval(this.backupTimer);
          this.backupTimer = null;
        }
        if (!this.desired) {
          this.state.phase = "stopped";
          return;
        }
        if (++this.restarts > 5) {
          this.state.phase = "failed";
          this.state.failure = "restart_limit";
          this.desired = false;
          return;
        }
        const delay = Math.min(60000, 1000 * 2 ** this.restarts);
        this.state.phase = "backoff";
        this.state.retryAt = Date.now() + delay;
        this.timer = setTimeout(() => {
          this.timer = null;
          if (this.desired) void this.serial(() => this.startNow()).catch(() => {});
        }, delay);
        this.timer.unref();
      });
      await done;
      const plugins = await this.command("plugins");
      for (const name of ["AuthMe", "ProtocolLib", "FastLogin"])
        if (!plugins.includes(`§a${name}`)) throw new Error("Minecraft auth plugin readiness failed");
      await this.command(`authme register ${BOT} ${this.botPassword}`);
      const botRegistered = await this.command(`authme changepassword ${BOT} ${this.botPassword}`);
      if (!/changed|success/iu.test(botRegistered))
        throw new Error("Minecraft bot credential registration unverified");
      await this.command(`whitelist add ${BOT}`);
      for (const entry of this.codes.values()) clearTimeout(entry.timer);
      this.codes.clear();
      const pendingProviders = await this.credentials.list();
      for (const provider of Object.keys(pendingProviders).filter((id) =>
        id.startsWith("clankie_minecraft_friend_"),
      )) {
        const name = provider.slice("clankie_minecraft_friend_".length);
        username.parse(name);
        const replacement = randomBytes(12).toString("hex");
        this.sensitive.add(replacement);
        const revoked = await this.command(`authme changepassword ${name} ${replacement}`);
        if (!/changed|success/iu.test(revoked)) throw new Error("Minecraft stale code revocation failed");
        await this.credentials.delete(provider);
      }
      this.state.phase = "running";
      this.state.authReady = true;
      this.backupTimer = setInterval(() => {
        void this.backup().catch(() => {});
      }, this.settings.backupIntervalMs);
      this.backupTimer.unref();
      this.watchdog = setInterval(
        () => {
          void this.checkIdle();
        },
        Math.min(30000, Math.max(100, Math.min(this.settings.idleTimeoutMs, this.settings.maxUptimeMs) / 3)),
      );
      this.watchdog.unref();
    } catch {
      this.desired = false;
      await this.stopNow();
      this.state.phase = "failed";
      this.state.failure = "startup_failed";
      throw new Error("Minecraft hosted server failed to start safely");
    }
  }
  stop(): Promise<HostStatus> {
    this.desired = false;
    return this.serial(async () => {
      await this.stopNow();
      return this.status();
    });
  }
  private async stopNow(): Promise<void> {
    this.state.authReady = false;
    for (const entry of this.codes.values()) clearTimeout(entry.timer);
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    try {
      await this.options.onUnavailable?.();
    } catch {
      this.state.failure = "tunnel_stop_unconfirmed";
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer);
      this.backupTimer = null;
    }
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.child = null;
      this.state.phase = "stopped";
      return;
    }
    this.state.phase = "stopping";
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.stdin?.write("stop\n");
    let timer: ReturnType<typeof setTimeout>;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 30000);
      }),
    ]);
    clearTimeout(timer!);
    if (this.child === child) {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    }
    if (this.child === child) {
      child.kill("SIGKILL");
      await exited;
    }
    this.state.phase = "stopped";
  }
  restart(): Promise<HostStatus> {
    return this.serial(async () => {
      this.desired = false;
      await this.stopNow();
      this.desired = true;
      this.restarts = 0;
      this.runGeneration++;
      this.runStartedAt = Date.now();
      this.lastOccupiedAt = this.runStartedAt;
      await this.startNow();
      return this.status();
    });
  }
  private async checkIdle(): Promise<void> {
    if (this.checkingIdle || !this.desired || !this.state.authReady) return;
    this.checkingIdle = true;
    try {
      const response = await this.admin({ operation: "list" });
      if ((response.players?.length ?? 0) > 0) this.lastOccupiedAt = Date.now();
      if (
        hostShouldStop(
          Date.now(),
          this.runStartedAt,
          this.lastOccupiedAt,
          this.settings.idleTimeoutMs,
          this.settings.maxUptimeMs,
        )
      ) {
        const generation = this.runGeneration;
        this.desired = false;
        try {
          await this.backup();
        } finally {
          if (this.runGeneration === generation && !this.desired) await this.stop();
        }
      }
    } catch {
      /* Transient private RCON failure does not prove player absence. Max watchdog still bounds the run. */
      if (Date.now() - this.runStartedAt >= this.settings.maxUptimeMs) await this.stop().catch(() => {});
    } finally {
      this.checkingIdle = false;
    }
  }
  private requireReady(): void {
    if (!this.state.authReady || this.state.phase !== "running")
      throw new Error("Minecraft host is not auth-ready");
  }
  async classify(name: string): Promise<"premium" | "offline"> {
    username.parse(name);
    const response = await (this.options.fetch ?? fetch)(
      `https://api.mojang.com/users/profiles/minecraft/${name}`,
      { signal: AbortSignal.timeout(10000) },
    );
    if (response.status === 404 || response.status === 204) return "offline";
    if (response.status !== 200) throw new Error("Minecraft account classification unavailable");
    const profile = z
      .object({ name: username, id: z.string().regex(/^[a-f0-9]{32}$/u) })
      .parse(await response.json());
    if (profile.name.toLowerCase() !== name.toLowerCase())
      throw new Error("Minecraft account classification mismatch");
    return "premium";
  }
  private async verifyPremiumStored(name: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      let db: DatabaseSync | undefined;
      try {
        db = new DatabaseSync(join(this.dataDir, "plugins", "FastLogin", "FastLogin.db"), { readOnly: true });
        const row = db.prepare("SELECT Premium FROM premium WHERE LOWER(Name) = ?").get(name.toLowerCase());
        if (Number(row?.Premium) === 1) return;
      } catch {
      } finally {
        db?.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Minecraft forced-premium persistence unverified");
  }
  enroll(
    name: string,
  ): Promise<{ username: string; classification: "premium" | "nonpremium"; providerId?: string }> {
    return this.serial(async () => {
      this.requireReady();
      username.parse(name);
      if (name.toLowerCase() === BOT.toLowerCase()) throw new Error("Minecraft bot name is reserved");
      const classification = await this.classify(name);
      if (classification === "premium") {
        const result = await this.command(`premium ${name}`);
        if (!/premium|paid|already/iu.test(result))
          throw new Error("Minecraft forced-premium enrollment unverified");
        await this.verifyPremiumStored(name);
        this.enrolled.add(name.toLowerCase());
        return { username: name, classification };
      }
      const provider = `clankie_minecraft_friend_${name.toLowerCase()}`;
      await this.credentials.set(provider, { type: "api", key: randomBytes(12).toString("hex") });
      const code = await this.secret(provider);
      await this.command(`authme register ${name} ${code}`);
      const changed = await this.command(`authme changepassword ${name} ${code}`);
      if (!/changed|success/iu.test(changed)) throw new Error("Minecraft offline enrollment unverified");
      this.enrolled.add(name.toLowerCase());
      const key = name.toLowerCase();
      const old = this.codes.get(key);
      if (old) clearTimeout(old.timer);
      const timer = setTimeout(() => {
        void this.revokeCode(name).catch(() => {});
      }, this.options.codeTtlMs ?? 300000);
      timer.unref();
      this.codes.set(key, { provider, expiresAt: Date.now() + (this.options.codeTtlMs ?? 300000), timer });
      return { username: name, classification: "nonpremium" as const, providerId: provider };
    }).catch(() => {
      throw new Error("Minecraft enrollment provisioning failed safely");
    });
  }
  admin(input: unknown): Promise<{ command: HostAdmin; outcome: string; players?: string[] }> {
    const parsed = HostAdminSchema.parse(input);
    if (parsed.operation === "whitelist_add" && !this.enrolled.has(parsed.username.toLowerCase()))
      throw new Error("Minecraft whitelist admission requires enrollment");
    return this.serial(async () => {
      this.requireReady();
      const response = await this.command(serializeHostAdmin(parsed));
      const plain = response.replace(/§[0-9a-fklmnor]/giu, "");
      if (
        /^(?:Unknown |Incorrect |Invalid |No (?:player|entity|target)|Cannot |Failed |Player .* (?:not found|not online))/iu.test(
          plain.trim(),
        )
      )
        throw new Error("Minecraft command did not succeed");
      return {
        command: parsed,
        outcome: this.sanitize(response),
        ...(parsed.operation === "list"
          ? {
              players: (response.split(":").at(-1) ?? "")
                .split(",")
                .map((name) => name.trim())
                .filter((name) => /^[A-Za-z0-9_]{3,16}$/u.test(name))
                .slice(0, 12),
            }
          : {}),
      };
    });
  }
  /** Pinned AuthMe's own logger is the authority; game chat has a different line prefix. */
  private consumeAuthLog(line: string): void {
    const name = pinnedAuthLogin(line);
    if (name && this.codes.has(name.toLowerCase())) void this.revokeCode(name).catch(() => {});
  }
  revokeCode(name: string): Promise<{ revoked: boolean }> {
    username.parse(name);
    return this.serial(async () => {
      const key = name.toLowerCase();
      const entry = this.codes.get(key);
      if (!entry) return { revoked: false };
      clearTimeout(entry.timer);
      try {
        const replacement = randomBytes(12).toString("hex");
        this.sensitive.add(replacement);
        const response = await this.command(`authme changepassword ${name} ${replacement}`);
        if (!/changed|success/iu.test(response)) throw new Error("Minecraft code revocation unverified");
        await this.credentials.delete(entry.provider);
        this.codes.delete(key);
        return { revoked: true };
      } catch {
        this.desired = false;
        await this.stopNow();
        this.state.phase = "failed";
        this.state.failure = "code_revocation_failed";
        throw new Error("Minecraft code revocation failed safely");
      }
    });
  }
  backup(): Promise<HostStatus["lastBackup"]> {
    return this.serial(async () => {
      this.requireReady();
      await this.command("save-off");
      try {
        await this.command("save-all flush");
        const filename = `world-${Date.now()}.tar.gz`;
        const directory = join(this.dataDir, "backups");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const worlds = (await readdir(this.dataDir, { withFileTypes: true }))
          .filter(
            (entry) => entry.isDirectory() && ["world", "world_nether", "world_the_end"].includes(entry.name),
          )
          .map((entry) => entry.name);
        if (!worlds.length) throw new Error("Minecraft backup has no worlds");
        await exec("tar", ["-czf", join(directory, `${filename}.new`), "--", ...worlds], {
          cwd: this.dataDir,
          timeout: 120000,
          maxBuffer: 1024,
        });
        await chmod(join(directory, `${filename}.new`), 0o600);
        await rename(join(directory, `${filename}.new`), join(directory, filename));
        const files = (await readdir(directory))
          .filter((file) => /^world-\d+\.tar\.gz$/u.test(file))
          .sort()
          .reverse();
        for (const file of files.slice(this.settings.backupRetention)) await rm(join(directory, file));
        this.state.lastBackup = { filename, at: Date.now() };
        return structuredClone(this.state.lastBackup);
      } finally {
        await this.command("save-on");
      }
    });
  }
  /** Private motor seam, only matches the exact hosted loopback endpoint. */
  async botLogin(endpoint: { host: string; port: number; username: string }): Promise<string | null> {
    if (
      endpoint.host !== "127.0.0.1" ||
      endpoint.port !== this.state.gameEndpoint.port ||
      endpoint.username !== BOT
    )
      return null;
    this.requireReady();
    return this.secret(BOT_PROVIDER);
  }
  private sanitize(value: string): string {
    // eslint-disable-next-line no-control-regex -- Strip terminal controls from untrusted server text.
    let safe = value.replace(/[\u0000-\u001f\u007f]/gu, " ");
    for (const secret of this.sensitive) safe = safe.split(secret).join("[REDACTED]");
    return safe.slice(0, 1024);
  }
  private async command(command: string): Promise<string> {
    // eslint-disable-next-line no-control-regex -- RCON commands must have exactly one line.
    if (/[\r\n\u0000]/u.test(command)) throw new Error("Minecraft command rejected");
    if (this.options.command) return this.options.command(command);
    return rconCommand(this.settings.rconPort, this.rconPassword, command);
  }
}
/** One bounded RCON request per private connection, exact IDs and a short deadline. */
async function rconCommand(port: number, secret: string, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    const end = (error?: Error, result?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(result ?? "");
    };
    const packet = (id: number, type: number, text: string) => {
      const payload = Buffer.from(text);
      const data = Buffer.alloc(payload.length + 14);
      data.writeInt32LE(data.length - 4, 0);
      data.writeInt32LE(id, 4);
      data.writeInt32LE(type, 8);
      payload.copy(data, 12);
      socket.write(data);
    };
    socket.setTimeout(5000, () => end(new Error("Minecraft RCON deadline")));
    socket.once("connect", () => packet(1, 3, secret));
    socket.on("error", () => end(new Error("Minecraft RCON transport failed")));
    socket.on("end", () => end(new Error("Minecraft RCON ended before response")));
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 65536) return end(new Error("Minecraft RCON response exceeded bound"));
      while (buffer.length >= 4) {
        const length = buffer.readInt32LE(0);
        if (length < 10 || length > 65532) return end(new Error("Minecraft RCON invalid frame"));
        if (buffer.length < length + 4) return;
        const body = buffer.subarray(4, length + 4);
        buffer = buffer.subarray(length + 4);
        const id = body.readInt32LE(0);
        const type = body.readInt32LE(4);
        if (id === -1) return end(new Error("Minecraft RCON authentication rejected"));
        if (!authed && id === 1 && type === 2) {
          authed = true;
          packet(2, 2, command);
        } else if (authed && id === 2 && type === 0)
          return end(undefined, body.subarray(8, body.length - 2).toString());
      }
    });
  });
}

/** Session start is deliberately unchanged by a crash restart. */
export function hostShouldStop(
  now: number,
  startedAt: number,
  lastOccupiedAt: number,
  idleTimeoutMs: number,
  maxUptimeMs: number,
): boolean {
  return now - startedAt >= maxUptimeMs || now - lastOccupiedAt >= idleTimeoutMs;
}

export function pinnedAuthLogin(line: string): string | null {
  // eslint-disable-next-line no-control-regex -- Paper JLine decorates its own logger with terminal escapes.
  const clean = line.replace(/\u001b\[[0-9;]*m/gu, "").replace(/^[>\r \t]+/u, "");
  return (
    /^\[\d{2}:\d{2}:\d{2} INFO\]: \[AuthMe\] ([A-Za-z0-9_]{3,16}) logged in [0-9a-fA-F:.]+\r?$/u.exec(
      clean,
    )?.[1] ?? null
  );
}
