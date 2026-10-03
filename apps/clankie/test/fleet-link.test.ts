import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, spawn } from "node:child_process";
import { fleetSeatEventsPath, fleetSeatHookPath, fleetSeatMessagesPath } from "@clankie/protocol";
import { describe, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { FleetLinks, fleetLinkFetch, linkSshArgs, writeLinkFileCommand } from "../src/fleet-link.ts";
import type { HerdrFleet } from "../src/herdr-fleet.ts";

const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "volpe@pc", shell: "powershell" } };
const box: HerdrFleet = { id: "box", session: "default", ssh: { host: "me@box", shell: "posix" } };

function decoded(command: string): string {
  const encoded = /-EncodedCommand (\S+)$/u.exec(command)?.[1];
  if (encoded === undefined) throw new Error(`not an encoded command: ${command}`);
  return Buffer.from(encoded, "base64").toString("utf16le");
}

async function app(links: { authenticate(token: string): string | undefined }) {
  const seen: { route: string; paneId: string; text?: string }[] = [];
  const clankie = await createClankieApp({
    captain: createStubCaptain({
      pollFleetSeatEvents: async (paneId) => {
        seen.push({ route: "events", paneId });
        return [];
      },
      recordSeatHook: async (paneId) => {
        seen.push({ route: "hook", paneId });
        return true;
      },
      receiveFleetSeatMessage: async (paneId, text) => {
        seen.push({ route: "messages", paneId, text });
        return true;
      },
    }),
    fleetLinks: links,
    authenticateOperator: (request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer operator"
          ? { operatorId: "local-operator", steerSourceLane: "tui" as const }
          : undefined,
      ),
  });
  return { clankie, seen };
}

describe("a fleet link (VUH-1527)", () => {
  const links = { authenticate: (token: string) => (token === "pc-link-token" ? "pc" : undefined) };

  it("lets a link token reach only its own fleet's panes, by the bare id its bridge sees", async () => {
    const { clankie, seen } = await app(links);
    const auth = { authorization: "Bearer pc-link-token" };
    expect((await clankie.app.request(fleetSeatEventsPath("w8:p3"), { headers: auth })).status).toBe(200);
    expect(
      (
        await clankie.app.request(fleetSeatMessagesPath("w8:p3"), {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, text: "Blocked on X" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await clankie.app.request(fleetSeatHookPath("w8:p3"), {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, event: "Stop", sessionId: "s1" }),
        })
      ).status,
    ).toBe(200);
    expect(seen).toEqual([
      { route: "events", paneId: "pc/w8:p3" },
      { route: "messages", paneId: "pc/w8:p3", text: "Blocked on X" },
      { route: "hook", paneId: "pc/w8:p3" },
    ]);
    // It cannot name a pane on another fleet, or a local one.
    expect((await clankie.app.request(fleetSeatEventsPath("box/w1:p1"), { headers: auth })).status).toBe(403);
    expect(seen).toHaveLength(3);
  });

  it("gives a link token nothing outside the seat routes, and an unknown token nothing at all", async () => {
    const { clankie, seen } = await app(links);
    expect(
      (await clankie.app.request("/v1/mcp", { headers: { authorization: "Bearer pc-link-token" } })).status,
    ).toBe(401);
    expect(
      (await clankie.app.request(fleetSeatEventsPath("w8:p3"), { headers: { authorization: "Bearer nope" } }))
        .status,
    ).toBe(401);
    expect(seen).toEqual([]);
  });

  it("keeps the operator lane's own access to any pane", async () => {
    const { clankie, seen } = await app(links);
    const response = await clankie.app.request(fleetSeatMessagesPath("w1:p1"), {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, text: "hi" }),
    });
    expect(response.status).toBe(200);
    expect(seen).toEqual([{ route: "messages", paneId: "w1:p1", text: "hi" }]);
  });

  it("answers only the seat routes on the link listener", async () => {
    const inner = vi.fn(async () => new Response("ok"));
    const fetch = fleetLinkFetch(inner);
    expect((await fetch(new Request("http://127.0.0.1/v1/fleet/seats/w8%3Ap3/events"))).status).toBe(200);
    expect((await fetch(new Request("http://127.0.0.1/v1/fleet/seats/w8%3Ap3/messages"))).status).toBe(200);
    for (const path of ["/health", "/v1/mcp", "/v1/pairing/offers", "/v1/fleet/seats/w8%3Ap3/events/x"])
      expect((await fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(404);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("forwards only the remote loopback to the link listener", () => {
    expect(linkSshArgs(pc, 4567)).toEqual(
      expect.arrayContaining(["-N", "-R", "127.0.0.1:0:127.0.0.1:4567", "volpe@pc"]),
    );
  });

  it("writes the link file owner-only, without a byte-order mark", () => {
    const file = {
      schemaVersion: 1 as const,
      fleet: "pc",
      url: "http://127.0.0.1:50123",
      token: "x".repeat(43),
    };
    const windows = decoded(writeLinkFileCommand(pc, file));
    expect(windows).toContain("New-Object Text.UTF8Encoding $false");
    expect(windows).toContain("icacls.exe $temp /inheritance:r");
    expect(windows).toContain(JSON.stringify(file));
    const posix = writeLinkFileCommand(box, file);
    expect(posix).toMatch(/^exec sh -c '/u);
    expect(posix).toContain("umask 077");
  });

  it("writes the link once ssh allocates the remote port, and authenticates only that link's token", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stderr = new PassThrough();
    Object.assign(child, { stderr, kill: vi.fn(() => true) });
    const shell = vi.fn(async (_command: string) => "");
    const links = new FleetLinks({
      shell: () => shell,
      spawn: vi.fn(() => child) as unknown as typeof spawn,
    });
    links.start([pc], 4567);
    expect(links.status("pc")).toMatchObject({ state: "starting" });
    stderr.write("Allocated port 50123 for remote forward to 127.0.0.1:4567\n");
    await vi.waitFor(() => expect(links.status("pc")).toMatchObject({ state: "ready", port: 50123 }));
    const written = JSON.parse(/\{"schemaVersion".*?\}/u.exec(decoded(shell.mock.calls[0]![0]))![0]) as {
      url: string;
      token: string;
    };
    expect(written.url).toBe("http://127.0.0.1:50123");
    expect(links.authenticate(written.token)).toBe("pc");
    expect(links.authenticate(`${written.token}x`)).toBeUndefined();
    links.close();
    expect(child.kill).toHaveBeenCalled();
  });
});
