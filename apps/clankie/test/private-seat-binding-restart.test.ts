import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { HttpBindings } from "@hono/node-server";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as fleetRunner from "../src/captain/herdr-fleet-runner.ts";
import * as codexAdapter from "../src/captain/codex-seat-adapter.ts";
import { LocalCodexSeats } from "../src/local-codex-seats.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { socketProcessFixture } from "./helpers/local-fleet-process.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createInboundSender } from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";

it("keeps a private Codex worker's authenticated binding and reports across service replacement", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-seat-restart-"));
  const pane = "w1:p1";
  const binding = { runtime: "external" as const, session: "default", socketPath: "/trusted/socket" };
  const session = { source: "herdr:codex", kind: "id" as const, value: "worker-thread" };
  const nativeOccupantId = occupantIdForHerdrSession(session);
  const get = vi.fn(async () => ({
    paneId: pane,
    terminalId: "seat",
    agent: "codex" as const,
    status: "idle" as const,
    title: "worker",
    session,
  }));
  vi.spyOn(fleetRunner, "routeHerdrFleets").mockReturnValue({ get, wait: get, resolveTerminal: get });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const registry = () =>
    new LocalCodexSeats(
      () => binding,
      async () => "server-start",
      {
        path: join(root, "local-codex-seats.json"),
        observeOccupant: async () => nativeOccupantId,
      },
    );
  const first = registry();
  const registration = first.register(99, pane);
  await registration.bindSession?.(session.value);
  const statuses: number[] = [];
  const connected = {
    remoteAddress: "127.0.0.1",
    localAddress: "127.0.0.1",
    remotePort: 51000,
    localPort: 42000,
    destroyed: false,
    readable: true,
    writable: true,
  } as Socket;
  const service = async (seats: LocalCodexSeats, repoRoot: string) => {
    mkdirSync(repoRoot);
    const captain = createCaptain({} as CaptainDeps, {
      repoRoot,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
    });
    const prove = localFleetProof({
      platform: "darwin",
      herdrBinary: "herdr",
      binding: async () => binding,
      privateSeat: (chain, requested, observed) => seats.allows(chain, requested, observed),
      observeSocket: async (socket) =>
        socketProcessFixture(socket, "p55\nn127.0.0.1:51000->127.0.0.1:42000\n", "55 99\n99 1\n33 1\n"),
      run: async (command) => {
        expect(command).toBe("herdr");
        return JSON.stringify({ result: { process_info: { pane_id: pane, shell_pid: 33 } } });
      },
    });
    const link = new LocalFleetLink({
      directory: join(root, "discovery"),
      binding: async () => binding,
      prove,
    });
    const app = await createClankieApp({ captain, localFleet: link });
    const fetch = link.fetch((request) => app.app.fetch(request));
    const request = async (suffix: string, init?: { method: string; body: string }) => {
      const response = await fetch(
        new Request(`http://localhost/v1/fleet/seats/${encodeURIComponent(pane)}/messages${suffix}`, {
          ...init,
          headers: {
            "content-type": "application/json",
            "x-clankie-pane": pane,
            // Node's fetch supplies this on the real bridge's JSON POST.
            ...(init ? { "content-length": String(Buffer.byteLength(init.body)) } : {}),
          },
        }),
        { incoming: { socket: connected } } as HttpBindings,
      );
      statuses.push(response.status);
      return response;
    };
    return {
      request,
      close: async () => {
        await link.close();
        app.close();
        await captain.close();
      },
    };
  };
  let current: Awaited<ReturnType<typeof service>> | undefined;
  try {
    current = await service(first, join(root, "runtime-before"));
    const before = await (await current.request("")).json();
    expect(before.binding).toMatch(/^[a-f0-9]{64}$/u);
    // Recreate every service-owned object from disk while the worker stays alive.
    await current.close();
    current = await service(registry(), join(root, "runtime-after"));
    const send = createInboundSender({
      directory: join(root, "worker-receipts"),
      scope: pane,
      request: (suffix, init) => current!.request(suffix, init),
    });
    const receipt = await send("Finished after the restart");
    expect(receipt, JSON.stringify({ statuses, receipt })).toMatchObject({
      received: true,
      deliveryStage: "stored",
      binding: before.binding,
    });
    expect(statuses).toEqual([200, 200, 200]);
  } finally {
    await current?.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives the dedicated local Codex server its pane's Herdr environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-seat-env-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const adapter = vi.spyOn(codexAdapter, "createCodexSeatAdapter");
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
    localCodexProcess: () => () => {},
    localCodexSocket: () => "/worker/socket",
  });
  try {
    const options = adapter.mock.calls.at(-1)![0]!;
    expect(await options.viewEnv?.({ paneId: "w1:p1", run: async () => {} })).toEqual({
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
      HERDR_SOCKET_PATH: "/worker/socket",
    });
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
