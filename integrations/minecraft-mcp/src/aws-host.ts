/** EC2 lifecycle is integration-owned; credentials never fall back to operator AWS profiles. */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { MinecraftHostSettingsSchema } from "@clankie/protocol";
import { promisify } from "node:util";
import { connect } from "node:net";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { z } from "zod";
import type { CredentialStore } from "@clankie/credential-broker";
import {
  HostAdminSchema,
  HostConfigurationPatchSchema,
  type HostStatus,
  type HostConfiguration,
  type MinecraftHostingPort,
} from "./hosting.ts";
const exec = promisify(execFile);
const Credential = z
  .object({
    accessKeyId: z.string().regex(/^(AKIA|ASIA)[A-Z0-9]{16}$/u),
    secretAccessKey: z.string().min(20),
    sessionToken: z.string().min(1).optional(),
  })
  .strict();
const Instance = z.object({
  InstanceId: z.string(),
  State: z.object({ Name: z.string() }),
  LaunchTime: z.string().optional(),
  PublicDnsName: z.string().optional(),
  PublicIpAddress: z.string().optional(),
});
type Options = {
  instanceId: string;
  region: string;
  accountId: string;
  credentials: CredentialStore;
  dataDir?: string;
  maxUptimeMs?: number;
  idleTimeoutMs?: number;
  localPort?: number;
  documentName?: string;
  forwardDocumentName?: string;
  call?: (service: string, operation: string, input: Record<string, unknown>) => Promise<unknown>;
  forward?: (onUnavailable: () => void) => Promise<() => Promise<void>>;
  pollMs?: number;
  timeoutMs?: number;
};
export class AwsEc2Host implements MinecraftHostingPort {
  readonly dataDir: string;
  private state: HostStatus;
  private readonly options: Options;
  private queue: Promise<unknown> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private forwarding: (() => Promise<void>) | undefined;
  private forwardGeneration: object | undefined;
  private deadline = 0;
  private botSecret: string | null = null;
  private checking = false;
  private readonly keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  constructor(options: Options) {
    z.string()
      .regex(/^i-[a-f0-9]{8,17}$/u)
      .parse(options.instanceId);
    z.string()
      .regex(/^[a-z]{2}-[a-z]+-\d$/u)
      .parse(options.region);
    z.string()
      .regex(/^\d{12}$/u)
      .parse(options.accountId);
    for (const value of [options.documentName, options.forwardDocumentName])
      if (value)
        z.string()
          .regex(/^[A-Za-z0-9_.-]+$/u)
          .parse(value);
    z.number()
      .int()
      .min(100)
      .max(86400000)
      .parse(options.maxUptimeMs ?? 21600000);
    this.options = options;
    this.dataDir = options.dataDir ?? "aws-minecraft";
    const port = z
      .number()
      .int()
      .min(1024)
      .max(65535)
      .parse(options.localPort ?? 25684);
    this.state = {
      phase: "stopped",
      authReady: false,
      version: "1.21.4",
      supportedClientVersions: ["1.21.4"],
      gamePort: port,
      botUsername: "ClankieLocal26",
      eulaApprovedAt: "2026-10-04",
      gameEndpoint: {
        host: "127.0.0.1",
        port,
        version: "1.21.4",
        username: "ClankieLocal26",
        auth: "offline",
      },
    };
  }
  status(): HostStatus {
    return structuredClone(this.state);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn);
    this.queue = p.catch(() => {});
    return p;
  }
  private async environment(): Promise<NodeJS.ProcessEnv> {
    const stored = await this.options.credentials.get("clankie_minecraft_aws");
    if (stored?.type !== "api") throw new Error("Minecraft AWS broker credential missing");
    let parsed: z.infer<typeof Credential>;
    try {
      parsed = Credential.parse(JSON.parse(stored.key));
    } catch {
      throw new Error("Minecraft AWS broker credential invalid");
    }
    return {
      PATH: process.env.PATH,
      HOME: "/nonexistent",
      AWS_CONFIG_FILE: "/dev/null",
      AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_ACCESS_KEY_ID: parsed.accessKeyId,
      AWS_SECRET_ACCESS_KEY: parsed.secretAccessKey,
      ...(parsed.sessionToken ? { AWS_SESSION_TOKEN: parsed.sessionToken } : {}),
      AWS_DEFAULT_REGION: this.options.region,
      AWS_PAGER: "",
      AWS_CLI_AUTO_PROMPT: "off",
    };
  }
  private async call(service: string, operation: string, input: Record<string, unknown>): Promise<unknown> {
    if (this.options.call) return this.options.call(service, operation, input);
    const env = await this.environment();
    try {
      const out = await exec(
        "aws",
        [
          service,
          operation,
          "--region",
          this.options.region,
          "--output",
          "json",
          "--cli-input-json",
          JSON.stringify(input),
        ],
        { env, timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      return JSON.parse(out.stdout);
    } catch {
      throw new Error(`Minecraft AWS ${service} ${operation} failed`);
    }
  }
  private async describe() {
    const raw = z
      .object({ Reservations: z.array(z.object({ OwnerId: z.string(), Instances: z.array(Instance) })) })
      .parse(await this.call("ec2", "describe-instances", { InstanceIds: [this.options.instanceId] }));
    const all = raw.Reservations.flatMap((r) => r.Instances.map((i) => ({ owner: r.OwnerId, ...i })));
    if (
      all.length !== 1 ||
      all[0]!.InstanceId !== this.options.instanceId ||
      all[0]!.owner !== this.options.accountId
    )
      throw new Error("Minecraft AWS instance identity mismatch");
    return all[0]!;
  }
  private delay() {
    return new Promise<void>((resolve) => setTimeout(resolve, this.options.pollMs ?? 2000));
  }
  private async waitFor(target: string) {
    const until = Date.now() + (this.options.timeoutMs ?? (target === "running" ? 180000 : 120000));
    do {
      const instance = await this.describe();
      if (instance.State.Name === target) return instance;
      await this.delay();
    } while (Date.now() < until);
    throw new Error("Minecraft AWS lifecycle deadline exceeded");
  }
  private watch() {
    if (this.watchdog) return;
    this.watchdog = setInterval(
      () => {
        if (this.checking) return;
        this.checking = true;
        void this.refresh()
          .catch(async () => {
            if (this.deadline && Date.now() >= this.deadline) await this.stop().catch(() => {});
          })
          .finally(() => {
            this.checking = false;
          });
      },
      Math.min(30000, this.options.maxUptimeMs ?? 21600000),
    );
    this.watchdog.unref();
  }
  async refresh(): Promise<HostStatus> {
    const instance = await this.describe();
    if (instance.State.Name === "running" || instance.State.Name === "pending") {
      const launched = Date.parse(instance.LaunchTime ?? "");
      if (!Number.isFinite(launched)) throw new Error("Minecraft AWS launch time unavailable");
      this.deadline = launched + (await this.configuration()).maxUptimeMs;
      this.watch();
      if (Date.now() >= this.deadline) return this.stop();
      const address = instance.PublicDnsName || instance.PublicIpAddress;
      if (address) this.state.publicAddress = `${address}:25565`;
      if (this.state.phase === "stopped") this.state.phase = "starting";
      if (this.state.authReady) {
        try {
          const guest = z
            .object({ phase: z.string(), authReady: z.boolean() })
            .parse(await this.guest("status"));
          if (guest.phase !== "running" || !guest.authReady) {
            this.state.authReady = false;
            this.botSecret = null;
            this.state.phase = "failed";
            delete this.state.publicAddress;
          }
        } catch {
          this.state.authReady = false;
          this.botSecret = null;
          this.state.phase = "failed";
          delete this.state.publicAddress;
        }
      }
    } else {
      this.state.phase = instance.State.Name === "stopped" ? "stopped" : "stopping";
      this.state.authReady = false;
      this.botSecret = null;
      delete this.state.publicAddress;
      await this.closeForward();
      if (instance.State.Name === "stopped" && this.watchdog) {
        clearInterval(this.watchdog);
        this.watchdog = undefined;
      }
    }
    return this.status();
  }
  async publicAddress(): Promise<string | null> {
    return (await this.refresh()).publicAddress ?? null;
  }
  private async guest(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const request = Buffer.from(
      JSON.stringify({
        action,
        ...args,
        publicKey: this.keys.publicKey.export({ type: "spki", format: "pem" }),
      }),
    ).toString("base64");
    const sent = z.object({ Command: z.object({ CommandId: z.string() }) }).parse(
      await this.call("ssm", "send-command", {
        InstanceIds: [this.options.instanceId],
        DocumentName: this.options.documentName ?? "ClankieMinecraftHost",
        Parameters: {
          Request: [request],
          ExecutionTimeout: [action === "start" ? "550" : action === "backup" ? "150" : "30"],
        },
        TimeoutSeconds: action === "start" ? 550 : 60,
      }),
    );
    const until =
      Date.now() +
      (this.options.timeoutMs ??
        (action === "start" ? 540000 : action === "backup" ? 150000 : action === "stop" ? 30000 : 20000));
    do {
      let raw: unknown;
      try {
        raw = await this.call("ssm", "get-command-invocation", {
          CommandId: sent.Command.CommandId,
          InstanceId: this.options.instanceId,
        });
      } catch {
        await this.delay();
        continue;
      }
      const result = z
        .object({ Status: z.string(), StandardOutputContent: z.string().optional() })
        .parse(raw);
      if (result.Status === "Success") {
        const envelope = z
          .object({ key: z.string(), iv: z.string(), tag: z.string(), data: z.string() })
          .parse(JSON.parse(result.StandardOutputContent ?? ""));
        const key = privateDecrypt(
          { key: this.keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          Buffer.from(envelope.key, "base64"),
        );
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
        decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
        const value = JSON.parse(
          Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString(),
        );
        if (value.error) {
          const failure = z
            .enum(["startup_timeout", "startup_process_exited", "startup_process_failed", "startup_failed"])
            .safeParse(value.failure);
          if (failure.success) this.state.failure = failure.data;
          throw new Error("Minecraft guest operation failed safely");
        }
        return value.result;
      }
      if (!["Pending", "InProgress", "Delayed"].includes(result.Status))
        throw new Error("Minecraft SSM command failed safely");
      await this.delay();
    } while (Date.now() < until);
    this.state.failure = "guest_command_timeout";
    throw new Error("Minecraft SSM command deadline exceeded");
  }
  private async openForward(): Promise<void> {
    if (this.forwarding) return;
    const generation = {};
    this.forwardGeneration = generation;
    const unavailable = () => {
      if (this.forwardGeneration !== generation) return;
      this.forwardGeneration = undefined;
      this.forwarding = undefined;
      this.state.authReady = false;
      this.botSecret = null;
    };
    if (this.options.forward) {
      const close = await this.options.forward(unavailable);
      if (this.forwardGeneration !== generation) {
        await close();
        throw new Error("Minecraft forwarding exited before readiness");
      }
      this.forwarding = close;
      return;
    }
    const listening = () =>
      new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: this.state.gameEndpoint.port });
        socket.setTimeout(500);
        const done = (v: boolean) => {
          socket.destroy();
          resolve(v);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.once("timeout", () => done(false));
      });
    if (await listening()) throw new Error("Minecraft local forwarding port is already occupied");
    const env = await this.environment();
    const child: ChildProcess = spawn(
      "aws",
      [
        "ssm",
        "start-session",
        "--region",
        this.options.region,
        "--target",
        this.options.instanceId,
        "--document-name",
        this.options.forwardDocumentName ?? "ClankieMinecraftForward",
        "--parameters",
        JSON.stringify({ localPortNumber: [String(this.state.gameEndpoint.port)] }),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let exited = false;
    let sessionId: string | undefined;
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-4096);
      sessionId = /Starting session with SessionId:\s*([A-Za-z0-9_.@-]+)/u.exec(output)?.[1] ?? sessionId;
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => {
      exited = true;
      unavailable();
    });
    child.on("exit", () => {
      exited = true;
      unavailable();
      void close().catch(() => {});
    });
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = new Promise<void>((resolve) => {
        if (exited) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 5000);
      });
      child.kill("SIGTERM");
      await done;
      if (timer) clearTimeout(timer);
      if (sessionId) await this.call("ssm", "terminate-session", { SessionId: sessionId });
    };
    this.forwarding = close;
    const until = Date.now() + 30000;
    while (!exited && Date.now() < until) {
      const ready = await new Promise<boolean>((resolve) => {
        const socket = connect({ host: "127.0.0.1", port: this.state.gameEndpoint.port });
        socket.setTimeout(500);
        const done = (v: boolean) => {
          socket.destroy();
          resolve(v);
        };
        socket.once("connect", () => done(true));
        socket.once("error", () => done(false));
        socket.once("timeout", () => done(false));
      });
      if (ready && sessionId && !exited) return;
      await this.delay();
    }
    await this.closeForward();
    throw new Error("Minecraft SSM port forwarding unavailable");
  }
  private async closeForward() {
    const close = this.forwarding;
    this.forwarding = undefined;
    this.forwardGeneration = undefined;
    await close?.();
  }
  start(): Promise<HostStatus> {
    return this.serial(async () => {
      try {
        const settings = await this.configuration();
        const instance = await this.describe();
        if (instance.State.Name === "stopped")
          await this.call("ec2", "start-instances", { InstanceIds: [this.options.instanceId] });
        else if (!["running", "pending"].includes(instance.State.Name))
          throw new Error("Minecraft AWS instance transition in progress");
        this.state.phase = "starting";
        delete this.state.failure;
        this.state.authReady = false;
        this.botSecret = null;
        this.deadline = Date.now() + settings.maxUptimeMs;
        this.watch();
        const running = await this.waitFor("running");
        this.deadline = Date.parse(running.LaunchTime ?? "") + settings.maxUptimeMs;
        if (!Number.isFinite(this.deadline) || Date.now() >= this.deadline)
          throw new Error("Minecraft AWS uptime exceeded");
        {
          const readyUntil = Date.now() + (this.options.timeoutMs ?? 60000);
          while (true) {
            try {
              await this.guest("status");
              break;
            } catch {
              if (Date.now() >= readyUntil) throw new Error("Minecraft guest readiness deadline exceeded");
              await this.delay();
            }
          }
        }
        if (Date.now() >= this.deadline) throw new Error("Minecraft AWS uptime exceeded during readiness");
        const guest = (await this.guest("start", {
          settings: {
            ...settings,
            gamePort: 25684,
            rconPort: 25685,
            maxUptimeMs: Math.max(100, this.deadline - Date.now()),
          },
        })) as HostStatus;
        if (guest.phase !== "running" || !guest.authReady) throw new Error("Minecraft guest not ready");
        const botSecret = z
          .string()
          .min(1)
          .max(256)
          .parse(await this.guest("botLogin"));
        await this.openForward();
        this.botSecret = botSecret;
        this.state.phase = "running";
        this.state.authReady = true;
        const address = running.PublicDnsName || running.PublicIpAddress;
        if (!address) throw new Error("Minecraft AWS public address unavailable");
        this.state.publicAddress = `${address}:25565`;
        return this.status();
      } catch {
        this.botSecret = null;
        const failure = this.state.failure;
        await this.stopNow().catch(() => {});
        if (failure) this.state.failure = failure;
        throw new Error("Minecraft AWS start failed; inspect instance stop status");
      }
    });
  }
  stop(): Promise<HostStatus> {
    this.botSecret = null;
    return this.serial(() => this.stopNow());
  }
  private async stopNow(): Promise<HostStatus> {
    const instance = await this.describe();
    this.state.phase = "stopping";
    this.state.authReady = false;
    this.botSecret = null;
    let guestFailed = false;
    try {
      await this.closeForward();
    } catch {
      guestFailed = true;
    }
    try {
      if (instance.State.Name === "running") await this.guest("stop");
    } catch {
      guestFailed = true;
    }
    await this.call("ec2", "stop-instances", { InstanceIds: [this.options.instanceId] });
    await this.waitFor("stopped");
    this.state.phase = "stopped";
    delete this.state.publicAddress;
    if (guestFailed) this.state.failure = "guest_backup_unconfirmed";
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    return this.status();
  }
  async restart() {
    await this.stop();
    return this.start();
  }
  async configuration(): Promise<HostConfiguration> {
    const defaults = {
      gamePort: this.state.gameEndpoint.port,
      rconPort: 25685,
      memoryMiB: 1024,
      backupIntervalMs: 86400000,
      backupRetention: 7,
      idleTimeoutMs: this.options.idleTimeoutMs ?? 900000,
      maxUptimeMs: this.options.maxUptimeMs ?? 21600000,
    };
    try {
      return MinecraftHostSettingsSchema.parse({
        ...defaults,
        ...JSON.parse(await readFile(join(this.dataDir, "aws-settings.json"), "utf8")),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("Minecraft AWS settings invalid");
      return MinecraftHostSettingsSchema.parse(defaults);
    }
  }
  async configure(patch: unknown): Promise<HostConfiguration> {
    return this.serial(async () => {
      const updates = HostConfigurationPatchSchema.parse(patch);
      const instance = await this.describe();
      if (instance.State.Name !== "stopped")
        throw new Error("Stop Minecraft AWS instance before configuring it");
      const settings = MinecraftHostSettingsSchema.parse({ ...(await this.configuration()), ...updates });
      if (settings.gamePort !== this.state.gameEndpoint.port || settings.rconPort !== 25685 || settings.java)
        throw new Error("Minecraft AWS guest ports and Java are provisioned");
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const path = join(this.dataDir, "aws-settings.json");
      await writeFile(path + ".new", JSON.stringify(settings) + "\n", { mode: 0o600 });
      await rename(path + ".new", path);
      return settings;
    });
  }
  async backup(): Promise<HostStatus["lastBackup"]> {
    const result = (await this.guest("backup")) as HostStatus["lastBackup"];
    if (result) this.state.lastBackup = result;
    return result;
  }
  async admin(command: unknown): ReturnType<MinecraftHostingPort["admin"]> {
    return (await this.guest("admin", { command: HostAdminSchema.parse(command) })) as Awaited<
      ReturnType<MinecraftHostingPort["admin"]>
    >;
  }
  async enroll(username: string): ReturnType<MinecraftHostingPort["enroll"]> {
    const result = z
      .object({
        username: z.string(),
        classification: z.enum(["premium", "nonpremium"]),
        providerId: z.string().optional(),
        code: z.string().optional(),
      })
      .parse(await this.guest("enroll", { username }));
    if (result.classification === "nonpremium") {
      if (result.providerId !== `clankie_minecraft_friend_${username.toLowerCase()}` || !result.code)
        throw new Error("Minecraft enrollment response invalid");
      await this.options.credentials.set(result.providerId, { type: "api", key: result.code });
    }
    return {
      username: result.username,
      classification: result.classification,
      ...(result.providerId ? { providerId: result.providerId } : {}),
    };
  }
  async revokeCode(username: string) {
    const result = (await this.guest("revokeCode", { username })) as { revoked: boolean };
    if (result.revoked)
      await this.options.credentials.delete(`clankie_minecraft_friend_${username.toLowerCase()}`);
    return result;
  }
  async botLogin(endpoint: { host: string; port: number; username: string }): Promise<string | null> {
    if (
      !this.state.authReady ||
      endpoint.host !== "127.0.0.1" ||
      endpoint.port !== this.state.gameEndpoint.port ||
      endpoint.username !== this.state.botUsername
    )
      return null;
    return this.botSecret;
  }
}
