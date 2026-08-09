import type { TerminalJsonDuplex } from "./terminal-gateway.ts";

export { TerminalGatewayClient } from "./terminal-gateway.ts";
export type { TerminalJsonDuplex } from "./terminal-gateway.ts";

export interface TerminalJsonWebSocket {
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type TerminalJsonWebSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => TerminalJsonWebSocket;

export interface OpenTerminalJsonWebSocketOptions {
  endpoint: { url: string; token: string };
  signal: AbortSignal;
  createSocket: TerminalJsonWebSocketFactory;
  transportUnavailable: Error;
}

/** Opens one bearer-authenticated WebSocket as a JSON terminal duplex. */
export async function openTerminalJsonWebSocket(
  options: OpenTerminalJsonWebSocketOptions,
): Promise<TerminalJsonDuplex> {
  const { endpoint, signal, createSocket, transportUnavailable } = options;
  if (signal.aborted) throw transportUnavailable;

  const queue = new AsyncMessageQueue();
  const socket = createSocket(endpoint.url, { Authorization: `Bearer ${endpoint.token}` });
  let opened = false;
  let settled = false;
  let closed = false;
  let resolveOpen!: () => void;
  let rejectOpen!: (reason: Error) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });

  const detachAbort = (): void => signal.removeEventListener("abort", abort);
  const finish = (): void => {
    queue.finish();
    detachAbort();
  };
  const abort = (): void => {
    if (!settled) {
      settled = true;
      rejectOpen(transportUnavailable);
    }
    finish();
    if (!closed) {
      closed = true;
      try {
        socket.close(1000, "observer_closed");
      } catch {
        // The abort boundary is already settled; transport teardown is best effort.
      }
    }
  };

  socket.onopen = () => {
    if (settled) return;
    opened = true;
    settled = true;
    resolveOpen();
  };
  socket.onmessage = (event) => {
    if (!opened || closed) return;
    if (typeof event.data !== "string") {
      queue.push(event.data);
      return;
    }
    try {
      queue.push(JSON.parse(event.data));
    } catch {
      // Preserve the invalid value for strict gateway schema classification.
      queue.push(event.data);
    }
  };
  socket.onerror = () => {
    if (!settled) {
      settled = true;
      rejectOpen(transportUnavailable);
    }
    finish();
  };
  socket.onclose = () => {
    closed = true;
    if (!settled) {
      settled = true;
      rejectOpen(transportUnavailable);
    }
    finish();
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    await openPromise;
  } catch (error) {
    abort();
    throw error;
  }

  return {
    send(message) {
      if (closed || socket.readyState !== 1) throw transportUnavailable;
      socket.send(JSON.stringify(message));
    },
    messages() {
      return queue;
    },
    close() {
      abort();
    },
  };
}

class AsyncMessageQueue implements AsyncIterable<unknown> {
  readonly #values: unknown[] = [];
  readonly #waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  #done = false;

  push(value: unknown): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        if (this.#values.length > 0) return Promise.resolve({ value: this.#values.shift(), done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
