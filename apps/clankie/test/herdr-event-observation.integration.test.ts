import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { FleetChangeClock, watchHerdrFleetChanges } from "../src/captain/herdr-fleet-changes.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

// Fleet observation rides the configured Herdr's own socket: no `herdr agent
// wait` process per seat, and a feed the pinned Herdr accepts (VUH-2391).
const until = async (done: () => boolean, ms = 5_000) => {
  for (const deadline = Date.now() + ms; !done();) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

it("waits for a seat's status on Herdr's socket without a subprocess", { timeout: 30_000 }, async () => {
  const herdr = await isolatedHerdr(join(tmpdir(), `clankie-herdr-wait-${process.pid}`));
  try {
    const spawned: string[] = [];
    const runner = createHerdrWatchRunner(
      () => true,
      async (args) => {
        spawned.push(args.join(" "));
        throw new Error("no Herdr subprocess expected");
      },
      undefined,
      {
        localCodexRecovery: false,
        localReadBinding: async () => ({ socketPath: herdr.socketPath, session: "default" }),
      },
    );
    const report = (state: string) =>
      herdr.cli("pane", "report-agent", herdr.pane, "--source", "test", "--agent", "codex", "--state", state);
    await report("working");
    const signal = new AbortController().signal;
    const changed = runner.waitForChange!(herdr.pane, "working", signal);
    const settled = runner.wait(herdr.pane, signal);
    await report("idle");

    expect((await changed).status).toBe("idle");
    expect((await settled).status).toBe("idle");
    // Already settled answers at once.
    expect((await runner.wait(herdr.pane, signal)).status).toBe("idle");

    await report("working");
    // Herdr can refuse the wait before the close CLI returns. Attach the
    // expected rejection now so that refusal never becomes unhandled.
    const closing = expect(runner.waitForChange!(herdr.pane, "working", signal)).rejects.toThrow();
    await herdr.cli("pane", "close", herdr.pane);
    await closing;
    expect(spawned).toEqual([]);
  } finally {
    await herdr.close();
  }
});

it("subscribes the fleet feed on the pinned Herdr and hears a pane close", { timeout: 30_000 }, async () => {
  const herdr = await isolatedHerdr(join(tmpdir(), `clankie-herdr-feed-${process.pid}`));
  const clock = new FleetChangeClock();
  const closed: string[] = [];
  let subscribed = 0;
  const stop = watchHerdrFleetChanges(clock, {
    socketPath: herdr.socketPath,
    summariesPath: join(herdr.root, "summaries.json"),
    reconnectMs: 50,
    onPaneClosed: (paneId) => closed.push(paneId),
    onSubscribed: () => subscribed++,
  });
  try {
    await until(() => subscribed > 0);
    const cursor = clock.current();
    await herdr.cli("pane", "close", herdr.foreignPane);
    await until(() => closed.length > 0);

    expect(closed).toEqual([herdr.foreignPane]);
    expect(clock.current()).not.toBe(cursor);
    // The accepted subscription stays up rather than re-connecting.
    expect(subscribed).toBe(1);
  } finally {
    stop();
    await herdr.close();
  }
});

/**
 * A relay in front of the pinned Herdr that replays the order seen on a loaded
 * runner (#655): a pane's status stream ends before the feed's `pane_closed`
 * for it arrives. Everything else passes through to the real Herdr.
 */
async function statusStreamRelay(herdrSocket: string, path: string) {
  const statusStreams = new Map<string, Set<Socket>>();
  const held: (() => void)[] = [];
  let holdClose: string | undefined;
  const server = createServer((client) => {
    const upstream = createConnection(herdrSocket);
    let request = "";
    let kind: { status: string | undefined; feed: boolean | undefined } | undefined;
    client.on("data", (chunk) => {
      upstream.write(chunk);
      if (kind !== undefined) return;
      request += chunk.toString("utf8");
      if (!request.includes("\n")) return;
      const subscriptions = (
        JSON.parse(request.slice(0, request.indexOf("\n"))) as {
          params?: { subscriptions?: { type: string; pane_id?: string }[] };
        }
      ).params?.subscriptions;
      const status = subscriptions?.find((entry) => entry.type === "pane.agent_status_changed")?.pane_id;
      kind = { status, feed: subscriptions?.some((entry) => entry.type === "pane.closed") };
      if (status !== undefined) {
        const streams = statusStreams.get(status) ?? new Set();
        streams.add(client);
        statusStreams.set(status, streams);
        client.on("close", () => streams.delete(client));
      }
    });
    let buffer = "";
    upstream.on("data", (chunk) => {
      if (kind?.feed !== true) return void client.write(chunk);
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (holdClose !== undefined && line.includes('"pane_closed"') && line.includes(`"${holdClose}"`)) {
          // Herdr ends the closing pane's status stream first; the close follows.
          for (const stream of statusStreams.get(holdClose) ?? []) stream.destroy();
          held.push(() => client.write(`${line}\n`));
          setTimeout(() => held.splice(0).forEach((send) => send()), 300);
        } else client.write(`${line}\n`);
      }
    });
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  server.listen(path);
  await once(server, "listening");
  return {
    holdCloseOf: (paneId: string) => {
      holdClose = paneId;
    },
    endStatusStream: (paneId: string) => {
      for (const stream of statusStreams.get(paneId) ?? []) stream.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

it(
  "hears a pane close whose status stream Herdr ends first, and still rebuilds for a live pane's",
  { timeout: 30_000 },
  async () => {
    const herdr = await isolatedHerdr(join(tmpdir(), `clankie-herdr-order-${process.pid}`));
    const relay = await statusStreamRelay(herdr.socketPath, join(herdr.root, "relay.sock"));
    const closed: string[] = [];
    let subscribed = 0;
    const stop = watchHerdrFleetChanges(new FleetChangeClock(), {
      socketPath: join(herdr.root, "relay.sock"),
      summariesPath: join(herdr.root, "summaries.json"),
      reconnectMs: 50,
      onPaneClosed: (paneId) => closed.push(paneId),
      onSubscribed: () => subscribed++,
    });
    try {
      await until(() => subscribed > 0);
      relay.holdCloseOf(herdr.foreignPane);
      await herdr.cli("pane", "close", herdr.foreignPane);
      await until(() => closed.length > 0);
      expect(closed).toEqual([herdr.foreignPane]);
      // The ended stream belonged to a pane that is gone: the feed was kept.
      expect(subscribed).toBe(1);

      // A live pane's stream ending leaves the subscription incomplete: rebuild.
      relay.endStatusStream(herdr.pane);
      await until(() => subscribed > 1);
    } finally {
      stop();
      await relay.close();
      await herdr.close();
    }
  },
);
