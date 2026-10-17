// Standalone bundled fixture: no captain, models, provider catalog or installed link discovery.
import { createHmac, createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, closeSync, openSync, lstatSync, realpathSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { createLocalTracker } from "@clankie/work-items";
import { z } from "zod";
import {
  FixtureDescriptorSchema,
  FixtureReadSchema,
  fixtureDigest,
  fixtureOrigin,
  FIXTURE_VERIFY_PATH,
  readFixtureJson,
} from "./fixture-admission-contract.ts";
import { observeSocketProcess } from "./local-fleet-process.ts";
import { saveFixtureState } from "./fixture-admission-bootstrap.ts";

if (process.env.NODE_ENV !== undefined) throw new Error("Fixture NODE_ENV overrides refused");
let bootstrapBody = "";
for await (const chunk of process.stdin) {
  bootstrapBody += chunk.toString();
  if (bootstrapBody.length > 8192) throw new Error("Invalid fixture bootstrap");
}
const config = z
  .object({
    fixtureId: z.string().uuid(),
    root: z.string().min(1),
    capability: z.string().min(40),
    callbackOrigin: fixtureOrigin,
    processHelper: z.string().min(1),
    expiresAt: z.number().positive(),
  })
  .strict()
  .parse(JSON.parse(bootstrapBody));
const root = realpathSync(config.root),
  ownPath = fileURLToPath(import.meta.url);
if (root !== config.root || ownPath !== join(root, "worker.mjs")) throw new Error("Unpinned fixture root");
const rootIdentity = lstatSync(root, { bigint: true });
const ownBytes = readFileSync(ownPath);
const helperBytes = readFileSync(config.processHelper);
const sourceDigest = createHash("sha256").update(ownBytes).digest("hex");
const assertCurrent = () => {
  const current = lstatSync(root, { bigint: true });
  if (
    Date.now() >= config.expiresAt ||
    realpathSync(root) !== root ||
    !current.isDirectory() ||
    current.ino !== rootIdentity.ino ||
    current.dev !== rootIdentity.dev ||
    current.birthtimeNs !== rootIdentity.birthtimeNs ||
    !readFileSync(ownPath).equals(ownBytes) ||
    !readFileSync(config.processHelper).equals(helperBytes)
  )
    throw new Error("Fixture expired or changed");
};
// Setup before issuance: finite private data. Admitted requests cannot use ordinary call.
await mkdir(join(root, "home"), { mode: 0o700 });
await writeFile(
  join(root, "settings.json"),
  JSON.stringify({ auto: false, model: null, providers: [], catalog: false }),
  { flag: "wx", mode: 0o600 },
);
const tracker = createLocalTracker({ directory: join(root, "builtin") });
await tracker.call("get_user", { query: "me" });
const snapshot = await tracker.strictGetUser(async () => assertCurrent);
type ResultRecord = {
  input: z.infer<typeof FixtureReadSchema>;
  binding: string;
  subjectObservation: unknown;
  state: "uncertain" | "settled";
  result?: unknown;
};
let record: ResultRecord | undefined;
const persist = () => {
  if (!record) throw new Error("Authenticated fixture claim required before receipt persistence");
  saveFixtureState(join(root, "fixture-receipts.json"), record);
};
const callback = async (
  action: "claim" | "consume" | "status",
  input: z.infer<typeof FixtureReadSchema>,
  observation: unknown,
) => {
  assertCurrent();
  const fd = openSync(join(root, "fixture.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let pinned;
  try {
    pinned = FixtureDescriptorSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
  } finally {
    closeSync(fd);
  }
  if (
    pinned.process.pid !== process.pid ||
    pinned.root !== root ||
    pinned.sourceDigest !== sourceDigest ||
    pinned.fixtureId !== config.fixtureId ||
    pinned.origin !== descriptor.origin ||
    pinned.relayOrigin !== descriptor.relayOrigin ||
    pinned.expiresAt !== config.expiresAt ||
    pinned.storeId !== snapshot.storeId ||
    pinned.storeDigest !== snapshot.storeDigest
  )
    throw new Error("Fixture descriptor changed");
  const callbackNonce = randomUUID();
  const response = await fetch(`${config.callbackOrigin}${FIXTURE_VERIFY_PATH}`, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, config.expiresAt - Date.now()))),
    headers: { "content-type": "application/json", "x-clankie-fixture-capability": config.capability },
    body: JSON.stringify({ action, ...input, fixtureId: config.fixtureId, callbackNonce, observation }),
  });
  if (!response.ok) throw new Error("Fixture verification refused");
  const { verdict, mac } = (await response.json()) as { verdict: Record<string, unknown>; mac: string };
  const expected = createHmac("sha256", config.capability).update(JSON.stringify(verdict)).digest("hex");
  if (
    typeof mac !== "string" ||
    mac.length !== expected.length ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(expected)) ||
    verdict.callbackNonce !== callbackNonce ||
    verdict.ticketId !== input.ticketId ||
    verdict.bindingHash !== input.bindingHash ||
    verdict.claimId !== input.claimId ||
    verdict.requestId !== input.requestId ||
    verdict.receiptId !== input.receiptId ||
    fixtureDigest(verdict.fixture) !== fixtureDigest(pinned)
  )
    throw new Error("Unbound fixture verdict");
  assertCurrent();
  return verdict;
};
const relay = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => Response.json({ error: "not_found" }, { status: 404 }),
});
if (!relay.listening) await once(relay, "listening");
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request, env) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/v1/fixture/reads", "/v1/fixture/reads/status"].includes(path))
      return Response.json({ error: "not_found" }, { status: 404 });
    try {
      assertCurrent();
      const input = FixtureReadSchema.parse(await readFixtureJson(request, 4096));
      const observation = await observeSocketProcess(env.incoming.socket, config.processHelper);
      if (!observation) throw new Error("Fixture caller observation unavailable");
      const binding = fixtureDigest(input),
        previous = record;
      if (previous && previous.binding !== binding) throw new Error("Fixture receipt binding mismatch");
      if (path.endsWith("/status")) {
        await callback("status", input, observation);
        return Response.json({ receiptId: input.receiptId, ...(previous ?? { state: "uncertain" }) });
      }
      // Any repeated request is status-only, never another read, even after lost results.
      if (previous) return Response.json({ error: "receipt_retained_use_status" }, { status: 409 });
      // The host re-proves the exact original controller before ANY receipt mutation.
      // A denied/lost claim cannot squat a local receipt; host retains claim uncertainty.
      const claimed = await callback("claim", input, observation);
      if (claimed.state !== "claimed" || claimed.mayExecute !== false)
        throw new Error("No authenticated fixture claim");
      assertCurrent();
      if (record) throw new Error("Fixture receipt slot already occupied");
      record = { input, binding, subjectObservation: observation, state: "uncertain" };
      persist();
      const result = await tracker.strictGetUser(async (held) => {
        if (held.storeId !== snapshot.storeId || held.storeDigest !== snapshot.storeDigest)
          throw new Error("Fixture store changed");
        assertCurrent();
        const fresh = await observeSocketProcess(
          env.incoming.socket,
          config.processHelper,
          observation.owner,
        );
        if (!fresh || fixtureDigest(fresh) !== fixtureDigest(observation))
          throw new Error("Fixture caller lifetime or ancestry changed");
        const verdict = await callback("consume", input, fresh);
        if (verdict.mayExecute !== true) throw new Error("No single-use consume verdict");
        persist(); // durable preparation occurs before returning the effect-free final guard
        assertCurrent();
        return () => {
          assertCurrent();
          if (env.incoming.socket.destroyed || record?.binding !== binding)
            throw new Error("Fixture request changed");
        };
      });
      record = { input, binding, subjectObservation: observation, state: "settled", result };
      persist();
      return Response.json({ receiptId: input.receiptId, state: "settled", result });
    } catch {
      return Response.json({ error: "fixture_read_refused" }, { status: 403 });
    }
  },
});
if (!server.listening) await once(server, "listening");
const origin = (listener: typeof server) => {
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Fixture address unavailable");
  return fixtureOrigin.parse(`http://127.0.0.1:${address.port}`);
};
const descriptor = {
  version: 1,
  fixtureId: config.fixtureId,
  root,
  origin: origin(server),
  relayOrigin: origin(relay),
  sourceDigest,
  storeId: snapshot.storeId,
  storeDigest: snapshot.storeDigest,
  // Host supplies the authoritative process birth in its descriptor; callback compares shared resource fields below.
};
// The host independently observes PID/birth; handshake never supplies an authority PID.
process.stdout.write(
  `${JSON.stringify({
    origin: descriptor.origin,
    relayOrigin: descriptor.relayOrigin,
    storeId: snapshot.storeId,
    storeDigest: snapshot.storeDigest,
  })}\n`,
);
const close = () => {
  server.close();
  relay.close();
};
process.once("SIGTERM", close);
setTimeout(close, Math.max(1, config.expiresAt - Date.now())).unref();
