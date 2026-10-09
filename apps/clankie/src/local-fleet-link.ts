import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { HerdrBinding } from "@clankie/protocol";
import { z } from "zod";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import {
  FleetAdmissionUnavailableError,
  fleetAdmissionUnavailableResponse,
} from "./local-fleet-admission.ts";

/** Diagnostic attribution only; none of these fields grants admission. */
export interface LocalFleetProofRequestContext {
  readonly requestId: string;
  readonly connectionId: string;
  readonly route:
    | "mcp"
    | "events"
    | "ack"
    | "hook"
    | "messages"
    | "peers"
    | "peer-messages"
    | "tool-catalog"
    | "receipt";
  readonly method: "GET" | "POST" | "other";
  readonly bridgeId?: string;
  /** Internal observation input, never serialized into diagnostics. */
  readonly socket: Socket;
}

const bridgeUuid = z.string().uuid();

export interface LocalFleetIdentity {
  readonly fleet?: string;
  readonly pane: string;
  /** Fresh socket/process admission; current() alone never grants authority. */
  validate(signal?: AbortSignal): Promise<boolean>;
  /** Synchronous link revocation only; never substitutes for async process admission. */
  current?(): boolean;
  projectProof?(signal?: AbortSignal): Promise<ProjectProcessProof | undefined>;
  /** Full fresh socket, ancestry and native-session admission, not a bare project observation. */
  admittedProjectProof?(signal?: AbortSignal): Promise<ProjectProcessProof | undefined>;
}

/**
 * Bind each request to its local listener socket. Seat routes are admitted here;
 * the MCP route receives a candidate identity that only WorkerMcp may consume,
 * after its own fresh validate(). Native peer routes likewise consume a full
 * socket-bound project proof instead of repeating broad fleet proof around it.
 * No proof is cached; later authority checks observe the kernel again.
 */
export class LocalFleetLink {
  private readonly identities = new WeakMap<Request, LocalFleetIdentity>();
  private readonly connections = new WeakMap<Socket, string>();
  private open = true;
  private published: string | undefined;
  private readonly options: {
    directory: string;
    binding(): Promise<HerdrBinding | undefined>;
    prove(
      socket: Socket,
      pane: string,
      signal?: AbortSignal,
      context?: LocalFleetProofRequestContext,
    ): Promise<boolean>;
    projectProof?(
      socket: Socket,
      pane: string,
      signal?: AbortSignal,
      context?: LocalFleetProofRequestContext,
    ): Promise<ProjectProcessProof | undefined>;
  };
  constructor(options: LocalFleetLink["options"]) {
    this.options = options;
  }

  /** MCP identities are candidates: validate() must succeed before they grant authority. */
  identity(request: Request): LocalFleetIdentity | undefined {
    return this.identities.get(request);
  }

  fetch(forward: (request: Request) => Response | Promise<Response>) {
    return async (request: Request, env: HttpBindings | Http2Bindings): Promise<Response> => {
      const path = new URL(request.url).pathname;
      const seatRoute =
        /^\/v1\/fleet\/seats\/([^/]+)\/(events|hook|messages|peers|peer-messages|tool-catalog)$/u.exec(path);
      const receipt =
        request.method === "GET" &&
        (/^\/v1\/fleet\/seats\/([^/]+)\/(?:messages|peer-messages)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.exec(
          path,
        ) ||
          /^\/v1\/fleet\/seats\/([^/]+)\/messages\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/status$/iu.exec(
            path,
          ));
      const ack =
        request.method === "POST" && /^\/v1\/fleet\/seats\/([^/]+)\/events\/[^/]+\/ack$/u.exec(path);
      const seat = seatRoute || receipt || ack;
      if (path !== "/v1/fleet/mcp" && !seat) return Response.json({ error: "not_found" }, { status: 404 });
      const pane = request.headers.get("x-clankie-pane") ?? "";
      if (seat && decodeURIComponent(seat[1]!) !== pane)
        return Response.json({ error: "local_pane_required" }, { status: 403 });
      const socket = env.incoming.socket;
      let connectionId = this.connections.get(socket);
      if (connectionId === undefined) {
        connectionId = randomUUID();
        this.connections.set(socket, connectionId);
      }
      const bridgeId = bridgeUuid.safeParse(request.headers.get("x-clankie-bridge-id"));
      const context: LocalFleetProofRequestContext = {
        requestId: randomUUID(),
        connectionId,
        route:
          path === "/v1/fleet/mcp"
            ? "mcp"
            : receipt
              ? "receipt"
              : ack
                ? "ack"
                : (seatRoute![2] as LocalFleetProofRequestContext["route"]),
        method: request.method === "GET" || request.method === "POST" ? request.method : "other",
        ...(bridgeId.success ? { bridgeId: bridgeId.data } : {}),
        socket,
      };
      const current = () => this.open && env.incoming.socket.destroyed !== true;
      const cancellation = (signal?: AbortSignal) =>
        signal ? AbortSignal.any([request.signal, signal]) : request.signal;
      const identity = {
        current,
        fleet: "default",
        pane,
        validate: async (signal?: AbortSignal) => {
          const cancelled = cancellation(signal);
          cancelled.throwIfAborted();
          if (!current()) throw new FleetAdmissionUnavailableError("Local fleet connection is unavailable");
          const admitted = await this.options.prove(socket, pane, cancelled, context);
          cancelled.throwIfAborted();
          if (!current()) throw new FleetAdmissionUnavailableError("Local fleet connection changed");
          return admitted;
        },
        projectProof: async (signal?: AbortSignal) => {
          const cancelled = cancellation(signal);
          cancelled.throwIfAborted();
          const proof = this.open
            ? await this.options.projectProof?.(socket, pane, cancelled, context)
            : undefined;
          cancelled.throwIfAborted();
          return proof;
        },
        admittedProjectProof: async (signal?: AbortSignal) => {
          const cancelled = cancellation(signal);
          cancelled.throwIfAborted();
          if (!current()) return undefined;
          const proof = await this.options.projectProof?.(socket, pane, cancelled, context);
          cancelled.throwIfAborted();
          return current() ? proof : undefined;
        },
      };
      // These routes authenticate the candidate with admittedProjectProof before
      // reading peers, sending or reconciling. Other seat routes still require
      // broad fleet admission here; a missing project prover never bypasses it.
      const nativePeer =
        this.options.projectProof !== undefined && /\/peer(?:s|-messages)(?:\/[^/]+)?$/u.test(path);
      if (path !== "/v1/fleet/mcp" && !nativePeer) {
        try {
          if (!(await identity.validate()))
            return Response.json({ error: "local_process_membership_required" }, { status: 403 });
        } catch (error) {
          if (request.signal.aborted)
            return Response.json({ error: "local_admission_cancelled" }, { status: 504 });
          if (error instanceof FleetAdmissionUnavailableError) return fleetAdmissionUnavailableResponse();
          throw error;
        }
      }
      this.identities.set(request, identity);
      try {
        return await forward(request);
      } finally {
        this.identities.delete(request);
      }
    };
  }

  /** Discovery data only: no bearer, account or provider credential is written. */
  async publish(port: number): Promise<void> {
    const binding = await this.options.binding();
    if (!this.open || !binding) return;
    this.published = JSON.stringify({
      schemaVersion: 2,
      authentication: "local-process",
      fleet: "default",
      socket: binding.socketPath,
      url: `http://127.0.0.1:${port}`,
    });
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const path = join(this.options.directory, "default-local.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, this.published, { flag: "wx", mode: 0o600 });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async close(): Promise<void> {
    this.open = false;
    const path = join(this.options.directory, "default-local.json");
    if (
      this.published !== undefined &&
      (await readFile(path, "utf8").catch(() => undefined)) === this.published
    )
      await rm(path, { force: true });
  }
}
