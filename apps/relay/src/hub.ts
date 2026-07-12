import type { WebSocket } from "ws";
import type { RelayEnvelope, RelayHello } from "./protocol.ts";

interface Peer {
  socket: WebSocket;
  hello: RelayHello;
}

/** In-memory development relay. Production replaces token equality with device-key authentication and durable routing. */
export class RelayHub {
  private readonly runners = new Map<string, Peer>();
  private readonly clients = new Map<string, Map<string, Peer>>();

  public register(socket: WebSocket, hello: RelayHello): () => void {
    if (hello.role === "runner") {
      const existing = this.runners.get(hello.workspaceId);
      existing?.socket.close(4001, "Runner replaced");
      this.runners.set(hello.workspaceId, { socket, hello });
    } else {
      const workspaceClients = this.clients.get(hello.workspaceId) ?? new Map<string, Peer>();
      workspaceClients.set(hello.deviceId, { socket, hello });
      this.clients.set(hello.workspaceId, workspaceClients);
    }
    return () => this.unregister(socket, hello);
  }

  public route(sender: RelayHello, envelope: RelayEnvelope): number {
    if (sender.workspaceId !== envelope.workspaceId) throw new Error("Cross-workspace relay attempt denied");
    if (sender.role === "runner") {
      const peers = this.clients.get(sender.workspaceId);
      let delivered = 0;
      for (const peer of peers?.values() ?? []) {
        if (peer.socket.readyState === peer.socket.OPEN) {
          peer.socket.send(JSON.stringify(envelope));
          delivered += 1;
        }
      }
      return delivered;
    }
    const runner = this.runners.get(sender.workspaceId);
    if (!runner || runner.socket.readyState !== runner.socket.OPEN) return 0;
    runner.socket.send(JSON.stringify(envelope));
    return 1;
  }

  public snapshot(): { runners: number; clients: number } {
    return {
      runners: this.runners.size,
      clients: [...this.clients.values()].reduce((sum, peers) => sum + peers.size, 0),
    };
  }

  private unregister(socket: WebSocket, hello: RelayHello): void {
    if (hello.role === "runner") {
      if (this.runners.get(hello.workspaceId)?.socket === socket) this.runners.delete(hello.workspaceId);
      return;
    }
    const peers = this.clients.get(hello.workspaceId);
    if (peers?.get(hello.deviceId)?.socket === socket) peers.delete(hello.deviceId);
    if (peers?.size === 0) this.clients.delete(hello.workspaceId);
  }
}
