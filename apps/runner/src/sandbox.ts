import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { createServer, request as requestHttp, type IncomingMessage, type Server } from "node:http";
import { connect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import type { EventStore } from "@sapling/event-store";
import type { ActionDecision, ActionRequest, Risk } from "@sapling/protocol";
export interface SandboxRunIdentity {
  missionId: string;
  taskId: string;
  workerRunId: string;
  profileHash: string;
  risk: Risk;
  workspacePath: string;
}
export interface SandboxEscalation {
  networkHosts?: string[];
  additionalWritableRoots?: string[];
  bypass?: boolean;
}
export interface SandboxDenial {
  operation: "filesystem" | "network" | "policy" | "platform";
  reason: string;
  targetFingerprint?: string;
}
export interface PreparedSandbox {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  profile: "restricted" | "elevated" | "bypass";
  collectDenials(signal?: NodeJS.Signals): Promise<SandboxDenial[]>;
  close(): Promise<void>;
}
export interface ShellSandboxOptions {
  events?: EventStore;
  decideEscalation?: (request: ActionRequest) => Promise<ActionDecision>;
  platform?: NodeJS.Platform;
  executable?: string;
  clock?: () => Date;
  idFactory?: () => string;
}
export class SandboxPreparationError extends Error {
  public readonly denial: SandboxDenial;
  public constructor(denial: SandboxDenial) {
    super(denial.reason);
    this.name = "SandboxPreparationError";
    this.denial = denial;
  }
}
/**
 * Builds a fail-closed macOS Seatbelt invocation. Direct egress is denied.
 * Exact HTTP(S) host allowlists flow through a runner-owned localhost proxy,
 * whose single port is the only network destination visible to the worker.
 */
export class ShellSandbox {
  private readonly options: Required<
    Pick<ShellSandboxOptions, "platform" | "executable" | "clock" | "idFactory">
  > &
    Pick<ShellSandboxOptions, "events" | "decideEscalation">;
  public constructor(options: ShellSandboxOptions = {}) {
    this.options = {
      ...options,
      platform: options.platform ?? process.platform,
      executable: options.executable ?? "/usr/bin/sandbox-exec",
      clock: options.clock ?? (() => new Date()),
      idFactory: options.idFactory ?? randomUUID,
    };
  }
  public async prepare(
    identity: SandboxRunIdentity,
    invocation: { command: string; args: string[] },
    environment: NodeJS.ProcessEnv,
    requested: SandboxEscalation = {},
  ): Promise<PreparedSandbox> {
    const workspace = await realpath(identity.workspacePath);
    const networkHosts = [...new Set((requested.networkHosts ?? []).map(normalizeHost))].sort();
    const additionalRoots = await Promise.all(
      [...new Set(requested.additionalWritableRoots ?? [])].map((path) => realpath(path)),
    );
    const escalated = requested.bypass === true || networkHosts.length > 0 || additionalRoots.length > 0;
    if (escalated)
      await this.authorize(identity, {
        ...requested,
        networkHosts,
        additionalWritableRoots: additionalRoots,
      });
    if (requested.bypass === true) {
      return {
        ...invocation,
        environment,
        profile: "bypass",
        collectDenials: () => Promise.resolve([]),
        close: () => Promise.resolve(),
      };
    }
    if (this.options.platform !== "darwin") {
      throw new SandboxPreparationError({
        operation: "platform",
        reason: `No enforced shell sandbox is available on ${this.options.platform}`,
      });
    }
    try {
      await access(this.options.executable, constants.X_OK);
    } catch {
      throw new SandboxPreparationError({
        operation: "platform",
        reason: "The configured macOS sandbox executable is unavailable",
      });
    }
    const proxy = networkHosts.length > 0 ? await AllowlistProxy.start(networkHosts) : undefined;
    const writableRoots = [workspace, ...additionalRoots];
    const profile = buildSeatbeltProfile(writableRoots, proxy?.port);
    const proxyUrl = proxy ? `http://127.0.0.1:${String(proxy.port)}` : undefined;
    return {
      command: this.options.executable,
      args: ["-p", profile, invocation.command, ...invocation.args],
      environment: {
        ...environment,
        ...(proxyUrl
          ? {
              HTTP_PROXY: proxyUrl,
              HTTPS_PROXY: proxyUrl,
              http_proxy: proxyUrl,
              https_proxy: proxyUrl,
              NO_PROXY: "",
              no_proxy: "",
            }
          : {}),
      },
      profile: escalated ? "elevated" : "restricted",
      collectDenials: async (signal) => [
        ...(proxy?.denials ?? []),
        ...(signal === "SIGKILL"
          ? [
              {
                operation: "policy" as const,
                reason: "macOS Seatbelt force-terminated a prohibited operation",
              },
            ]
          : []),
      ],
      close: () => proxy?.close() ?? Promise.resolve(),
    };
  }
  private async authorize(identity: SandboxRunIdentity, requested: SandboxEscalation): Promise<void> {
    if (!this.options.events || !this.options.decideEscalation) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox escalation requires both a doctrine gateway and durable audit sink",
      });
    }
    const request: ActionRequest = {
      id: `sandbox-${this.options.idFactory()}`,
      principal: { kind: "worker", id: identity.workerRunId },
      action: requested.bypass === true ? "runner.sandbox.bypass" : "runner.sandbox.escalate",
      resource: { type: "worker_sandbox", id: identity.workerRunId },
      context: {
        missionId: identity.missionId,
        taskId: identity.taskId,
        risk: identity.risk,
        profileHash: identity.profileHash,
      },
    };
    const decision = await this.options.decideEscalation(request);
    await this.options.events.append({
      id: this.options.idFactory(),
      occurredAt: this.options.clock().toISOString(),
      missionId: identity.missionId,
      taskId: identity.taskId,
      workerRunId: identity.workerRunId,
      correlationId: identity.workerRunId,
      profileHash: identity.profileHash,
      type: "sandbox.escalation.decided",
      data: {
        action: request.action,
        effect: decision.effect,
        reason: decision.reason,
        matchedPolicyIds: decision.matchedPolicyIds,
        obligations: decision.obligations,
        networkHostFingerprints: (requested.networkHosts ?? []).map(fingerprint),
        writableRootFingerprints: (requested.additionalWritableRoots ?? []).map(fingerprint),
      },
    });
    if (decision.obligations.length > 0) {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: "Sandbox escalation returned obligations the runner cannot enforce",
      });
    }
    if (decision.effect !== "allow") {
      throw new SandboxPreparationError({
        operation: "policy",
        reason: `Sandbox escalation ${decision.effect}: ${decision.reason}`,
      });
    }
  }
}
function buildSeatbeltProfile(writableRoots: string[], proxyPort?: number): string {
  const writeFilters = [
    `(literal "/dev/null")`,
    `(literal "/dev/dtracehelper")`,
    `(literal "/dev/tty")`,
    ...writableRoots.map((path) => `(subpath ${JSON.stringify(path)})`),
  ];
  const denyOutsideWrites = writeFilters.map((filter) => `(require-not ${filter})`).join(" ");
  const networkFilter =
    proxyPort === undefined
      ? ""
      : ` (require-not (remote tcp ${JSON.stringify(`localhost:${String(proxyPort)}`)}))`;
  return [
    "(version 1)",
    "(deny default)",
    `(deny file-write* (require-all ${denyOutsideWrites}) (with send-signal SIGKILL))`,
    `(deny network-outbound${networkFilter} (with send-signal SIGKILL))`,
    "(allow process-exec process-fork)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    `(allow file-write* ${writeFilters.join(" ")})`,
    ...(proxyPort === undefined
      ? []
      : [`(allow network-outbound (remote tcp ${JSON.stringify(`localhost:${String(proxyPort)}`)}))`]),
  ].join("\n");
}

class AllowlistProxy {
  public readonly denials: SandboxDenial[] = [];
  public readonly port: number;
  private readonly allowedHosts: Set<string>;
  private readonly server: Server;

  private constructor(server: Server, port: number, hosts: string[]) {
    this.server = server;
    this.port = port;
    this.allowedHosts = new Set(hosts);
  }

  public static async start(hosts: string[]): Promise<AllowlistProxy> {
    let proxy: AllowlistProxy | undefined;
    const server = createServer((request, response) => void proxy?.forwardHttp(request, response));
    server.on("connect", (request, socket, head) => proxy?.forwardConnect(request, socket, head));
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Allowlist proxy did not bind TCP");
    proxy = new AllowlistProxy(server, address.port, hosts);
    return proxy;
  }

  public close(): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      this.server.close((error) => (error ? reject(error) : resolvePromise()));
      this.server.closeAllConnections();
    });
  }

  private forwardHttp(request: IncomingMessage, response: import("node:http").ServerResponse): void {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
      if (target.protocol !== "http:") throw new Error("unsupported protocol");
    } catch {
      this.deny("invalid-target", response);
      return;
    }
    if (!this.allowedHosts.has(normalizeHost(target.hostname))) {
      this.deny(target.hostname, response);
      return;
    }
    const headers: Record<string, string | string[] | undefined> = {
      ...request.headers,
      host: target.host,
    };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = requestHttp(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: request.method,
        headers,
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  }

  private forwardConnect(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let target: URL;
    try {
      target = new URL(`http://${request.url ?? ""}`);
    } catch {
      this.denySocket("invalid-target", socket);
      return;
    }
    const targetHost = normalizeHost(target.hostname);
    if (!this.allowedHosts.has(targetHost)) {
      this.denySocket(target.hostname, socket);
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    let buffered = head;
    const timeout = setTimeout(() => rejectTls("TLS ClientHello timed out"), 5_000);
    const onData = (chunk: Buffer | string) => {
      buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffered.length > 64 * 1024) {
        rejectTls("TLS ClientHello exceeded the proxy limit");
        return;
      }
      const hello = parseTlsServerName(buffered);
      if (hello.status === "need_more") return;
      if (hello.status === "invalid" || (isIP(targetHost) === 0 && hello.serverName !== targetHost)) {
        rejectTls("TLS server name does not match the allowlisted CONNECT host");
        return;
      }
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      socket.pause();
      const upstream = connect(Number(target.port || 443), targetHost, () => {
        upstream.write(buffered);
        upstream.pipe(socket);
        socket.pipe(upstream);
        socket.resume();
      });
      upstream.on("error", () => socket.destroy());
    };
    const rejectTls = (reason: string) => {
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      this.denials.push({ operation: "network", reason, targetFingerprint: fingerprint(targetHost) });
      socket.destroy();
    };
    socket.on("data", onData);
    if (head.length > 0) onData(Buffer.alloc(0));
  }

  private deny(target: string, response: import("node:http").ServerResponse): void {
    this.denials.push({
      operation: "network",
      reason: "Host is not in the sandbox allowlist",
      targetFingerprint: fingerprint(normalizeHost(target)),
    });
    response.writeHead(403, { "content-type": "text/plain" }).end("sandbox network denial\n");
  }

  private denySocket(target: string, socket: Duplex): void {
    this.denials.push({
      operation: "network",
      reason: "Host is not in the sandbox allowlist",
      targetFingerprint: fingerprint(normalizeHost(target)),
    });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
}

export type TlsServerNameResult =
  | { status: "need_more" }
  | { status: "invalid" }
  | { status: "ok"; serverName?: string };

export function parseTlsServerName(buffer: Buffer): TlsServerNameResult {
  if (buffer.length < 5) return { status: "need_more" };
  if (buffer[0] !== 22) return { status: "invalid" };
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return { status: "need_more" };
  let offset = 5;
  if (buffer[offset] !== 1 || recordLength < 4) return { status: "invalid" };
  const handshakeLength = buffer.readUIntBE(offset + 1, 3);
  if (handshakeLength + 4 > recordLength) return { status: "invalid" }; // fragmented ClientHello: deny
  offset += 4 + 2 + 32;
  if (offset >= buffer.length) return { status: "invalid" };
  offset += 1 + (buffer[offset] ?? 0); // session id
  if (offset + 2 > buffer.length) return { status: "invalid" };
  const cipherLength = buffer.readUInt16BE(offset);
  offset += 2 + cipherLength;
  if (offset >= buffer.length) return { status: "invalid" };
  offset += 1 + (buffer[offset] ?? 0); // compression methods
  if (offset === 5 + recordLength) return { status: "ok" };
  if (offset + 2 > buffer.length) return { status: "invalid" };
  const extensionsEnd = offset + 2 + buffer.readUInt16BE(offset);
  offset += 2;
  if (extensionsEnd > 5 + recordLength) return { status: "invalid" };
  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return { status: "invalid" };
    if (type === 0) {
      if (length < 5 || offset + 5 > extensionsEnd || buffer[offset + 2] !== 0) {
        return { status: "invalid" };
      }
      const nameLength = buffer.readUInt16BE(offset + 3);
      if (offset + 5 + nameLength > extensionsEnd) return { status: "invalid" };
      try {
        return {
          status: "ok",
          serverName: normalizeHost(buffer.subarray(offset + 5, offset + 5 + nameLength).toString("ascii")),
        };
      } catch {
        return { status: "invalid" };
      }
    }
    offset += length;
  }
  return { status: "ok" };
}

function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/u, "");
  const unbracketed =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (isIP(unbracketed) === 0 && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(unbracketed)) {
    throw new Error("Invalid network allowlist host");
  }
  return unbracketed;
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
