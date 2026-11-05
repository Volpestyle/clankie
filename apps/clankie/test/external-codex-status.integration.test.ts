import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import { externalCodexQuestions } from "../src/captain/external-codex-questions.ts";
import { openCodexSocket } from "../src/captain/codex-app-server.ts";
import { DeliveryFence } from "../src/captain/delivery-fence.ts";

// Native 0.160 ThreadStatus and includeTurns semantics, inspected from its
// generated protocol and live four-seat replies. Historical text is synthetic.
it("reads restored-seat status without transferring historical tool output and preserves native waiting states", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-status-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No fixture address");
  let status: Record<string, unknown> = { type: "active", activeFlags: [] };
  let loaded = true;
  let identity = "native-thread";
  let transferred = 0;
  const history = [
    {
      id: "old-turn",
      status: "completed",
      items: [{ type: "agentMessage", text: "historical-tool-output ".repeat(500_000) }],
    },
  ];
  server.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.id === undefined) return;
      let result: unknown = {};
      if (request.method === "thread/loaded/list") result = { data: loaded ? ["native-thread"] : [] };
      if (request.method === "thread/read")
        result = {
          thread: {
            id: identity,
            status,
            turns: request.params.includeTurns === false ? [] : history,
          },
        };
      const encoded = JSON.stringify({ id: request.id, result });
      transferred += Buffer.byteLength(encoded);
      socket.send(encoded);
    }),
  );
  const control = externalCodexQuestions(
    { harness: "codex", paneId: "fixture-pane", sessionId: "native-thread" },
    () => openCodexSocket(`ws://127.0.0.1:${address.port}`),
    async () => {},
    new DeliveryFence(join(root, "fence.json")),
  );
  try {
    expect(await control.status()).toBe("working");
    expect(transferred).toBeLessThan(10_000);
    for (const flag of ["waitingOnApproval", "waitingOnUserInput"]) {
      status = { type: "active", activeFlags: [flag] };
      expect(await control.status()).toBe("blocked");
    }
    status = { type: "idle" };
    expect(await control.status()).toBe("idle");
    status = { type: "systemError" };
    expect(await control.status()).toBe("offline");
    status = { type: "active", activeFlags: ["unknownFutureFlag"] };
    await expect(control.status()).rejects.toThrow("flags");
    identity = "replacement-thread";
    await expect(control.status()).rejects.toThrow("identity");
    identity = "native-thread";
    loaded = false;
    await expect(control.status()).rejects.toThrow("not loaded");
    expect(transferred).toBeLessThan(10_000);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("refreshes the answer guard after the last reconnected native authorization read", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-question-guard-"));
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("No fixture address");
  const writes: string[] = [];
  server.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString());
      if (request.id === undefined) return;
      let result: unknown = {};
      if (request.method === "thread/loaded/list") result = { data: ["native-thread"] };
      if (request.method === "thread/read")
        result = {
          thread: {
            id: "native-thread",
            status: { type: "idle" },
            turns: [
              {
                id: "ask-turn",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "ask-item",
                    delivery: "async",
                    questions: [{ title: "Which framework?", options: ["React"] }],
                  },
                ],
              },
            ],
          },
        };
      if (request.method === "turn/start" || request.method === "turn/steer") {
        writes.push(request.method);
        result = { turn: { id: "answer-turn" } };
      }
      socket.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  let recipient = "original";
  let observed = "original";
  let authorizations = 0;
  const control = externalCodexQuestions(
    { harness: "codex", paneId: "fixture-pane", sessionId: "native-thread" },
    () => openCodexSocket(`ws://127.0.0.1:${address.port}`),
    async () => {
      // The third read is inside async answer preparation, after both
      // connection checks. Its genuine authorization result remains valid.
      if (++authorizations === 3) recipient = "replacement";
    },
    new DeliveryFence(join(root, "fence.json")),
  );
  const assertRecipient = () => {
    if (observed !== "original") throw Error("Native question recipient changed");
  };
  try {
    const result = await control.answerQuestion!(
      {
        requestId: "ask-item",
        answers: {
          [JSON.stringify(["request_user_input_async", "ask-item", 0])]: { answers: ["React"] },
        },
      },
      Object.assign(
        async () => {
          observed = recipient;
          assertRecipient();
        },
        {
          assertCurrent: assertRecipient,
        },
      ),
    );
    expect(authorizations).toBe(3);
    expect(result).toMatchObject({
      outcome: "refused",
      detail: expect.stringContaining("recipient changed"),
    });
    expect(writes).toEqual([]);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
