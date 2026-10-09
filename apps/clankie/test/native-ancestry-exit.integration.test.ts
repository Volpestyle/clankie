// Manual acceptance only: live claimant, real reparenting, non-member refusal.
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import {
  NativeProcessDiagnosticSchema,
  fleetProcessHelper,
  observeSocketProcess,
  observeNativeBirth,
} from "../src/local-fleet-process.ts";
import { localFleetProof, type LocalFleetProofDiagnostic } from "../src/local-fleet-proof.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { closeNativeProcessObservers } from "../src/native-process-transport.ts";
import { FleetHealthMetrics } from "../src/fleet-health-metrics.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const native = process.platform === "darwin" && process.env.FLEET_PROOF_NATIVE_TEST === "1";
const check = it.skipIf(!native);
const exec = promisify(execFile);
const directory = resolve(".local/vuh-1945/ancestry-exit");
const fixture = resolve(directory, "scheduled-exit");
const prefix = "Native process proof diagnostic: ";
type Facts = NonNullable<Awaited<ReturnType<typeof observeSocketProcess>>>;

beforeAll(async () => {
  if (!native) return;
  await mkdir(directory, { recursive: true });
  await writeFile(`${fixture}.target`, "");
  await exec("cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=14.0",
    "-lproc",
    "apps/clankie/test/helpers/native-proof-churn/ancestry-exit.c",
    "-o",
    fixture,
  ]);
});

async function scheduled(mode: string) {
  const started = performance.now();
  const result = await exec(fixture, [mode], { timeout: 3_000 }).then(
    (reply) => ({ ...reply, code: 0 }),
    (error: Error & { code: number; stdout: string; stderr: string }) => ({
      stdout: error.stdout,
      stderr: error.stderr,
      code: error.code,
    }),
  );
  const elapsedMs = performance.now() - started;
  const events = result.stderr
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(prefix.length))));
  const kernel = result.stderr
    .split("\n")
    .filter((line) => line.startsWith("Kernel ancestry read: "))
    .map(
      (line) =>
        JSON.parse(line.slice("Kernel ancestry read: ".length)) as {
          result: number;
          errno: number;
          bytes: number;
        },
    );
  const metrics = new FleetHealthMetrics();
  for (const event of events)
    metrics.observeProof("fleet", { source: "native", checkpoint: "initial", event });
  const counters = metrics.snapshot().totals;
  await writeFile(
    resolve(directory, `${mode}.public.json`),
    JSON.stringify(
      {
        code: result.code,
        elapsedMs,
        kernel,
        events: events.map(({ ancestryFailure, ...event }) => ({
          ...event,
          ...(ancestryFailure
            ? {
                ancestryFailure: {
                  phase: ancestryFailure.phase,
                  chainIndex: ancestryFailure.chainIndex,
                  claimantStatus: ancestryFailure.claimantStatus,
                },
              }
            : {}),
        })),
        counters,
      },
      null,
      2,
    ),
  );
  const facts = result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Facts);
  const scheduling = JSON.parse(
    result.stderr
      .split("\n")
      .find((line) => line.startsWith("Owned ancestry scheduling: "))!
      .slice(27),
  );
  await writeFile(
    resolve(directory, `${mode}.private.json`),
    JSON.stringify({ result, events, facts, scheduling, elapsedMs }, null, 2),
  );
  expect(elapsedMs).toBeLessThan(1_000);
  return { result, events, facts, scheduling, counters, kernel };
}

check(
  "observes a live claimant, rejects stale native pins and refuses an exited claimant without replay",
  async () => {
    const live = await scheduled("live");
    expect(live.result.code).toBe(0);
    expect(live.facts).toHaveLength(2);
    expect(live.facts[1]).toEqual(live.facts[0]);
    const dead = await scheduled("caller");
    expect(dead.result.code).toBe(1);
    expect(dead.counters.nativeDiagnostics.caller_exited).toBe(1);
    expect(dead.counters.nativeDiagnostics.ancestor_exited).toBeUndefined();
    expect(dead.facts).toHaveLength(1); // only the pre-exit observation emitted facts
    expect(dead.events).toContainEqual(
      expect.objectContaining({
        reason: "caller_exited",
        retry: false,
        ancestryFailure: expect.objectContaining({ chainIndex: 0, claimantStatus: "exited" }),
      }),
    );
    expect(dead.events.filter((event) => event.reason === "caller_exited")).toHaveLength(1);

    const server = createServer().listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing owned listener");
    const accepted = once(server, "connection");
    const client = createConnection(address.port, "127.0.0.1");
    await once(client, "connect");
    const [peer] = (await accepted) as [Socket];
    try {
      const initial = await observeSocketProcess(peer, fleetProcessHelper());
      expect(initial?.owner.pid).toBe(process.pid);
      const owner = initial!.owner;
      for (const pin of [
        { ...owner, pid: owner.pid + 1 },
        { ...owner, birth: [String(BigInt(owner.birth[0]) + 1n), owner.birth[1]] as const },
        { ...owner, socket: "1:1:1" },
      ])
        expect(await observeSocketProcess(peer, fleetProcessHelper(), pin)).toBeUndefined();
      expect(await observeSocketProcess(peer, fleetProcessHelper(), owner)).toEqual(initial);
    } finally {
      client.destroy();
      peer.destroy();
      await new Promise<void>((done) => server.close(() => done()));
      await closeNativeProcessObservers();
    }
  },
);

check(
  "records the real ESRCH position while the same claimant survives intermediate exit/reparenting",
  async () => {
    for (const [mode, chainIndex] of [
      ["direct", 1],
      ["intermediate", 2],
    ] as const) {
      const { result, facts, events, scheduling, counters, kernel } = await scheduled(mode);
      expect(kernel).toHaveLength(1);
      expect(kernel[0]!.errno === 3 || (kernel[0]!.result === 0 && kernel[0]!.bytes === 0)).toBe(true);
      expect(counters.nativeDiagnostics.ancestor_exited).toBe(1);
      expect(counters.nativeDiagnostics.caller_exited).toBeUndefined();
      expect(scheduling.fired).toBe(true);
      expect(facts[0]!.ancestors.some((entry) => entry.pid === scheduling.root)).toBe(true);
      const exit = events.find((event) => event.reason === "ancestor_exited");
      expect(exit).toMatchObject({
        errno: 3,
        retry: true,
        ancestryFailure: {
          chainIndex,
          failedPid: scheduling.root,
          claimantStatus: "same",
          claimantPid: facts[0]!.owner.pid,
          claimantBirth: facts[0]!.owner.birth,
        },
      });
      expect(result.code).toBe(0);
      expect(facts).toHaveLength(2);
      expect(facts[1]!.owner).toEqual(facts[0]!.owner);
      // The new native facts cannot grant the former root's membership.
      expect(facts[1]!.ancestors.some((entry) => entry.pid === scheduling.root)).toBe(false);
      expect(events.filter((event) => event.reason === "ancestor_exited")).toHaveLength(1);
      expect(events.every((event) => event.attempt === 1)).toBe(true);
    }
    const repeated = await scheduled("twice");
    expect(repeated.result.code).toBe(1);
    expect(repeated.facts).toHaveLength(1);
    const exits = repeated.events.filter((event) => event.reason === "ancestor_exited");
    expect(exits.map((event) => event.retry)).toEqual([true, false]);
    expect(exits.every((event) => event.ancestryFailure?.claimantStatus === "same")).toBe(true);
    expect(repeated.counters.nativeDiagnostics.ancestor_exited).toBe(2);
  },
);

check("proves membership from the live HTTP claimant and always refuses a real non-member", async () => {
  const herdr = await isolatedHerdr(directory);
  const binding = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
  const diagnostics: LocalFleetProofDiagnostic[] = [];
  const metrics = new FleetHealthMetrics();
  const link = new LocalFleetLink({
    directory: resolve(herdr.root, "links"),
    binding: async () => binding,
    prove: localFleetProof({
      binding: async () => binding,
      herdrBinary: "herdr",
      processHelper: fixture,
      diagnostics: (event, pane) => {
        diagnostics.push(event);
        metrics.observeProof("fleet", event, pane);
      },
    }),
  });
  let effects = 0;
  const responses: Array<{ status: number; effects: number }> = [];
  const forward = link.fetch(() => {
    effects++;
    return Response.json({ admitted: true });
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, env) => {
      const response = await forward(request, env);
      responses.push({ status: response.status, effects });
      return Response.json(
        { ...(await response.json()), effects, port: env.incoming.socket.remotePort },
        { status: response.status },
      );
    },
  });
  try {
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
    const endpoint = `http://127.0.0.1:${address.port}`;
    const member = await herdr.startClient("member", endpoint, true);
    expect(await herdr.request("member")).toMatchObject({ status: 200, effects: 1 });
    expect(await herdr.request("member", herdr.foreignPane)).toMatchObject({ status: 403, effects: 1 });
    await herdr.quitClient("member");
    await herdr.waitForExit(member);
    const marker = resolve(directory, "reparent.private.json");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await herdr.cli(
      "pane",
      "run",
      herdr.pane,
      [
        fixture,
        "--launch",
        marker,
        process.execPath,
        fileURLToPath(new URL("./fixtures/local-fleet-proof/socket-client.mjs", import.meta.url)),
        herdr.controlPath,
        "reparent",
        endpoint,
        herdr.pane,
      ]
        .map(quote)
        .join(" "),
    );
    const claimant = await herdr.waitForClient("reparent");
    const parent = JSON.parse(await readFile(marker, "utf8")) as { root: number; leaf: number };
    expect(parent.leaf).toBe(claimant);
    expect(await herdr.request("reparent")).toMatchObject({ status: 200, effects: 2 });
    const parentBirth = await observeNativeBirth(parent.root);
    expect(parentBirth).toBeDefined();
    const ownerCount = diagnostics.filter((event) => event.source === "socket_owner").length;
    const ownerBefore = diagnostics.filter((event) => event.source === "socket_owner").at(-1);
    await writeFile(
      `${fixture}.target`,
      `${parent.root} ${parentBirth![0]} ${parentBirth![1]} ${claimant}\n`,
    );
    // Actual intermediate ESRCH during this HTTP request; native re-walk must
    // prove the claimant's new ancestry and refuse its vanished membership.
    expect(await herdr.request("reparent")).toMatchObject({ status: 403, effects: 2 });
    await herdr.waitForExit(parent.root);
    const ownerAfter = diagnostics.filter((event) => event.source === "socket_owner").at(-1);
    expect(diagnostics.filter((event) => event.source === "socket_owner")).toHaveLength(ownerCount + 1);
    expect(ownerAfter).toEqual(ownerBefore);
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        source: "native",
        event: expect.objectContaining({
          reason: "ancestor_exited",
          retry: true,
          ancestryFailure: expect.objectContaining({ claimantStatus: "same", chainIndex: 1 }),
        }),
      }),
    );
    expect(metrics.snapshot().totals.nativeDiagnostics.ancestor_exited).toBe(1);
    await herdr.quitClient("reparent");
    await herdr.waitForExit(claimant);
    await herdr.startClient("outsider", endpoint, false);
    expect(await herdr.request("outsider")).toMatchObject({ status: 403, effects: 2 });
    expect(diagnostics).toContainEqual({ source: "proof", reason: "not_member" });
  } finally {
    await writeFile(
      resolve(directory, "http.public.json"),
      JSON.stringify({ responses, totals: metrics.snapshot().totals, effects }, null, 2),
    );
    await writeFile(
      resolve(directory, "http.private.json"),
      JSON.stringify({ diagnostics, metrics: metrics.snapshot(), effects }, null, 2),
    );
    await link.close();
    (server as HttpServer).closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await closeNativeProcessObservers();
    await herdr.close();
  }
});
