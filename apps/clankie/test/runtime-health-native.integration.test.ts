import { operatorSeatBindingFixture } from "./fixtures/operator-seat-binding-fixture.ts";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Server as HttpServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { OPERATOR_SEAT_EVENTS_PATH, RuntimeHealthSettingsSchema, type HerdrBinding } from "@clankie/protocol";
import { afterEach, expect, it } from "vitest";
import { createClankieApp, createBearerAuthenticator } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createCaptainMemory } from "../src/captain-memory.ts";
import { createFileMemory } from "../src/memory.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof, localProjectProof } from "../src/local-fleet-proof.ts";
import { Worker } from "node:worker_threads";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { RuntimeHealthObserver } from "../src/runtime-health.ts";
import { DeliveryFence, deliveryFingerprint } from "../src/captain/delivery-fence.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";
const fullDuration = process.env.RUNTIME_HEALTH_NATIVE_MANUAL === "1";
const sustainedMs = fullDuration ? 300000 : 400;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

// Real Herdr, kernel socket proof, HTTP transcript attachment, and the native
// mailbox protocol. The receiver is a protocol client, not a model/TUI, and
// cannot claim a kernel-proven harness catalog. Actual owner TUI proof is separate.
it.skipIf(process.platform !== "darwin")(
  "real CPU/slow health reaches the owned default operator mailbox and receives exact acknowledgments; a protocol client cannot claim a native harness attachment",
  async () => {
    const logs = join(
      import.meta.dirname,
      fullDuration ? "../../../.local/kai/native-health-defaults" : "../../../.local/kai/native-health",
    );
    await mkdir(logs, { recursive: true });
    // Source checkouts need the same real kernel helper shipped in releases.
    await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "../../../scripts/build-fleet-proof.mjs")],
      { timeout: 65000 },
    );
    const herdr = await isolatedHerdr(logs);
    cleanups.push(herdr.close);
    await writeFile(join(logs, "owned.json"), JSON.stringify({ root: herdr.root }));
    const binding: HerdrBinding = { runtime: "external", socketPath: herdr.socketPath, session: "default" };
    const sessionId = randomUUID();
    const transcript = join(herdr.root, `${sessionId}.jsonl`);
    await writeFile(transcript, "");
    await herdr.cli(
      "pane",
      "report-agent",
      herdr.pane,
      "--source",
      "native-health-fixture",
      "--agent",
      "claude",
      "--state",
      "idle",
      "--agent-session-id",
      sessionId,
    );
    await herdr.cli(
      "pane",
      "report-agent-session",
      herdr.pane,
      "--source",
      "herdr:claude",
      "--agent",
      "claude",
      "--agent-session-id",
      sessionId,
    );
    await herdr.cli("agent", "rename", herdr.pane, "clankie");
    const settings = new SettingsStore(join(herdr.root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      execution: {
        ...current.execution,
        connections: [
          {
            id: "offline",
            kind: "herdr",
            capabilities: [],
            session: "offline",
            enabled: true,
            socketPath: join(herdr.root, "missing.sock"),
          },
        ],
      },
    }));
    const runtimes = new ExecutionConnections({
      settings,
      primary: { binding: () => binding, status: () => ({ available: true, binding }) } as never,
    });
    const diagnostics: unknown[] = [];
    const proofOptions = {
      binding: async () => binding,
      herdrBinary: "herdr",
      diagnostics: (event: unknown) => diagnostics.push(event),
    };
    const link = new LocalFleetLink({
      directory: join(herdr.root, "links"),
      binding: proofOptions.binding,
      prove: localFleetProof(proofOptions),
      projectProof: localProjectProof(proofOptions),
    });
    const results: { fingerprint: string; conversationId: string; outcome: string; reason: string }[] = [];
    let modelTurns = 0;
    const captain = createCaptain(
      {
        herdrAvailable: () => true,
        memory: createCaptainMemory(createFileMemory({ dataDir: join(herdr.root, "memory") })),
        mcp: { catalog: async () => [] },
        browser: { catalog: async () => ({ available: false, tools: [] }) },
        runtimes,
      } as unknown as CaptainDeps,
      {
        repoRoot: join(import.meta.dirname, "../../.."),
        stateDir: join(herdr.root, "captain"),
        settings,
        bodyActivity: {
          begin: () => {
            modelTurns++;
            return () => {};
          },
        },
        onHealthAlertDelivery: (result) => results.push(result),
      },
    );
    let hot = false;
    let burn: ReturnType<typeof setInterval> | undefined;
    const burners: Worker[] = [];
    let observer: RuntimeHealthObserver;
    const seatBinding = operatorSeatBindingFixture();
    const body = await createClankieApp({
      operatorSeatBindings: seatBinding.registry,
      captain,
      settings,
      authenticateOperator: createBearerAuthenticator("native-test", { operatorId: "owned-health-test" }),
      localFleet: link,
      runtimeHealth: () => observer.snapshot(),
    });
    await seatBinding.register(body.app, "global-default", { authorization: "Bearer native-test" });
    const privateFetch = link.fetch((request) => body.app.fetch(request));
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, env) => {
        if (new URL(request.url).pathname.startsWith("/v1/fleet/")) return privateFetch(request, env);
        if (hot && new URL(request.url).pathname === "/health") await new Promise((r) => setTimeout(r, 1100));
        return body.app.fetch(request, seatBinding.httpEnv(request, env) ?? env);
      },
    });
    if (!server.listening) await once(server, "listening");
    const host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    observer = new RuntimeHealthObserver({
      settings: async () =>
        fullDuration
          ? RuntimeHealthSettingsSchema.parse({})
          : {
              enabled: true,
              cpuPercent: 50,
              healthLatencyMs: 1000,
              sustainedMs,
              sampleIntervalMs: 100,
              cooldownMs: 60000,
            },
      healthUrl: `${host}/health`,
      notify: (text) => captain.notifyRuntimeHealthAlert(text),
    });
    const receiver = join(herdr.root, "receiver.mjs");
    const ready = join(herdr.root, "ready.json");
    const failure = join(herdr.root, "receiver-error.txt");
    const notices = join(herdr.root, "notices.jsonl");
    const acknowledgeAlarm = join(herdr.root, "acknowledge-alarm");
    await writeFile(
      receiver,
      `
    import {writeFile,appendFile,readFile} from 'node:fs/promises';
    import {execFileSync} from 'node:child_process';
    process.on('unhandledRejection',e=>{writeFile(${JSON.stringify(failure)},String(e)).then(()=>process.exit(1))});
    process.on('uncaughtException',e=>{writeFile(${JSON.stringify(failure)},String(e)).then(()=>process.exit(1))});
    const host=${JSON.stringify(host)}, pane=${JSON.stringify(herdr.pane)};
    execFileSync('herdr',['pane','report-agent',pane,'--source','native-health-fixture','--agent','claude','--state','idle','--agent-session-id',${JSON.stringify(sessionId)}]);
    execFileSync('herdr',['pane','report-agent-session',pane,'--source','herdr:claude','--agent','claude','--agent-session-id',${JSON.stringify(sessionId)}]);
    execFileSync('herdr',['agent','rename',pane,'clankie']);
    const headers={authorization:'Bearer native-test','content-type':'application/json','x-clankie-pane':pane,...${JSON.stringify(seatBinding.headers("global-default"))}};
    async function post(path,value){const r=await fetch(host+path,{method:'POST',headers,body:JSON.stringify(value)});const body=await r.json();if(!r.ok)throw Error(path+':'+JSON.stringify(body));return body}
    await post('/v1/seat/transcript',{sessionId:${JSON.stringify(sessionId)},entries:[],activity:'waiting'});
    const r=await fetch(host+'/v1/fleet/seats/'+encodeURIComponent(pane)+'/tool-catalog',{method:'POST',headers,body:JSON.stringify({schemaVersion:1,harness:'claude',sessionId:${JSON.stringify(sessionId)},bridge:'operator',conversationId:'global-default',tools:[],checkedAt:new Date().toISOString()})});
    const catalog={status:r.status,body:await r.json()};
    await writeFile(${JSON.stringify(ready)},JSON.stringify(catalog));
    for(;;){const r=await fetch(host+${JSON.stringify(OPERATOR_SEAT_EVENTS_PATH)}+'?conversationId=global-default&wait=1000',{headers});if(!r.ok)throw Error('poll '+r.status);const page=await r.json();for(const e of page.events){if(e.source==='service'&&e.content.startsWith('Runtime health alarm:')){while(!(await readFile(${JSON.stringify(acknowledgeAlarm)},'utf8').catch(()=>'')))await new Promise(r=>setTimeout(r,20))}const ack=await post(${JSON.stringify(OPERATOR_SEAT_EVENTS_PATH)}+'/'+e.id+'/ack?conversationId=global-default',{});await appendFile(${JSON.stringify(notices)},JSON.stringify({event:e,ack})+'\\n')}}
  `,
      { mode: 0o600 },
    );
    const until = async (test: () => Promise<boolean>, timeoutMs = 12000) => {
      const deadline = Date.now() + timeoutMs;
      while (!(await test())) {
        const error = await readFile(failure, "utf8").catch(() => "");
        if (error) throw Error(error);
        if (Date.now() > deadline) throw Error("Native health evidence deadline exceeded");
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    try {
      // A service-authored socket fixture runs in its own owned foreground pane.
      await herdr.cli("pane", "run", herdr.pane, `${process.execPath} ${receiver}`);
      await until(async () => !!(await readFile(ready, "utf8").catch(() => "")));
      const meta = JSON.parse(
        await readFile(join(herdr.root, "captain/conversations/global-default/meta.json"), "utf8"),
      );
      expect(meta.nativeSource).toBeUndefined();
      expect(JSON.parse(await readFile(ready, "utf8"))).toEqual({
        status: 403,
        body: { error: "native_session_required" },
      });
      await until(async () => captain.operatorSeatReady!());
      hot = true;
      observer.start();
      // Burn CPU time, not wall time: under machine load a wall-clock spin is
      // descheduled and the sampler sees far less than the threshold. Extra
      // spinning threads count toward process CPU (100% = one core), so the
      // observed share stays above the threshold at any realistic load.
      for (const _ of [0, 1]) {
        const worker = new Worker("for(;;);", { eval: true });
        burners.push(worker);
      }
      burn = setInterval(() => {
        if (!hot) return;
        const start = process.cpuUsage();
        while (true) {
          const used = process.cpuUsage(start);
          if (used.user + used.system >= 25_000) break;
        }
      }, 5);
      const rows = async () =>
        (await readFile(notices, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((row) => JSON.parse(row))
          // Transport uncertainty can publish its own advisory. This proof counts
          // runtime incidents, while the receiver acknowledges every channel event.
          .filter((row) => row.event.source === "service" && row.event.content.startsWith("Runtime health "));
      // Exercise a real late acknowledgment, not the runner's scheduling luck.
      // The original call's audit stays unconfirmed; its exact durable ack settles later.
      await until(async () => results.some((result) => result.reason === "owner_mailbox_unconfirmed"));
      await writeFile(acknowledgeAlarm, "acknowledge the original alarm");
      // The receiver can persist its acknowledgment before notify() settles and
      // the observer publishes the alarm. Wait for both real boundaries.
      await until(async () => {
        const snapshot = observer.snapshot();
        return (await rows()).length === 1 && snapshot.state === "alarm" && snapshot.delivery === "accepted";
      }, sustainedMs + 15000);
      expect(observer.snapshot()).toMatchObject({
        state: "alarm",
        delivery: "accepted",
        reasons: ["cpu", "health"],
      });
      // Prove another completed unhealthy sample does not duplicate the notice;
      // a fixed sleep can elapse before that sample runs on a busy machine.
      const alarmObservation = observer.snapshot().observedAt;
      await until(async () => observer.snapshot().observedAt !== alarmObservation);
      expect(await rows()).toHaveLength(1);
      hot = false;
      clearInterval(burn);
      await Promise.all(burners.splice(0).map((worker) => worker.terminate()));
      await until(
        async () => {
          const snapshot = observer.snapshot();
          return (
            (await rows()).length === 2 && snapshot.state === "healthy" && snapshot.delivery === "accepted"
          );
        },
        fullDuration ? 60000 : 12000,
      );
      observer.stop();
      const delivered = await rows();
      const receipts = () =>
        new Map(
          new DeliveryFence(
            join(herdr.root, "captain/delivery-receipts/head/global-default.json.delivered"),
          ).all(),
        );
      await until(async () => {
        const published = receipts();
        return (
          results.length === 2 &&
          delivered.every(
            (row) => published.get(row.event.id)?.fingerprint === deliveryFingerprint(row.event.content),
          )
        );
      });
      expect(delivered[0].event.content).toContain("Runtime health alarm: cpu and health");
      expect(delivered[1].event.content).toContain("Runtime health recovered after");
      for (const row of delivered)
        expect(row.ack).toMatchObject({ acknowledged: true, deliveryStage: "delivered" });
      expect(new Set(delivered.map((row) => row.event.id)).size).toBe(2);
      expect(observer.snapshot().lastIncidentDurationMs).toBeGreaterThanOrEqual(sustainedMs);
      expect(results).toHaveLength(2);
      expect(results).toEqual(
        expect.arrayContaining(
          delivered.map((row) => ({
            fingerprint: deliveryFingerprint(row.event.content),
            conversationId: row.event.conversationId,
            outcome: "submitted",
            reason: expect.stringMatching(/^owner_mailbox_(delivered|unconfirmed)$/u),
          })),
        ),
      );
      expect(
        results.find((result) => result.fingerprint === deliveryFingerprint(delivered[0].event.content)),
      ).toMatchObject({ reason: "owner_mailbox_unconfirmed" });
      expect(delivered.map((row) => receipts().get(row.event.id))).toEqual(
        delivered.map((row) =>
          expect.objectContaining({
            messageId: row.event.id,
            fingerprint: deliveryFingerprint(row.event.content),
            conversationId: row.event.conversationId,
          }),
        ),
      );
      expect(modelTurns).toBe(0);
      await writeFile(
        join(logs, "result.json"),
        JSON.stringify({ delivered, results, final: observer.snapshot(), modelTurns }, null, 2),
      );
    } finally {
      await writeFile(join(logs, "proof-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
      observer.stop();
      if (burn) clearInterval(burn);
      await Promise.all(burners.splice(0).map((worker) => worker.terminate()));
      await captain.close();
      body.close();
      await link.close();
      (server as HttpServer).closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(receiver, { force: true });
    }
  },
  sustainedMs + 65000,
);
