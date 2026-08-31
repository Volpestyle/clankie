import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { FleetChangeClock, watchHerdrFleetChanges } from "../src/captain/herdr-fleet-changes.ts";

describe("FleetChangeClock", () => {
  it("wakes every reader on one change and returns immediately for an old cursor", async () => {
    vi.useFakeTimers();
    try {
      const clock = new FleetChangeClock();
      const first = clock.current();
      const waiting = clock.wait(first, 20_000);

      const changed = clock.touch();
      await expect(waiting).resolves.toBe(changed);
      await expect(clock.wait(first, 20_000)).resolves.toBe(changed);
      clock.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the same cursor when a parked read times out", async () => {
    vi.useFakeTimers();
    try {
      const clock = new FleetChangeClock();
      const cursor = clock.current();
      const waiting = clock.wait(cursor, 250);
      await vi.advanceTimersByTimeAsync(250);
      await expect(waiting).resolves.toBe(cursor);
      clock.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("subscribes to the native Herdr event feed and advances on an agent change", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-fleet-events-"));
    const socketPath = join(root, "herdr.sock");
    let statusPeer: Socket | undefined;
    let receiveSubscription!: (request: unknown) => void;
    const subscription = new Promise<unknown>((resolve) => {
      receiveSubscription = resolve;
    });
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) return;
          const request = JSON.parse(buffer.slice(0, newline)) as {
            readonly id: string;
            readonly method: string;
          };
          buffer = buffer.slice(newline + 1);
          if (request.method === "session.snapshot") {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                result: { snapshot: { panes: [{ pane_id: "w1:p1" }] } },
              })}\n`,
            );
          } else if (JSON.stringify(request).includes("pane.agent_status_changed")) {
            statusPeer = socket;
            receiveSubscription(request);
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const clock = new FleetChangeClock();
    const stop = watchHerdrFleetChanges(clock, {
      socketPath,
      summariesPath: join(root, "absent", "summaries.json"),
    });
    await expect(subscription).resolves.toMatchObject({
      method: "events.subscribe",
      params: {
        subscriptions: expect.arrayContaining([{ type: "pane.agent_status_changed", pane_id: "w1:p1" }]),
      },
    });
    const cursor = clock.current();
    const waiting = clock.wait(cursor, 1_000);
    statusPeer!.write(`${JSON.stringify({ event: "pane_agent_status_changed", data: {} })}\n`);
    await expect(waiting).resolves.not.toBe(cursor);

    stop();
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  });
});
