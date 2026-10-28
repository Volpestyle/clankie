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
    | "review-candidates"
    | "review-verdicts"
    | "tool-catalog"
    | "evidence-uploads"
    | "fixture-admissions"
    | "receipt";
  readonly method: "GET" | "POST" | "other";
  readonly bridgeId?: string;
  /** Internal observation input, never serialized into diagnostics. */
  readonly socket: Socket;
}

const bridgeUuid = z.string().uuid();
/** The store's signed blob upload (VUH-2923); its signature, not the link, authorizes the bytes. */
export const LINK_EVIDENCE_BLOB = /^\/v1\/evidence\/uploads\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]{16,128}\/blob$/u;

/**
 * Idle keep-alive for the local fleet listener (VUH-2389). Node's fetch (undici)
 * honors the server's Keep-Alive hint, less a margin, up to its default ten-minute
 * ceiling, so a worker bridge keeps its proven connection between catalog checks.
 * At Node's 5 s default even a 3.5 s gap opened a new connection, and each new
 * connection pays a whole-machine proof.
 */
export const LOCAL_FLEET_KEEP_ALIVE_MS = 600_000;

export interface LocalFleetIdentity {
  readonly fleet?: string;
  readonly pane: string;
  /**
   * Socket/process admission for this request's connection: a full fresh proof
   * the first time, then that connection's bound proof while its owner lineage,
   * pane, binding and private seat hold. current() alone never grants authority.
   */
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
 * after its own validate(). Native peer routes likewise consume a full
 * socket-bound project proof instead of repeating broad fleet proof around it.
 * Fleet admission is proven once per connection and rechecked cheaply on each
 * later request (local-fleet-proof.ts); project proofs stay fresh per call.
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
    fixtureAdmission?(
      request: Request,
      proof: ProjectProcessProof,
      socket: Socket,
      current: () => boolean,
    ): Promise<Response>;
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
        /^\/v1\/fleet\/seats\/([^/]+)\/(events|hook|messages|peers|peer-messages|review-candidates|review-verdicts|tool-catalog|evidence-uploads)$/u.exec(
          path,
        ) ||
        // A review candidate's read is its author's or reviewer's own (ADR 0287).
        (request.method !== "GET"
          ? null
          : /^\/v1\/fleet\/seats\/([^/]+)\/(review-candidates)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.exec(
              path,
            ) ||
            // An evidence receipt is its idempotency key (VUH-2923).
            /^\/v1\/fleet\/seats\/([^/]+)\/(evidence-uploads)\/[A-Za-z0-9_-]{16,128}$/u.exec(path));
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
      const fixtureAdmission = /^\/v1\/fleet\/seats\/([^/]+)\/fixture-admissions(?:\/.*)?$/u.exec(path);
      const seat = seatRoute || receipt || ack || fixtureAdmission;
      // The store's signed blob path carries its own authority and needs no pane proof.
      if (!seat && request.method === "PUT" && LINK_EVIDENCE_BLOB.test(path)) return forward(request);
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
        route: fixtureAdmission
          ? "fixture-admissions"
          : path === "/v1/fleet/mcp"
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
      // Admission is original project proof, never broad pane membership or generic forwarding.
      if (fixtureAdmission) {
        if (!this.options.fixtureAdmission || !this.options.projectProof)
          return Response.json({ error: "fixture_admission_unavailable" }, { status: 404 });
        try {
          const proof = await identity.admittedProjectProof();
          if (!proof || proof.nativeSessionPending || proof.pane !== pane || !current())
            return Response.json({ error: "fixture_original_required" }, { status: 403 });
          return await this.options.fixtureAdmission(request, proof, socket, current);
        } catch {
          return Response.json({ error: "fixture_original_unavailable" }, { status: 403 });
        }
      }
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
