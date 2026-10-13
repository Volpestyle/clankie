import { createServer, request, type ServerResponse } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import { FleetSeatInputCapabilitiesSchema } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { readFleetSeatCapabilities } from "../src/captain/fleet-seat-capabilities.ts";

it("bounds fresh capability I/O at four and preserves seat order across reversed responses", async () => {
  const seats: HerdrAgentSnapshot[] = Array.from({ length: 9 }, (_, index) => ({
    agent: "codex",
    paneId: `seat-${index}`,
    terminalId: `terminal-${index}`,
    title: `Worker ${index}`,
    status: "working",
  }));
  const expected = seats.map((_, index) => ({
    deliveryModes: index % 3 === 0 ? ["queue"] : index % 3 === 1 ? ["steer"] : [],
    interrupt: index % 2 === 0,
    nextTurnOnly: index % 3 === 0,
  }));
  let active = 0;
  let maximum = 0;
  let received = 0;
  const completed: number[] = [];
  const pending: { index: number; response: ServerResponse }[] = [];
  const server = createServer((req, response) => {
    const index = Number(req.url!.slice("/seat-".length));
    received++;
    active++;
    maximum = Math.max(maximum, active);
    pending.push({ index, response });
    // Complete real HTTP reads in reverse batches. A serial implementation
    // cannot reach the first release; unbounded fan-out exceeds the observed cap.
    if (pending.length === 4 || received === seats.length) {
      for (const entry of pending.splice(0).sort((a, b) => b.index - a.index)) {
        completed.push(entry.index);
        active--;
        entry.response.end(JSON.stringify(expected[entry.index]));
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test server address");
  try {
    const results = await readFleetSeatCapabilities(
      seats,
      (seat) =>
        new Promise((resolve, reject) => {
          const req = request(
            `http://127.0.0.1:${address.port}/${seat.paneId}`,
            { agent: false },
            (response) => {
              let body = "";
              response.on("data", (chunk) => (body += chunk));
              response.on("error", reject);
              response.on("end", () => {
                try {
                  resolve(FleetSeatInputCapabilitiesSchema.parse(JSON.parse(body)));
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.on("error", reject);
          req.end();
        }),
    );
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(received).toBe(seats.length);
    expect(completed).not.toEqual(seats.map((_, index) => index));
    expect(results).toEqual(expected);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
