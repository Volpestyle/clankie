import { describe, expect, it } from "vitest";
import { TerminalClientMessageSchema } from "@clankie/terminal-protocol";
import {
  TerminalGatewayClient,
  TerminalGatewayClientError,
  type TerminalGatewayStreamEvent,
  type TerminalJsonDuplex,
} from "../src/index.ts";

const attribution = { principalId: "principal-1", deviceId: "device-1", clientInstanceId: "client-1" };
const terminalId = "terminal-1";
const subscriptionId = "subscription-1";
const timestamp = "2026-07-12T12:00:00.000Z";
const restore = { format: "vt_restore_v1", encoding: "base64", data: "G1sySg==" };
const openLifecycle = { state: "open" as const };
const closedLifecycle = {
  state: "closed" as const,
  sequence: 3,
  reason: "exited" as const,
  exitCode: 0,
  signal: null,
  closedAt: timestamp,
};
const fullWireCapabilities = {
  observe: true,
  resume: true,
  vtRestoreSnapshot: true,
  controlLease: true,
  input: true,
  resize: true,
};
const observeWireCapabilities = {
  observe: true,
  resume: true,
  vtRestoreSnapshot: true,
  controlLease: false,
  input: false,
  resize: false,
};

const streamBase = { protocolVersion: 1, terminalId, subscriptionId };

function subscribedMessage(options) {
  return {
    protocolVersion: 1,
    type: "terminal.subscribed",
    requestId: options.requestId,
    terminalId,
    subscriptionId,
    cursor: { sequence: options.cursor },
    initialDelivery: options.initialDelivery,
    lifecycle: options.lifecycle ?? openLifecycle,
    capabilities: options.capabilities ?? fullWireCapabilities,
    capabilitiesRevision: options.revision ?? 1,
  };
}

function snapshotMessage(options) {
  const afterSequence = options.afterSequence;
  return {
    ...streamBase,
    type: "terminal.snapshot",
    boundary: { afterSequence, nextSequence: afterSequence + 1, parserState: "quiescent" },
    geometry: options.geometry ?? { columns: 80, rows: 24 },
    restore,
    lifecycle: options.lifecycle ?? openLifecycle,
  };
}

function outputMessage(sequence, data = "aGk=") {
  return { ...streamBase, type: "terminal.output", sequence, encoding: "base64", data };
}

function geometryMessage(sequence, geometry = { columns: 100, rows: 30 }) {
  return { ...streamBase, type: "terminal.geometry", sequence, geometry, cause: "pty" };
}

function closedMessage(sequence, reason = "exited") {
  return {
    ...streamBase,
    type: "terminal.closed",
    sequence,
    reason,
    exitCode: reason === "exited" ? 0 : null,
    signal: reason === "signaled" ? "SIGTERM" : null,
    closedAt: timestamp,
  };
}

function capabilitiesChangedMessage(revision, capabilities = observeWireCapabilities) {
  return { ...streamBase, type: "terminal.capabilities_changed", revision, capabilities };
}

function resyncRequiredMessage(requestedAfterSequence) {
  return {
    protocolVersion: 1,
    type: "terminal.resync_required",
    terminalId,
    subscriptionId,
    requestedAfterSequence,
    availableFromSequence: requestedAfterSequence + 1,
    reason: "replay_unavailable",
    lifecycle: openLifecycle,
  };
}

function discoverySession(id, source, title, capabilities = observeWireCapabilities) {
  return {
    terminalId: id,
    workerRunId: "worker-1",
    title,
    source,
    geometry: { columns: 80, rows: 24 },
    lastSequence: 10,
    lifecycle: openLifecycle,
    capabilities,
    capabilitiesRevision: 1,
  };
}

/** Backpressured async message queue with reactive push and end. */
class InboundQueue {
  #items: unknown[] = [];
  #waiters: Array<(result: IteratorResult<unknown>) => void> = [];
  #ended = false;

  push(item: unknown): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.#items.push(item);
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift();
        continue;
      }
      if (this.#ended) return;
      const result = await new Promise<IteratorResult<unknown>>((resolve) => this.#waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}

interface ServerContext {
  push: (message: unknown) => void;
  end: () => void;
  sent: unknown[];
}

type Server = (sent: { type: string; requestId?: string }, context: ServerContext) => void;

/** Deterministic fake duplex that reacts to each outbound cf07 message. */
class FakeDuplex implements TerminalJsonDuplex {
  public readonly sent: Array<{ type: string; requestId?: string }> = [];
  public closed = false;
  readonly #queue = new InboundQueue();
  readonly #server: Server;

  public constructor(server: Server, signal: AbortSignal) {
    this.#server = server;
    if (signal.aborted) this.#queue.end();
    else signal.addEventListener("abort", () => this.#queue.end(), { once: true });
  }

  public send(message: unknown): void {
    const typed = message as { type: string; requestId?: string };
    this.sent.push(typed);
    this.#server(typed, {
      push: (item) => this.#queue.push(item),
      end: () => this.#queue.end(),
      sent: this.sent,
    });
  }

  public messages(): AsyncIterable<unknown> {
    return this.#queue;
  }

  public close(): void {
    this.closed = true;
    this.#queue.end();
  }
}

function makeClient(server: Server) {
  let duplex: FakeDuplex | undefined;
  const client = new TerminalGatewayClient({
    connect: (signal) => {
      duplex = new FakeDuplex(server, signal);
      return duplex;
    },
    attribution,
  });
  return {
    client,
    getDuplex: () => {
      if (!duplex) throw new Error("connect was not called");
      return duplex;
    },
  };
}

async function collect(
  iterable: AsyncIterable<TerminalGatewayStreamEvent>,
): Promise<TerminalGatewayStreamEvent[]> {
  const events: TerminalGatewayStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const eventTypes = (events: TerminalGatewayStreamEvent[]): string[] => events.map((event) => event.type);

describe("TerminalGatewayClient.listSessions", () => {
  it("discovers sessions and maps source and observe-only capabilities", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.discover") {
        context.push({
          protocolVersion: 1,
          type: "terminal.discovery",
          requestId: sent.requestId,
          grantedScopes: ["observe"],
          sessions: [
            discoverySession("t-runner", "runner_pty", "Runner PTY"),
            discoverySession("t-tmux", "tmux", "Tmux"),
            discoverySession("t-generic", "generic", "Generic"),
            discoverySession("t-herdr", "herdr", "Herdr", fullWireCapabilities),
          ],
        });
      }
    });

    const sessions = await client.listSessions();

    expect(sessions).toEqual([
      {
        terminalId: "t-runner",
        label: "Runner PTY",
        source: "runner",
        capabilities: { observe: true, control: false, input: false, resize: false },
      },
      {
        terminalId: "t-tmux",
        label: "Tmux",
        source: "runner",
        capabilities: { observe: true, control: false, input: false, resize: false },
      },
      {
        terminalId: "t-generic",
        label: "Generic",
        source: "runner",
        capabilities: { observe: true, control: false, input: false, resize: false },
      },
      {
        terminalId: "t-herdr",
        label: "Herdr",
        source: "herdr",
        capabilities: { observe: true, control: false, input: false, resize: false },
      },
    ]);

    const duplex = getDuplex();
    expect(duplex.sent).toHaveLength(1);
    expect(duplex.sent[0]).toMatchObject({ type: "terminal.discover", supportedProtocolVersions: [1] });
    expect(duplex.sent.some((message) => message.type === "terminal.sessions.list")).toBe(false);
    expect(duplex.closed).toBe(true);
  });

  it("rejects a discovery response whose request id does not correlate", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.discover") {
        context.push({
          protocolVersion: 1,
          type: "terminal.discovery",
          requestId: "unrelated",
          grantedScopes: ["observe"],
          sessions: [],
        });
      }
    });
    await expect(client.listSessions()).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("rejects a correlated discovery whose granted scopes omit observe", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.discover") {
        context.push({
          protocolVersion: 1,
          type: "terminal.discovery",
          requestId: sent.requestId,
          grantedScopes: ["control"],
          sessions: [discoverySession("t-runner", "runner_pty", "Runner PTY")],
        });
      }
    });
    await expect(client.listSessions()).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("accepts a discovery whose granted scopes include observe alongside control", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.discover") {
        context.push({
          protocolVersion: 1,
          type: "terminal.discovery",
          requestId: sent.requestId,
          grantedScopes: ["observe", "control"],
          sessions: [discoverySession("t-runner", "runner_pty", "Runner PTY")],
        });
      }
    });
    await expect(client.listSessions()).resolves.toMatchObject([
      { terminalId: "t-runner", source: "runner" },
    ]);
  });
});

describe("TerminalGatewayClient.observe fresh subscribe", () => {
  it("requires subscribed(snapshot) then a snapshot before ordered output and one close", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1));
        context.push(closedMessage(2));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "output", "closed"]);
    expect(events[0]).toEqual({
      type: "capabilities",
      capabilities: { observe: true, control: false, input: false, resize: false },
    });
    expect(events[1]).toEqual({
      type: "snapshot",
      snapshot: {
        terminalId,
        geometry: { columns: 80, rows: 24 },
        boundary: { afterSequence: 0, nextSequence: 1 },
        restoreBase64: restore.data,
      },
    });
    expect(events[2]).toEqual({ type: "output", frame: { terminalId, sequence: 1, dataBase64: "aGk=" } });
    expect(events[3]).toEqual({ type: "closed", reason: "exited" });

    const duplex = getDuplex();
    expect(duplex.sent).toHaveLength(1);
    expect(duplex.sent[0]).toMatchObject({ type: "terminal.subscribe", terminalId, attribution });
    expect(duplex.closed).toBe(true);
  });

  it("fails closed when output arrives before the required snapshot", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(outputMessage(1));
      }
    });
    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "snapshot_required" });
  });

  it("fails closed when a fresh subscribe does not deliver a snapshot", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(subscribedMessage({ requestId: sent.requestId, initialDelivery: "live", cursor: 0 }));
      }
    });
    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });
});

describe("TerminalGatewayClient.observe resume", () => {
  it("tails retained replay frames strictly after the resume cursor", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(subscribedMessage({ requestId: sent.requestId, initialDelivery: "replay", cursor: 5 }));
        context.push(outputMessage(6));
        context.push(outputMessage(7));
        context.push(closedMessage(8));
      }
    });

    const events = await collect(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );

    expect(eventTypes(events)).toEqual(["capabilities", "output", "output", "closed"]);
    expect(events[1]).toMatchObject({ frame: { sequence: 6 } });
    expect(events[2]).toMatchObject({ frame: { sequence: 7 } });
    expect(getDuplex().sent.map((message) => message.type)).toEqual(["terminal.resume"]);
  });

  it("accepts a server-chosen subscribed(snapshot) resume without any resync", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 5 }),
        );
        context.push(snapshotMessage({ afterSequence: 9 }));
        context.push(outputMessage(10));
        context.push(closedMessage(11));
      }
    });

    const events = await collect(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "output", "closed"]);
    expect(events[1]).toMatchObject({ snapshot: { boundary: { afterSequence: 9 } } });
    expect(getDuplex().sent.map((message) => message.type)).toEqual(["terminal.resume"]);
  });

  it("recovers a failed resume through resync_required, resync, subscribed(snapshot), snapshot", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(resyncRequiredMessage(5));
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 5 }),
        );
        context.push(snapshotMessage({ afterSequence: 5 }));
        context.push(outputMessage(6));
        context.push(closedMessage(7));
      }
    });

    const events = await collect(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "output", "closed"]);
    const duplex = getDuplex();
    expect(duplex.sent.map((message) => message.type)).toEqual(["terminal.resume", "terminal.resync"]);
    expect(duplex.sent[1]).toMatchObject({ cursor: { sequence: 5 }, cause: "reconnect" });
  });
});

describe("TerminalGatewayClient.observe tail behavior", () => {
  it("ignores duplicates and resyncs on a positive output gap", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1));
        context.push(outputMessage(1, "d29ybGQ=")); // duplicate: <= cursor, ignored
        context.push(outputMessage(5)); // positive gap
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 4 }),
        );
        context.push(snapshotMessage({ afterSequence: 5 }));
        context.push(outputMessage(6));
        context.push(closedMessage(7));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual([
      "capabilities",
      "snapshot",
      "output",
      "snapshot",
      "output",
      "closed",
    ]);
    expect(events.filter((event) => event.type === "output")).toHaveLength(2);
    const duplex = getDuplex();
    const resync = duplex.sent.find((message) => message.type === "terminal.resync");
    expect(resync).toMatchObject({ cursor: { sequence: 1 }, cause: "gap" });
  });

  it("pauses at N-1 on geometry N and requires a replacement snapshot boundary through N", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1)); // cursor -> 1
        context.push(geometryMessage(2)); // geometry at N = 2, contiguous
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 2 }),
        );
        context.push(snapshotMessage({ afterSequence: 2, geometry: { columns: 120, rows: 40 } }));
        context.push(outputMessage(3));
        context.push(closedMessage(4));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual([
      "capabilities",
      "snapshot",
      "output",
      "snapshot",
      "output",
      "closed",
    ]);
    expect(events[3]).toMatchObject({
      snapshot: { geometry: { columns: 120, rows: 40 }, boundary: { afterSequence: 2 } },
    });
    const resync = getDuplex().sent.find((message) => message.type === "terminal.resync");
    expect(resync).toMatchObject({ cursor: { sequence: 1 } });
  });

  it("rejects a replacement snapshot whose boundary excludes the geometry sequence", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1));
        context.push(geometryMessage(2));
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 1 }),
        );
        context.push(snapshotMessage({ afterSequence: 1 })); // excludes geometry sequence 2
      }
    });
    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("applies only strictly greater capability revisions as one event each", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({
            requestId: sent.requestId,
            initialDelivery: "snapshot",
            cursor: 0,
            revision: 5,
          }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(capabilitiesChangedMessage(4)); // stale
        context.push(capabilitiesChangedMessage(5)); // equal
        context.push(capabilitiesChangedMessage(6)); // apply
        context.push(closedMessage(1));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(events.filter((event) => event.type === "capabilities")).toHaveLength(2);
    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "capabilities", "closed"]);
    for (const event of events.filter((event) => event.type === "capabilities")) {
      expect(event).toEqual({
        type: "capabilities",
        capabilities: { observe: true, control: false, input: false, resize: false },
      });
    }
  });
});

describe("TerminalGatewayClient.observe closure convergence", () => {
  it("delivers exactly one close when closure lives only in the snapshot lifecycle", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({
            requestId: sent.requestId,
            initialDelivery: "snapshot",
            cursor: 3,
            lifecycle: closedLifecycle,
          }),
        );
        context.push(snapshotMessage({ afterSequence: 3, lifecycle: closedLifecycle }));
        context.end();
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "closed"]);
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
    expect(events[2]).toEqual({ type: "closed", reason: "exited" });
    expect(getDuplex().closed).toBe(true);
  });

  it("maps a retained ordered terminal.closed to exactly one close", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1));
        context.push(closedMessage(2, "signaled"));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "output", "closed"]);
    expect(events.filter((event) => event.type === "closed")).toHaveLength(1);
    expect(events[3]).toEqual({ type: "closed", reason: "signaled" });
  });
});

describe("TerminalGatewayClient.observe cursor integrity", () => {
  it("rejects a retained replay resume whose ack cursor is lower than the requested cursor", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(subscribedMessage({ requestId: sent.requestId, initialDelivery: "replay", cursor: 4 }));
        context.push(outputMessage(5));
      }
    });
    await expect(
      collect(client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("rejects a retained live resume whose ack cursor is higher than the requested cursor", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(subscribedMessage({ requestId: sent.requestId, initialDelivery: "live", cursor: 6 }));
        context.push(outputMessage(7));
      }
    });
    await expect(
      collect(client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("rejects an initial resync_required whose requested cursor does not match the resume cursor", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(resyncRequiredMessage(4)); // resume was from 5
      }
    });
    await expect(
      collect(client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("rejects an active resync_required whose requested cursor does not match the app cursor", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1)); // app cursor -> 1
        context.push(resyncRequiredMessage(99)); // stale/mismatched
      }
    });
    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("recovers an active resync_required that matches the app cursor", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1)); // app cursor -> 1
        context.push(resyncRequiredMessage(1)); // matches app cursor
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 4 }),
        );
        context.push(snapshotMessage({ afterSequence: 5 }));
        context.push(outputMessage(6));
        context.push(closedMessage(7));
      }
    });

    const events = await collect(client.observe({ terminalId, signal: new AbortController().signal }));

    expect(eventTypes(events)).toEqual([
      "capabilities",
      "snapshot",
      "output",
      "snapshot",
      "output",
      "closed",
    ]);
    const resync = getDuplex().sent.find((message) => message.type === "terminal.resync");
    expect(resync).toMatchObject({ cursor: { sequence: 1 }, cause: "reconnect" });
  });

  it("rejects a resume snapshot whose boundary regresses below the requested cursor (probe D)", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 5 }),
        );
        context.push(snapshotMessage({ afterSequence: 2 })); // boundary 2 < requested 5
        context.push(outputMessage(3));
      }
    });
    await expect(
      collect(client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });

  it("accepts a resume snapshot whose boundary equals the requested cursor", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 5 }),
        );
        context.push(snapshotMessage({ afterSequence: 5 })); // boundary == requested 5
        context.push(outputMessage(6));
        context.push(closedMessage(7));
      }
    });

    const events = await collect(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );

    expect(eventTypes(events)).toEqual(["capabilities", "snapshot", "output", "closed"]);
    expect(events[1]).toMatchObject({ snapshot: { boundary: { afterSequence: 5 } } });
    expect(events[2]).toMatchObject({ frame: { sequence: 6 } });
  });
});

describe("TerminalGatewayClient.observe gateway error classification", () => {
  const gatewayError = (requestId?: string) => ({
    protocolVersion: 1,
    type: "terminal.error",
    requestId: requestId ?? null,
    terminalId,
    code: "internal",
    message: "server-detail-must-not-leak",
    retryable: false,
  });

  async function expectGatewayError(iterable: AsyncIterable<TerminalGatewayStreamEvent>): Promise<void> {
    let caught: unknown;
    try {
      await collect(iterable);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TerminalGatewayClientError);
    expect((caught as TerminalGatewayClientError).code).toBe("gateway_error");
    expect((caught as TerminalGatewayClientError).message).not.toContain("server-detail-must-not-leak");
  }

  it("classifies terminal.error during the initial subscribe as gateway_error", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") context.push(gatewayError(sent.requestId));
    });
    await expectGatewayError(client.observe({ terminalId, signal: new AbortController().signal }));
  });

  it("classifies terminal.error during the initial resume as gateway_error", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") context.push(gatewayError(sent.requestId));
    });
    await expectGatewayError(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );
  });

  it("classifies terminal.error during the resync ack as gateway_error", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") context.push(resyncRequiredMessage(5));
      else if (sent.type === "terminal.resync") context.push(gatewayError(sent.requestId));
    });
    await expectGatewayError(
      client.observe({ terminalId, afterSequence: 5, signal: new AbortController().signal }),
    );
  });

  it("classifies terminal.error during the required snapshot phase as gateway_error", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(gatewayError()); // expected snapshot, gateway error instead
      }
    });
    await expectGatewayError(client.observe({ terminalId, signal: new AbortController().signal }));
  });
});

describe("TerminalGatewayClient.observe transport and safety", () => {
  it("fails closed on a malformed server payload without echoing it", async () => {
    const secret = "super-secret-terminal-bytes";
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push({ type: "not-a-terminal-message", data: secret });
      }
    });

    let caught: unknown;
    try {
      await collect(client.observe({ terminalId, signal: new AbortController().signal }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TerminalGatewayClientError);
    expect((caught as TerminalGatewayClientError).code).toBe("malformed_server_message");
    expect((caught as TerminalGatewayClientError).message).not.toContain(secret);
  });

  it("fails the iterable when the transport ends before the terminal closes", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        context.push(outputMessage(1));
        context.end(); // unexpected transport end, no abort
      }
    });

    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "transport_closed" });
    expect(getDuplex().closed).toBe(true);
  });

  it("stops cleanly on abort and closes only the duplex", async () => {
    const controller = new AbortController();
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 0 }),
        );
        context.push(snapshotMessage({ afterSequence: 0 }));
        // no closure: the client tails and awaits
      }
    });

    const iterator = client.observe({ terminalId, signal: controller.signal })[Symbol.asyncIterator]();
    expect(await iterator.next()).toMatchObject({ value: { type: "capabilities" }, done: false });
    expect(await iterator.next()).toMatchObject({ value: { type: "snapshot" }, done: false });
    const pending = iterator.next();
    controller.abort();
    const settled = await pending;
    expect(settled.done).toBe(true);
    expect(getDuplex().closed).toBe(true);
  });

  it("validates every outbound message against the strict cf07 client schema", async () => {
    const { client, getDuplex } = makeClient((sent, context) => {
      if (sent.type === "terminal.resume") {
        context.push(resyncRequiredMessage(2));
      } else if (sent.type === "terminal.resync") {
        context.push(
          subscribedMessage({ requestId: sent.requestId, initialDelivery: "snapshot", cursor: 2 }),
        );
        context.push(snapshotMessage({ afterSequence: 2 }));
        context.push(closedMessage(3));
      }
    });

    await collect(client.observe({ terminalId, afterSequence: 2, signal: new AbortController().signal }));

    const duplex = getDuplex();
    expect(duplex.sent.length).toBeGreaterThan(0);
    for (const message of duplex.sent) {
      expect(TerminalClientMessageSchema.safeParse(message).success).toBe(true);
      expect(message).toMatchObject({ attribution });
    }
  });

  it("rejects a subscribed acknowledgement whose request id does not correlate", async () => {
    const { client } = makeClient((sent, context) => {
      if (sent.type === "terminal.subscribe") {
        context.push(subscribedMessage({ requestId: "wrong-id", initialDelivery: "snapshot", cursor: 0 }));
        context.push(snapshotMessage({ afterSequence: 0 }));
      }
    });
    await expect(
      collect(client.observe({ terminalId, signal: new AbortController().signal })),
    ).rejects.toMatchObject({ code: "unexpected_message" });
  });
});
