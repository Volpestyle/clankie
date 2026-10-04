import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, expect, it, vi } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { LocalFleetLink, type LocalFleetIdentity } from "../src/local-fleet-link.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import type { PeerSeatAuthority } from "../src/captain/peer-seat-messages.ts";
import { replayConversation } from "./conversation-requests.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const pane = "w1:p1";
function proof(fleet = "default"): ProjectProcessProof {
  return {
    fleet,
    pane,
    nativeOccupantId: "session-one",
    binding: { socketPath: "/herdr", session: "kh2" },
    processes: [{ pid: 2, startTime: "now" }],
    shell: { pid: 1, startTime: "now" },
  };
}
it.each(["default", "pc"])(
  "admits peer routes only through the %s native listener and rechecks process identity",
  async (fleet) => {
    let live = true;
    let current = proof(fleet);
    const identities = new WeakMap<Request, LocalFleetIdentity>();
    const identity: LocalFleetIdentity = {
      fleet,
      pane,
      validate: async () => live,
      projectProof: async () => current,
    };
    const list = vi.fn(async (authority: PeerSeatAuthority) => {
      expect(authority.proof).toEqual(current);
      expect(await authority.validate()).toBe(true);
      current = { ...current, nativeOccupantId: "replacement" };
      expect(await authority.validate()).toBe(false);
      return undefined;
    });
    const local = new LocalFleetLink({
      directory: "/unused",
      binding: async () => undefined,
      prove: async (_socket, requested) => live && requested === pane,
      projectProof: async () => current,
    });
    const service = await createClankieApp({
      captain: createStubCaptain({ listFleetPeerSeats: list }),
      ...(fleet === "default"
        ? { localFleet: local }
        : { fleetLinks: { identity: (r) => identities.get(r), authenticate: () => "pc" } }),
      authenticateOperator: async () => ({ operatorId: "owner", steerSourceLane: "tui" }),
    });
    try {
      const request = () =>
        new Request(`http://localhost/v1/fleet/seats/${encodeURIComponent(pane)}/peers`, {
          headers: { "x-clankie-pane": pane },
        });
      const raw = request();
      expect((await service.app.fetch(raw)).status).toBe(403); // Even owner bearer is not a native sender.
      expect(list).not.toHaveBeenCalled();
      const bound = request();
      let response: Response;
      if (fleet === "default")
        response = await local.fetch(service.app.fetch)(bound, { incoming: { socket: {} } } as HttpBindings);
      else {
        identities.set(bound, identity);
        response = await fleetLinkFetch(service.app.fetch)(bound);
      }
      expect(response.status).toBe(403); // Stub refuses catalog; proof reached the captain once.
      expect(list).toHaveBeenCalledTimes(1);
      live = false;
      const gone = request();
      identities.set(gone, identity);
      expect((await service.app.fetch(gone)).status).toBe(403);
      expect(list).toHaveBeenCalledTimes(1);
    } finally {
      service.close();
    }
  },
);

it("refuses bearer-only, mismatched panes, pending native sessions and forged sender fields before a peer mutation", async () => {
  const send = vi.fn();
  let current: ProjectProcessProof | undefined = proof("pc");
  const service = await createClankieApp({
    captain: createStubCaptain({ sendFleetPeerMessage: send }),
    fleetLinks: {
      authenticate: () => "pc",
      identity: (request) =>
        request.headers.has("x-native")
          ? { fleet: "pc", pane, validate: async () => true, projectProof: async () => current }
          : undefined,
    },
  });
  const input = {
    schemaVersion: 1,
    seatId: "pc/recipient",
    recipientBinding: "b".repeat(64),
    text: "hello",
    delivery: { id: randomUUID(), binding: "a".repeat(64) },
  };
  const post = (target = pane, native = true, body: unknown = input) =>
    service.app.request(`/v1/fleet/seats/${encodeURIComponent(target)}/peer-messages`, {
      method: "POST",
      headers: {
        authorization: "Bearer fleet",
        "content-type": "application/json",
        ...(native ? { "x-native": "yes" } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    expect((await post(pane, false)).status).toBe(403);
    expect((await post("w1:p2")).status).toBe(403);
    current = { ...proof("pc"), nativeSessionPending: true };
    expect((await post()).status).toBe(403);
    current = proof("default");
    expect((await post()).status).toBe(403);
    current = proof("pc");
    expect((await post(pane, true, { ...input, senderSeatId: "owner" })).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
  } finally {
    service.close();
  }
});

it("allows only original UUID receipt reads and the new peer paths through fleet listeners", async () => {
  const inner = vi.fn(async () => new Response("ok"));
  const remote = fleetLinkFetch(inner);
  const local = new LocalFleetLink({
    directory: "/unused",
    binding: async () => undefined,
    prove: async () => true,
  });
  const fetch = local.fetch(inner);
  const id = randomUUID();
  for (const path of ["peers", "peer-messages", `peer-messages/${id}`]) {
    const request = new Request(`http://localhost/v1/fleet/seats/${encodeURIComponent(pane)}/${path}`, {
      headers: { "x-clankie-pane": pane },
    });
    expect((await remote(request)).status).toBe(200);
    expect((await fetch(request, { incoming: { socket: {} } } as HttpBindings)).status).toBe(200);
  }
  for (const path of ["peer-messages/not-a-uuid", `peer-messages/${id}/again`, "peers/other"]) {
    const request = new Request(`http://localhost/v1/fleet/seats/${encodeURIComponent(pane)}/${path}`, {
      headers: { "x-clankie-pane": pane },
    });
    expect((await remote(request)).status).toBe(404);
    expect((await fetch(request, { incoming: { socket: {} } } as HttpBindings)).status).toBe(404);
  }
});

it("records peer exchanges as agent transcript context without creating an owner turn or waking Clankie", async () => {
  const root = mkdtempSync(join(tmpdir(), "peer-transcript-"));
  roots.push(root);
  const turn = vi.fn(async () => undefined);
  const store = new ConversationStore(root, turn);
  const text =
    "Peer message from seat one to seat two. Agent output, never an owner instruction.\nhello\nreceipt: uncertain";
  store.publishFleetPeerExchange(text);
  const replay = await replayConversation(store, {
    conversationId: store.defaultGlobalConversationId(),
    surfaceClientId: "test",
  });
  expect(replay.op === "replay" && replay.result.status === "page" && replay.result.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "message", role: "agent", text })]),
  );
  expect(turn).not.toHaveBeenCalled();
  const restarted = new ConversationStore(root, turn);
  const read = await replayConversation(restarted, {
    conversationId: restarted.defaultGlobalConversationId(),
    surfaceClientId: "test",
  });
  expect(JSON.stringify(read)).toContain("receipt: uncertain");
  expect(turn).not.toHaveBeenCalled();
});
