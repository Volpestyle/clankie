import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import { TAKE_CONTROL_GRANTS, type TrackerSyncCommand } from "@clankie/protocol";
import { createLocalTracker, type LocalTrackerOptions } from "@clankie/work-items";
import { createClankieApp } from "../../src/app.ts";
import { createStubCaptain } from "../../src/captain/port.ts";
import { HostedBodyClient } from "../../src/hosted-body.ts";
import { HostedPairing } from "../../src/hosted-pairing.ts";
import { hostedFixture } from "../fixtures/hosted-body.ts";
import { ControlPlaneDeviceAuthorizer } from "../../../relay/src/device-auth.ts";
import { createDeviceConversationDispatch } from "../../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../../relay/src/operator-conversations.ts";

/**
 * Real journal, pairing, signed sessions, HTTP host and relay; the conversation port is unused.
 * `hosted` adds a signed hosted-account pairing door for `pairHosted`.
 */
export async function syncFixture(
  trackerOptions: Omit<LocalTrackerOptions, "directory"> = {},
  { hosted: withHosted = false }: { readonly hosted?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "tracker-sync-"));
  const tracker = createLocalTracker({ directory: root, ...trackerOptions });
  const hosted = hostedFixture(Math.floor(Date.now() / 1000) * 1000);
  let hostedLink = "";
  const host = await createClankieApp({
    ...(withHosted
      ? {
          hostedPairing: new HostedPairing(
            new HostedBodyClient(hosted.bootstrap),
            generateKeyPairSync("ed25519").privateKey,
          ),
          pairingOfferPublisher: {
            publishPairingOffer: async () => {},
            protectPairingOffer: (offer) => {
              hostedLink = `clankie://connect?v=1&offer=${offer.offerSecret}`;
              return { version: 1, deepLink: hostedLink, code: offer.code, expiresAt: offer.expiresAt };
            },
          },
        }
      : {}),
    captain: createStubCaptain(),
    builtInTracker: tracker,
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  const active = new Set<Promise<unknown>>();
  const track = <T>(promise: Promise<T>) => {
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  };
  const server = serve({
    fetch: (request) => track(Promise.resolve(host.app.fetch(request))),
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  if (!server.listening) await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const handler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: origin }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl: origin }),
    dispatch: async () => {
      throw new Error("Sync must never substitute captain authority");
    },
  });
  const relay = createServer((request, response) => {
    void track(handler(request, response));
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  const relayOrigin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
  const post = (base: string, path: string, body: unknown, token: string, signal?: AbortSignal) =>
    fetch(base + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  /** `offer` carries pairing offer options, such as an automation `run`. */
  const pair = async (
    name: string,
    grants = TAKE_CONTROL_GRANTS,
    offerOptions: Record<string, unknown> = {},
  ) => {
    const offer = await (await post(origin, "/v1/pairing/offer", offerOptions, "owner")).json();
    const pending = await (
      await post(
        origin,
        "/v1/pairing/redeem",
        {
          offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
          device: { name, platform: "macos" },
        },
        "owner",
      )
    ).json();
    return (
      await post(
        origin,
        "/v1/pairing/complete",
        {
          completionToken: pending.completionToken,
          acceptedGrants: grants,
        },
        "owner",
      )
    ).json() as Promise<{ deviceId: string; deviceToken: string }>;
  };
  const sync = async (token: string, command: TrackerSyncCommand) => {
    const response = await post(
      relayOrigin,
      "/operator/v1/dispatch",
      { op: "tracker_sync", schemaVersion: 1, command },
      token,
    );
    if (command.action === "bootstrap" && response.ok)
      return { outcome: "bootstrap", ndjson: await response.text() };
    const body = await response.json();
    return { status: response.status, ...body.result, error: body.error };
  };
  const stream = async (token: string, command: TrackerSyncCommand) => {
    const abort = new AbortController();
    const response = await post(
      relayOrigin,
      "/operator/v1/tail",
      { op: "tracker_sync", schemaVersion: 1, command },
      token,
      abort.signal,
    );
    const reader = response.body!.getReader();
    let buffer = "";
    const next = async () => {
      while (!buffer.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("Stream ended before next commit");
        buffer += new TextDecoder().decode(chunk.value);
      }
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      return JSON.parse(line).result;
    };
    return {
      next,
      close: () => {
        abort.abort();
        void reader.cancel().catch(() => {});
      },
    };
  };
  const close = async () => {
    for (const instance of [relay, server]) {
      instance.closeAllConnections();
      await new Promise<void>((resolve) => instance.close(() => resolve()));
    }
    await Promise.allSettled(active);
    host.close();
    await rm(root, { recursive: true, force: true });
  };
  const revoke = (deviceId: string) => post(origin, `/v1/devices/${deviceId}/revoke`, {}, "owner");
  /** A direct host request, for routes other than the relay's sync dispatch. */
  const request = (path: string, body: unknown, token: string) => post(origin, path, body, token);
  /** A device the owner pairs from their hosted account (`hosted-account-operator`). */
  const pairHosted = async (): Promise<{ deviceId: string; deviceToken: string }> => {
    const offer = await post(
      origin,
      "/v1/hosted/pair-offer",
      {
        version: 2,
        pairTicket: hosted.pair({ purpose: "operator" }),
        browserPublicKey: hosted.browserPublicKey,
        nonce: hosted.nonce,
      },
      "owner",
    );
    if (!offer.ok) throw new Error(`Hosted pairing failed: ${await offer.text()}`);
    const redeem = {
      offerSecret: new URL(hostedLink).searchParams.get("offer"),
      device: { name: "Hosted", platform: "macos" },
    };
    const pending = (await (await post(origin, "/v1/pairing/redeem", redeem, "owner")).json()) as {
      completionToken: string;
    };
    const complete = { completionToken: pending.completionToken, acceptedGrants: TAKE_CONTROL_GRANTS };
    return (await (await post(origin, "/v1/pairing/complete", complete, "owner")).json()) as {
      deviceId: string;
      deviceToken: string;
    };
  };
  return { root, tracker, pair, pairHosted, sync, stream, revoke, close, request };
}
