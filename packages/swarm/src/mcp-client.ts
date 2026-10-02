import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** Tool transport only. Closing it never closes the durable actor's inbox. */
export class LazyMcpClient {
  private pending: Promise<Client> | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private users = 0;
  private closed = false;

  private readonly connect: () => Promise<Client>;
  private readonly idleMs: number;

  constructor(connect: () => Promise<Client>, idleMs = 60_000) {
    this.connect = connect;
    this.idleMs = idleMs;
  }

  async use<T>(call: (client: Client) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Swarm tool client closed");
    clearTimeout(this.idle);
    this.users++;
    try {
      const pending = this.get();
      let client = await pending;
      if (client.transport === undefined) {
        if (this.pending === pending) this.pending = undefined;
        client = await this.get();
      }
      if (this.closed) throw new Error("Swarm tool client closed");
      // Never retry a possibly committed tool call.
      return await call(client);
    } finally {
      this.users--;
      if (!this.closed && this.users === 0) {
        this.idle = setTimeout(() => {
          void this.retire();
        }, this.idleMs);
        this.idle.unref();
      }
    }
  }

  private get(): Promise<Client> {
    if (!this.pending) {
      const pending = this.connect();
      this.pending = pending;
      void pending.catch(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    }
    return this.pending!;
  }

  private async retire(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    await pending?.then((client) => client.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idle);
    await this.retire();
  }
}
