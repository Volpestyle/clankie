/** Private root-owned Unix socket; SSM receives encrypted output only. */
import { createServer, connect } from "node:net";
import { chmod, mkdir, rm } from "node:fs/promises";
import {
  randomBytes,
  publicEncrypt,
  createCipheriv,
  constants,
  generateKeyPairSync,
  privateDecrypt,
  createDecipheriv,
} from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { FileCredentialStore } from "@clankie/credential-broker";
import { MinecraftHost } from "./hosting.ts";
const socketPath = "/run/clankie-minecraft.sock";
const Request = z
  .object({
    action: z.enum([
      "start",
      "stop",
      "status",
      "configuration",
      "configure",
      "backup",
      "admin",
      "enroll",
      "revokeCode",
      "botLogin",
    ]),
    publicKey: z.string().min(100).max(2048),
    username: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,16}$/u)
      .optional(),
    command: z.unknown().optional(),
    settings: z.unknown().optional(),
  })
  .strict();
export function encryptGuestResponse(publicKey: string, value: unknown): string {
  const key = randomBytes(32),
    iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({
    key: publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      key,
    ).toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
}
/** Public listener admission follows the authenticated guest, including crash transitions. */
export class GuestPublicProxy {
  private ready = false;
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly authenticated: () => boolean;
  private readonly command: (action: "start" | "stop" | "is-active") => Promise<void>;
  constructor(
    authenticated: () => boolean,
    command: (action: "start" | "stop" | "is-active") => Promise<void> = async (action) => {
      await promisify(execFile)(
        "/usr/bin/systemctl",
        action === "is-active" ? ["is-active", "--quiet", "haproxy"] : [action, "haproxy"],
        { timeout: 10000, maxBuffer: 1024 },
      );
    },
  ) {
    this.authenticated = authenticated;
    this.command = command;
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  close(): Promise<void> {
    this.ready = false;
    this.generation++;
    return this.serial(() => this.command("stop"));
  }
  open(): Promise<void> {
    const generation = this.generation;
    return this.serial(async () => {
      if (!this.authenticated() || generation !== this.generation)
        throw new Error("Minecraft public proxy requires authentication readiness");
      try {
        await this.command("start");
        await this.command("is-active");
        if (!this.authenticated() || generation !== this.generation)
          throw new Error("Minecraft authentication changed during proxy admission");
        this.ready = true;
      } catch {
        this.ready = false;
        await this.command("stop");
        throw new Error("Minecraft public proxy admission failed");
      }
    });
  }
  async available(): Promise<boolean> {
    if (!this.ready || !this.authenticated()) return false;
    try {
      await this.command("is-active");
      return this.ready && this.authenticated();
    } catch {
      await this.close().catch(() => {});
      return false;
    }
  }
}
async function serve() {
  const dataDir = "/var/lib/clankie-minecraft";
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const credentials = new FileCredentialStore(`${dataDir}/credentials.json`);
  const proxy: GuestPublicProxy = new GuestPublicProxy(
    () => host.status().phase === "running" && host.status().authReady,
  );
  const host: MinecraftHost = new MinecraftHost({
    dataDir,
    credentials,
    gamePort: 25684,
    rconPort: 25685,
    memoryMiB: 1024,
    idleTimeoutMs: 900000,
    maxUptimeMs: 21600000,
    startupTimeoutMs: 480000,
    onUnavailable: () => proxy.close(),
  });
  await proxy.close();
  const publicStatus = async () => {
    const available = await proxy.available();
    const status = host.status();
    return { ...status, authReady: available && status.authReady };
  };
  const bootedAt = Date.now();
  let ran = false,
    shuttingDown = false;
  const poweroff = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    execFile("/usr/sbin/shutdown", ["-h", "now"], () => {});
  };
  const timer = setInterval(() => {
    if ((ran || Date.now() - bootedAt >= 900000) && ["stopped", "failed"].includes(host.status().phase))
      poweroff();
  }, 5000);
  timer.unref();
  // No automatic game start at boot. The operator's start RPC is the only admission.
  await rm(socketPath, { force: true });
  const server = createServer((socket) => {
    let input = "";
    socket.setTimeout(560000, () => socket.destroy());
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.length > 16384) {
        socket.destroy();
        return;
      }
      if (!input.includes("\n")) return;
      socket.pause();
      void (async () => {
        const request = Request.parse(JSON.parse(input.trim()));
        let result: unknown;
        try {
          switch (request.action) {
            case "status":
              result = await publicStatus();
              break;
            case "configuration":
              result = await host.configuration();
              break;
            case "configure":
              result = await host.configure(request.settings);
              break;
            case "start":
              ran = true;
              if (host.status().phase !== "running") {
                if (request.settings) await host.configure(request.settings);
                result = await host.start();
              }
              await proxy.open();
              result = await publicStatus();
              break;
            case "stop":
              try {
                if (host.status().authReady) await host.backup();
              } finally {
                result = await host.stop();
              }
              setTimeout(poweroff, 2000).unref();
              break;
            case "backup":
              result = await host.backup();
              break;
            case "admin":
              result = await host.admin(request.command);
              break;
            case "enroll": {
              const enrolled = await host.enroll(request.username ?? "");
              const code = enrolled.providerId ? await credentials.get(enrolled.providerId) : undefined;
              result = { ...enrolled, ...(code?.type === "api" ? { code: code.key } : {}) };
              break;
            }
            case "revokeCode":
              result = await host.revokeCode(request.username ?? "");
              break;
            case "botLogin":
              result = await host.botLogin(host.status().gameEndpoint);
              break;
          }
          socket.end(encryptGuestResponse(request.publicKey, { result }) + "\n");
        } catch {
          socket.end(
            encryptGuestResponse(request.publicKey, {
              error: "guest_operation_failed",
              failure: host.status().failure,
            }) + "\n",
          );
        }
      })().catch(() => socket.destroy());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const terminate = () => {
    void host.stop().finally(() => {
      server.close();
      poweroff();
    });
  };
  process.once("SIGTERM", terminate);
  process.once("SIGINT", terminate);
}
async function request(encoded: string, timeoutMs?: number, print = true) {
  if (!/^[A-Za-z0-9+/=]{1,22000}$/u.test(encoded)) throw new Error("invalid request");
  const value = Request.parse(JSON.parse(Buffer.from(encoded, "base64").toString()));
  const output = await new Promise<string>((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setTimeout(timeoutMs ?? (value.action === "start" ? 550000 : 290000), () => {
      socket.destroy();
      reject(new Error("guest deadline"));
    });
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(value) + "\n"));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.length > 24000) {
        socket.destroy();
        reject(new Error("guest output bound"));
      }
    });
    socket.once("end", () => resolve(response));
  });
  if (print) process.stdout.write(output);
  return output;
}
async function health() {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encoded = Buffer.from(
    JSON.stringify({ action: "status", publicKey: keys.publicKey.export({ type: "spki", format: "pem" }) }),
  ).toString("base64");
  const envelope = JSON.parse(await request(encoded, 10000, false));
  const key = privateDecrypt(
    { key: keys.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(envelope.key, "base64"),
  );
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const value = JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString(),
  );
  const status = z.object({ phase: z.string(), authReady: z.boolean() }).parse(value.result);
  process.stdout.write(JSON.stringify(status) + "\n");
  if (status.phase !== "running" || !status.authReady) throw new Error("guest not ready");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  void (
    mode === "serve"
      ? serve()
      : mode === "health"
        ? health()
        : mode === "request"
          ? request(process.argv[3] ?? "")
          : Promise.reject(new Error("guest mode required"))
  ).catch(() => {
    process.stderr.write("Minecraft guest operation failed safely\n");
    process.exitCode = 1;
  });
}
