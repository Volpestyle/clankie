import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import { BodyLeaseStore } from "./body-leases.ts";
import { ComputerBody } from "./computer-body.ts";
import { registerComputerRoutes } from "./computer-http.ts";
import { WindowsComputerAdapter, type WindowsComputerObservationClient } from "./computer-windows.ts";

/** Native node_repl entry point. No model, app launch, helper process or input is started. */
interface WindowsComputerHostOptions {
  sky: WindowsComputerObservationClient;
  machineId: string;
  conversationId: string;
  directory: string;
  /** Existing Clankie service, on this PC or through an authenticated SSH forward. */
  authorityURL: string;
}

/** Authenticated HTTP projection of a supplied native observation client. */
export class WindowsComputerHost {
  readonly app: Hono;
  readonly bodyId: string;
  readonly conversationId: string;
  private readonly store: BodyLeaseStore;
  private open = true;
  constructor(options: WindowsComputerHostOptions) {
    const authority = new URL("/v1/computer/authority", options.authorityURL);
    if (
      authority.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(authority.hostname) ||
      authority.username ||
      authority.password
    )
      throw new Error("Computer authority must use a loopback Clankie service or SSH forward");
    const conversationId = z.string().min(1).max(256).parse(options.conversationId);
    const adapter = new WindowsComputerAdapter(options.sky, options.machineId);
    const store = new BodyLeaseStore(join(options.directory, "lease"));
    const body = new ComputerBody(adapter, store, join(options.directory, "journal"));
    this.bodyId = adapter.bodyId;
    this.conversationId = conversationId;
    this.store = store;
    this.app = new Hono();
    const app = this.app;
    registerComputerRoutes(app, {
      body,
      identity: async (request, selected) => {
        if (selected !== conversationId || !this.open || request.signal.aborted) return undefined;
        const bearer = request.headers.get("authorization");
        if (bearer === null || !bearer.startsWith("Bearer ")) return undefined;
        const authorize = async (action: "effect" | "recover") => {
          if (!this.open || request.signal.aborted) return false;
          try {
            const response = await fetch(authority, {
              method: "POST",
              headers: { authorization: bearer, "content-type": "application/json" },
              body: JSON.stringify({ conversationId, action }),
              signal: AbortSignal.timeout(5000),
              redirect: "error",
            });
            const result = z
              .object({ conversationId: z.literal(conversationId), authorized: z.literal(true) })
              .safeParse(await response.json());
            return response.ok && result.success && this.open && !request.signal.aborted;
          } catch {
            return false;
          }
        };
        if (!(await authorize("effect"))) return undefined;
        return {
          conversationId,
          route: { owner: { conversationId }, mode: "machine" },
          current: () => this.open && !request.signal.aborted,
          authorize: (_resource, action) => authorize(action),
        };
      },
    });
  }
  close() {
    this.open = false;
    this.store.close();
  }
}

/** Native node_repl entry point; no model, app launch, helper or input is started. */
export async function startWindowsComputerHost(options: WindowsComputerHostOptions) {
  const native = (globalThis as { nodeRepl?: { rpc?: unknown } }).nodeRepl;
  if (process.platform !== "win32" || typeof native?.rpc !== "function")
    throw new Error("Start the Windows computer host in the native harness's trusted node_repl");
  const host = new WindowsComputerHost(options);
  const server = serve({ fetch: host.app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (server.listening) resolve();
      else server.once("listening", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Windows computer host has no listener");
    return {
      bodyId: host.bodyId,
      conversationId: host.conversationId,
      url: `http://127.0.0.1:${address.port}`,
      inputReady: false,
      async close() {
        host.close();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  } catch (error) {
    server.close();
    host.close();
    throw error;
  }
}
