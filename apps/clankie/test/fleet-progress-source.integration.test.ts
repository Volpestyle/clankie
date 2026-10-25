import { createServer } from "node:http";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { createLogger } from "@clankie/observability";
import { FleetProgressObserver } from "../src/fleet-progress.ts";

it("keeps one timed-out HTTP read in flight, observes other sources, and serializes its error", async () => {
  const root = await mkdtemp(join(tmpdir(), "fleet-progress-source-"));
  const output = createWriteStream(join(root, "errors.jsonl"));
  const logger = createLogger({ service: "progress-proof" }, {}, output);
  let calls = 0;
  let readCompleted: Promise<unknown> | undefined;
  let release: (() => void) | undefined;
  const server = createServer((_request, response) => {
    calls++;
    const reply = () => response.end("[]");
    if (calls === 1) release = reply;
    else if (calls === 2) {
      response.statusCode = 503;
      reply();
    } else reply();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No fixture address");
  let healthyReads = 0;
  const observer = new FleetProgressObserver({
    path: join(root, "incidents.json"),
    sources: [
      {
        prefix: "blocked",
        read: () => {
          const reading = fetch(`http://127.0.0.1:${address.port}`).then((response) => {
            if (!response.ok) throw Error(`Progress HTTP ${response.status}`);
            return response.json();
          });
          readCompleted = reading;
          return reading;
        },
      },
      {
        prefix: "healthy",
        read: async () => {
          healthyReads++;
          return [];
        },
      },
    ],
    notify: async () => true,
    onError: (error) => logger.warn({ event: "fleet.progress.unavailable", err: error }),
  });
  try {
    await observer.observe();
    expect(calls).toBe(1);
    expect(healthyReads).toBe(1);
    await Promise.all([observer.observe(), observer.observe()]);
    expect(calls).toBe(1);
    expect(healthyReads).toBe(2);
    release!();
    // Wait for the actual HTTP response to finish the retained read.
    await readCompleted;
    await setImmediate();
    await observer.observe();
    expect(calls).toBe(2);
    expect(healthyReads).toBe(3);
    await observer.observe();
    expect(calls).toBe(3);
    expect(healthyReads).toBe(4);
    await new Promise<void>((resolve) => output.end(resolve));
    const errors = (await readFile(join(root, "errors.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(errors).toHaveLength(3);
    expect(errors[2].err.message).toContain("Progress HTTP 503");
    for (const error of errors) {
      expect(error.err.message).toContain("blocked");
      expect(error.err.stack).toContain("Fleet progress source blocked unavailable");
      expect(error.err.type).toBe("Error");
    }
  } finally {
    observer.stop();
    release?.();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    output.destroy();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
