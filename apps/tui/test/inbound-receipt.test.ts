import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createInboundSender } from "../../../integrations/claude-plugin/worker/bin/inbound-receipt.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
function root() {
  const dir = mkdtempSync(join(tmpdir(), "inbound-client-"));
  roots.push(dir);
  return dir;
}
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
it.each(["corrupt", "locked"])("%s original state fails closed before any network request", async (mode) => {
  const directory = root();
  const file = join(directory, `${createHash("sha256").update("pane").digest("hex")}.json`);
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
  if (mode === "locked") writeFileSync(`${file}.lock`, "exclusive");
  let posts = 0;
  const send = createInboundSender({
    directory,
    scope: "pane",
    request: async (_suffix, init) => {
      if (init) posts++;
      return response({});
    },
  });
  expect((await send("text")).deliveryStage).toBe("uncertain");
  expect(posts).toBe(0);
});
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
