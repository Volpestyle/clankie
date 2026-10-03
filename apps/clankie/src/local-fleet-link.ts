import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { HerdrBinding } from "@clankie/protocol";

export interface LocalFleetIdentity {
  readonly pane: string;
  validate(): Promise<boolean>;
}

/** Authority exists only for a request admitted by the separate local listener. */
export class LocalFleetLink {
  private readonly admitted = new WeakMap<Request, LocalFleetIdentity>();
  private open = true;
  private published: string | undefined;
  private readonly options: {
    directory: string;
    binding(): Promise<HerdrBinding | undefined>;
    prove(socket: Socket, pane: string): Promise<boolean>;
  };
  constructor(options: LocalFleetLink["options"]) {
    this.options = options;
  }

  identity(request: Request): LocalFleetIdentity | undefined {
    return this.admitted.get(request);
  }

  fetch(forward: (request: Request) => Response | Promise<Response>) {
    return async (request: Request, env: HttpBindings | Http2Bindings): Promise<Response> => {
      const path = new URL(request.url).pathname;
      const seat = /^\/v1\/fleet\/seats\/([^/]+)\/(events|hook|messages)$/u.exec(path);
      if (path !== "/v1/fleet/mcp" && !seat) return Response.json({ error: "not_found" }, { status: 404 });
      const pane = request.headers.get("x-clankie-pane") ?? "";
      if (seat && decodeURIComponent(seat[1]!) !== pane)
        return Response.json({ error: "local_pane_required" }, { status: 403 });
      const identity = {
        pane,
        validate: async () => this.open && this.options.prove(env.incoming.socket, pane),
      };
      if (!(await identity.validate()))
        return Response.json({ error: "local_process_membership_required" }, { status: 403 });
      this.admitted.set(request, identity);
      try {
        return await forward(request);
      } finally {
        this.admitted.delete(request);
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
