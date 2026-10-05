import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createInboundSender } from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "inbound-client-"));
  roots.push(dir);
  return dir;
}
it.each(["aborted", "malformed"] as const)(
  "reports an %s binding HTTP read as unavailable before any claim or POST, then permits one deliberate fresh send",
  async (mode) => {
    const directory = root();
    const secret = "fixture-private-credential";
    let healthy = false;
    let bindingObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      bindingObserved = resolve;
    });
    const methods: string[] = [];
    const server = createServer(async (request, reply) => {
      methods.push(request.method!);
      reply.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        bindingObserved();
        if (!healthy) {
          if (mode === "malformed") reply.end(`invalid JSON ${secret}`);
          return;
        }
        reply.end(JSON.stringify({ binding: "a".repeat(64) }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      reply.end(
        JSON.stringify({
          schemaVersion: 1,
          received: true,
          deliveryStage: "stored",
          deliveryId: input.delivery.id,
          binding: input.delivery.binding,
          fingerprint: createHash("sha256").update(input.text).digest("hex"),
        }),
      );
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing binding fixture address");
    let controller = new AbortController();
    const send = createInboundSender({
      directory,
      scope: "pane",
      request: (suffix, init) =>
        fetch(`http://127.0.0.1:${address.port}/messages${suffix}`, { ...init, signal: controller.signal }),
    });
    const pending = send("first intent");
    await observed;
    if (mode === "aborted") controller.abort(new DOMException(secret, "AbortError"));
    const unavailable = await pending;
    expect(unavailable).toEqual({
      received: false,
      deliveryStage: "unavailable",
      detail:
        mode === "aborted"
          ? "Binding discovery timed out or was interrupted; nothing was sent."
          : "Binding discovery returned an invalid response; nothing was sent.",
    });
    expect(JSON.stringify(unavailable)).not.toContain(secret);
    expect(readdirSync(directory)).toEqual([]);
    expect(methods).toEqual(["GET"]);
    healthy = true;
    controller = new AbortController();
    expect(await send("deliberate fresh intent")).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(methods).toEqual(["GET", "GET", "POST"]);
    expect(readdirSync(directory)).toEqual([]);
  },
);
it("an old responder cannot settle a newer original claim", async () => {
  const directory = root();
  let posts = 0;
  let finishOld!: (response: Response) => void;
  let original: { deliveryId: string; binding: string; fingerprint: string };
  const send = createInboundSender({
    directory,
    scope: "pane",
    request: async (suffix, init) => {
      if (!init && suffix === "") return response({ binding: "a".repeat(64) });
      if (init) {
        posts++;
        const input = JSON.parse(init.body);
        const receipt = {
          schemaVersion: 1,
          received: true,
          deliveryStage: "stored",
          deliveryId: input.delivery.id,
          binding: input.delivery.binding,
          fingerprint: createHash("sha256").update(input.text).digest("hex"),
        };
        if (posts === 1) {
          original = receipt;
          return new Promise<Response>((resolve) => {
            finishOld = resolve;
          });
        }
        throw new Error("second outcome lost");
      }
      return response({ schemaVersion: 1, received: true, deliveryStage: "stored", ...original });
    },
  });
  const first = send("original");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect((await send("original")).deliveryStage).toBe("stored");
  const newer = await send("newer");
  expect(newer.deliveryStage).toBe("uncertain");
  finishOld(response({ schemaVersion: 1, received: true, deliveryStage: "stored", ...original! }));
  expect((await first).deliveryStage).toBe("stored");
  const claim = JSON.parse(
    readFileSync(join(directory, readdirSync(directory).find((f) => f.endsWith(".json"))!), "utf8"),
  );
  expect(claim.deliveryId).toBe(newer.deliveryId);
});
it.each(["corrupt", "locked", "orphaned lock"])(
  "%s original state fails closed before any POST",
  async (mode) => {
    const directory = root();
    const file = join(directory, `${createHash("sha256").update("pane").digest("hex")}.json`);
    if (mode !== "orphaned lock")
      writeFileSync(
        file,
        mode === "corrupt"
          ? "bad"
          : JSON.stringify({
              schemaVersion: 1,
              deliveryId: "00000000-0000-4000-8000-000000000001",
              binding: "a".repeat(64),
              fingerprint: createHash("sha256").update("text").digest("hex"),
              text: "text",
            }),
      );
    if (mode !== "corrupt") writeFileSync(`${file}.lock`, "exclusive");
    let requests = 0;
    let posts = 0;
    const send = createInboundSender({
      directory,
      scope: "pane",
      request: async (_suffix, init) => {
        requests++;
        if (init) posts++;
        return response({});
      },
    });
    expect((await send("text")).deliveryStage).toBe("uncertain");
    expect(posts).toBe(0);
    if (mode === "orphaned lock") {
      expect(requests).toBe(0);
      expect(readFileSync(`${file}.lock`, "utf8")).toBe("exclusive");
    }
  },
);
it.each(["rejected", "unavailable"] as const)(
  "keeps an exact known %s before-dispatch refusal honest",
  async (deliveryStage) => {
    const directory = root();
    let posts = 0;
    const send = createInboundSender({
      directory,
      scope: "pane",
      request: async (_suffix, init) => {
        if (!init) return response({ binding: "a".repeat(64) });
        posts++;
        const input = JSON.parse(init.body);
        return response({
          schemaVersion: 1,
          received: false,
          deliveryStage,
          deliveryId: input.delivery.id,
          binding: input.delivery.binding,
          fingerprint: createHash("sha256").update(input.text).digest("hex"),
        });
      },
    });
    expect((await send("hello")).deliveryStage).toBe(deliveryStage);
    expect((await send("next")).deliveryStage).toBe(deliveryStage);
    expect(posts).toBe(2);
  },
);
it("reports binding authorization refusal as rejected without a POST", async () => {
  let posts = 0;
  const send = createInboundSender({
    directory: root(),
    scope: "pane",
    request: async (_suffix, init) => {
      if (init) posts++;
      return new Response("{}", { status: 403 });
    },
  });
  expect((await send("hello")).deliveryStage).toBe("rejected");
  expect(posts).toBe(0);
});
