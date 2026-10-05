import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { HerdrBinding } from "@clankie/protocol";
import type { ProjectProcessProof } from "./project-process-proof.ts";

export interface LocalFleetIdentity {
  readonly fleet?: string;
  readonly pane: string;
  /** Fresh socket/process admission; current() alone never grants authority. */
  validate(): Promise<boolean>;
  /** Synchronous link revocation only; never substitutes for async process admission. */
  current?(): boolean;
  projectProof?(): Promise<ProjectProcessProof | undefined>;
}

/**
 * Bind each request to its local listener socket. Seat routes are admitted here;
 * the MCP route receives a candidate identity that only WorkerMcp may consume,
 * after its own fresh validate(). This avoids doing the same expensive OS proof
 * twice before an MCP request reaches authentication. No proof is cached, and
 * provider dispatch still validates again after asynchronous discovery.
 */
export class LocalFleetLink {
  private readonly identities = new WeakMap<Request, LocalFleetIdentity>();
  private open = true;
  private published: string | undefined;
  private readonly options: {
    directory: string;
    binding(): Promise<HerdrBinding | undefined>;
    prove(socket: Socket, pane: string): Promise<boolean>;
    projectProof?(socket: Socket, pane: string): Promise<ProjectProcessProof | undefined>;
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
      const seat =
        /^\/v1\/fleet\/seats\/([^/]+)\/(events|hook|messages|peers|peer-messages|tool-catalog)$/u.exec(
          path,
        ) ||
        (request.method === "GET" &&
          /^\/v1\/fleet\/seats\/([^/]+)\/(?:messages|peer-messages)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.exec(
            path,
          )) ||
        (request.method === "POST" && /^\/v1\/fleet\/seats\/([^/]+)\/events\/[^/]+\/ack$/u.exec(path));
      if (path !== "/v1/fleet/mcp" && !seat) return Response.json({ error: "not_found" }, { status: 404 });
      const pane = request.headers.get("x-clankie-pane") ?? "";
      if (seat && decodeURIComponent(seat[1]!) !== pane)
        return Response.json({ error: "local_pane_required" }, { status: 403 });
      const current = () => this.open && env.incoming.socket.destroyed !== true;
      const identity = {
        current,
        fleet: "default",
        pane,
        validate: async () => current() && (await this.options.prove(env.incoming.socket, pane)) && current(),
        projectProof: async () =>
          this.open ? this.options.projectProof?.(env.incoming.socket, pane) : undefined,
      };
      if (path !== "/v1/fleet/mcp" && !(await identity.validate()))
        return Response.json({ error: "local_process_membership_required" }, { status: 403 });
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
