import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { publicGatewayTargetFor } from "@clankie/protocol/public-gateway";
import {
  WorkerAskListSchema,
  workerAskAnswerPath,
  workerAskWithdrawPath,
} from "@clankie/protocol/worker-asks";
import { afterEach, expect, it, vi } from "vitest";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { requestPairingOffer } from "../../tui/bin/pairing-offer.ts";
import { createWorkerAskService, WorkerAskStore } from "../src/captain/worker-asks.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// The app answers a worker's ask (#604) from a Take Control device: the real
// service and its device sessions, and the relay the phone reaches it through.

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ask = {
  question: "Merge the fix now?",
  options: [
    { value: "merge", label: "Merge it" },
    { value: "wait", label: "Wait" },
  ],
  confirms: "merge" as const,
};

it("a Take Control device lists and answers workers' asks through the relay, held to the ask schemas (#604)", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-asks-relay-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const deliver = vi.fn(async () => ({ outcome: "delivered" as const }));
  const asks = createWorkerAskService({
    store: new WorkerAskStore(join(root, "worker-asks.json")),
    recipientCurrent: async () => true,
    deliver,
  });
  const raised = [randomUUID(), randomUUID()].map((askId) =>
    asks.raise({
      askId,
      seatId: "term_one",
      paneId: "w1:p1",
      conversationId: "lead-a",
      ask,
      recipient: { binding: "binding-one", owner: JSON.stringify({ conversationId: "lead-a" }) },
    }),
  );
  const host = await createQaService({ captain: { workerAsks: asks } });
  host.advance(Date.now() - host.now());
  cleanups.push(() => host.close());

  // The relay as production wires it: owner routes go upstream on the device's own bearer.
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl }),
    dispatch: async () => {
      throw new Error("not reached");
    },
    roomRequest: (path, method, token, body) =>
      fetch(new URL(path, host.baseUrl), {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
      }),
  });
  const relay = createServer((request, response) => {
    void operator(request, response).then((handled) => {
      if (!handled) {
        response.statusCode = 404;
        response.end();
      }
    });
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  cleanups.push(() => new Promise<void>((done) => relay.close(() => done())));
  const relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;

  const pair = async (terminalControl: boolean) => {
    const offer = await requestPairingOffer({
      controlPlaneUrl: host.baseUrl,
      operatorToken: host.operatorToken,
    });
    const post = async (path: string, body: unknown) =>
      (await (
        await fetch(`${host.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).json()) as Record<string, unknown>;
    const pending = await post("/v1/pairing/redeem", {
      code: offer.localCode ?? offer.code,
      device: { name: "Phone", platform: "ios" },
    });
    const paired = await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: { ...(pending.offeredGrants as object), terminalControl },
    });
    return `Bearer ${String(paired.deviceToken)}`;
  };
  const phone = await pair(true);
  const observer = await pair(false);
  const call = (path: string, authorization?: string, body?: unknown) =>
    fetch(new URL(path, relayUrl), {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(authorization === undefined ? {} : { authorization }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });

  // The phone reads the open asks; the recipient proof never leaves the service.
  const listed = await call("/v1/fleet/asks?state=open", phone);
  expect(listed.status).toBe(200);
  const body: unknown = await listed.json();
  expect(WorkerAskListSchema.parse(body).asks.map((entry) => entry.askId)).toEqual(
    raised.map((entry) => entry.askId),
  );
  expect(JSON.stringify(body)).not.toContain("binding-one");

  // An answer reaches the service as exactly the schema names, and settles once.
  const answered = await call(workerAskAnswerPath(raised[0]!.askId), phone, { value: "wait" });
  expect(answered.status).toBe(200);
  expect(await answered.json()).toMatchObject({ outcome: "answered", ask: { state: "answered" } });
  expect(deliver).toHaveBeenCalledOnce();
  expect(
    await (await call(workerAskAnswerPath(raised[0]!.askId), phone, { value: "merge" })).json(),
  ).toMatchObject({ outcome: "refused", reason: "settled" });

  // Anything beyond the schema is refused at the relay and never forwarded.
  for (const extra of [
    { value: "merge", conversationId: "lead-b" },
    { value: "merge", text: "both" },
    "not json",
  ])
    expect((await call(workerAskAnswerPath(raised[1]!.askId), phone, extra)).status).toBe(400);
  expect((await call(workerAskWithdrawPath(raised[1]!.askId), phone, { reason: "x" })).status).toBe(400);
  expect(deliver).toHaveBeenCalledOnce();
  expect(await (await call(workerAskWithdrawPath(raised[1]!.askId), phone, {})).json()).toMatchObject({
    outcome: "withdrawn",
  });

  // Only an ask's lowercase UUID and one known state filter are routes at all.
  for (const query of ["?state=bogus", "?state=open&state=answered", "?state=open&x=1", "?State=open"])
    expect((await call(`/v1/fleet/asks${query}`, phone)).status).toBe(400);
  for (const path of [
    "/v1/fleet/asks/not-a-uuid/answer",
    `/v1/fleet/asks/${raised[1]!.askId.toUpperCase()}/answer`,
    `/v1/fleet/asks/${raised[1]!.askId}/answer/extra`,
    `/v1/fleet/asks/${raised[1]!.askId}/reopen`,
  ])
    expect((await call(path, phone, { value: "merge" })).status).toBe(404);

  // A device without Take Control, or with no token, reaches nothing.
  expect((await call("/v1/fleet/asks", observer)).status).toBe(403);
  expect((await call(workerAskAnswerPath(raised[1]!.askId), observer, { value: "merge" })).status).toBe(403);
  expect((await call("/v1/fleet/asks")).status).toBe(401);

  // The public gateway and the hosted operator carry exactly these routes to the relay.
  const id = raised[1]!.askId;
  for (const [method, path, target] of [
    ["GET", "/v1/fleet/asks", "relay"],
    ["GET", "/v1/fleet/asks?state=answering", "relay"],
    ["POST", workerAskAnswerPath(id), "relay"],
    ["POST", workerAskWithdrawPath(id), "relay"],
    ["GET", "/v1/fleet/asks?state=bogus", undefined],
    ["GET", workerAskAnswerPath(id), undefined],
    ["POST", "/v1/fleet/asks", undefined],
    ["POST", `/v1/fleet/asks/${id.toUpperCase()}/answer`, undefined],
    ["POST", "/v1/fleet/asks/../asks/answer", undefined],
  ] as const) {
    expect(publicGatewayTargetFor(method, path)).toBe(target);
    expect(hostedOperatorAllows(method, path)).toBe(target !== undefined);
  }
}, 30_000);
