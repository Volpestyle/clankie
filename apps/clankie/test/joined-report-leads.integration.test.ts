import { createServer } from "node:http";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import {
  createCaptainConversationDispatch,
  createDeviceConversationDispatch,
} from "../../relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { TAKE_CONTROL_GRANTS } from "@clankie/protocol";
import {
  JoinedWorkerLaunchSchema,
  JoinedWorkerProofSchema,
  MachineJoinLeaseSchema,
  MachineJoinStatusSchema,
  machineJoinLeaseAad,
} from "@clankie/protocol/machine-join";
import { createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { MachineJoins } from "../src/machine-joins.ts";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue } from "../src/gateway-encryption.ts";
import { runJoinedMachineChannel, saveJoinedMachineCredential } from "../../tui/bin/joined-machine-client.ts";
import { joinedSeatTransport, runJoinedSeatHook } from "../../tui/src/command/joined-seat.ts";
import { joinedWorkerPorts } from "../../tui/src/command/joined-worker.ts";
import { runFleetReportLeadsCommand } from "../../tui/src/command/fleet-report-leads.ts";
import type { McpCommandOptions } from "../../tui/src/command/mcp.ts";
import type { HeadlessCaptainCommandOptions } from "../../tui/bin/headless-captain.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Real service/TCP, encrypted join, broker, joined CLI/MCP bridge and persistent
// journals. Native harness launch/observation is an isolated remote-machine fixture.
it.each(["claude", "codex"] as const)(
  "joined %s report grants stay bound through revocation and restart (#876)",
  async (harness) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "joined-report-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const repoRoot = await realpath(join(import.meta.dirname, "../../.."));
    const settings = new SettingsStore(join(root, "settings.json"));
    const secrets = new FileCredentialStore(join(root, "home-secrets.json"));
    const local = new FileCredentialStore(join(root, "local-secrets.json"));
    const deviceSessionKey = randomBytes(32);
    const eventLogPath = join(root, "devices.jsonl");
    const now = Date.now();
    const events = ["allowed-app", "unrelated-app"].flatMap((deviceId) =>
      [
        {
          type: "device.pairing.redeemed",
          data: {
            offerId: deviceId,
            name: deviceId,
            platform: "ios",
            offeredGrants: TAKE_CONTROL_GRANTS,
            mintedBy: "local-operator",
            scope: "connector",
            pendingExpiresAt: new Date(now + 60_000).toISOString(),
          },
        },
        {
          type: "device.activated",
          data: { grants: TAKE_CONTROL_GRANTS, sessionExpiresAt: new Date(now + 3600_000).toISOString() },
        },
      ].map((event) =>
        JSON.stringify({
          id: randomUUID(),
          type: event.type,
          occurredAt: new Date(now).toISOString(),
          missionId: `device:${deviceId}`,
          correlationId: "joined-proof",
          profileHash: "fixture",
          data: { schemaVersion: 1, deviceId, ...event.data },
        }),
      ),
    );
    await writeFile(eventLogPath, events.join("\n") + "\n");
    const makeCaptain = () =>
      createCaptain(
        {
          herdrAvailable: () => false,
          memory: {},
          embodiment: {},
          browser: { catalog: async () => ({ available: false, tools: [] }) },
          mcp: { catalog: async () => [], tools: async () => [], close: async () => {} },
        } as unknown as CaptainDeps,
        {
          repoRoot,
          stateDir: root,
          workingDirectory: root,
          settings,
          seatAdapters: [],
          discordEnvironment: {},
        },
      );
    let captain = makeCaptain();
    cleanup.push(async () => captain.close());
    const created = await captain.serveOperatorConversation({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "global" },
      title: "Permitted lead",
    });
    if (created.op !== "create") throw Error("Missing destination");
    const otherId = created.conversation.conversationId;
    await captain.pollSeatEvents(1, undefined, "global-default");
    await captain.pollSeatEvents(1, undefined, otherId);
    let joins = new MachineJoins({ settings, secrets, directory: join(root, "joins") });
    let ownerAllowed = true;
    const makeService = () =>
      createClankieApp({
        captain,
        settings,
        machineJoins: joins,
        eventLogPath,
        deviceSessionKey,
        seatCallReceiptPath: join(root, "seat-calls.json"),
        authenticateCaptain: async (request) =>
          request.headers.get("authorization") === "Bearer fixture-relay-captain-token"
            ? { captainId: "relay", steerSourceLane: "api" }
            : undefined,
        authenticateOperator: async (request) =>
          ownerAllowed && request.headers.get("authorization") === "Bearer fixture-owner"
            ? { operatorId: "owner" }
            : undefined,
      });
    let service = await makeService();
    cleanup.push(async () => service.close());
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => service.app.fetch(request) });
    if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(async () => {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const relayHandler = createOperatorConversationRelayHandler({
      authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: origin }),
      dispatch: createCaptainConversationDispatch({
        baseUrl: origin,
        bearerToken: "fixture-relay-captain-token",
      }),
      deviceDispatch: createDeviceConversationDispatch({ baseUrl: origin }),
    });
    const relay = createServer((request, response) => {
      void relayHandler(request, response).then((handled) => {
        if (!handled) response.writeHead(404).end();
      });
    });
    relay.listen(0, "127.0.0.1");
    if (!relay.listening) await new Promise<void>((resolve) => relay.once("listening", resolve));
    cleanup.push(async () => {
      relay.closeAllConnections();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    });
    const relayOrigin = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;
    const code = randomBytes(32).toString("base64url"),
      claimSecret = randomBytes(32).toString("base64url");
    const ticket = joins.start({
      name: "fixture remote",
      platform: "darwin",
      directories: [root],
      claimSecret,
      approvalHash: machineJoinHash(code),
    });
    await joins.approve({ code, accessLevel: "workers", directories: [root] }, async () => {});
    const status = MachineJoinStatusSchema.parse(joins.status(ticket.joinId, claimSecret));
    if (status.state !== "approved") throw Error("Join refused");
    const credential = {
      origin,
      lease: MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(machineJoinKey(code), status.sealedLease, machineJoinLeaseAad(ticket.joinId)),
        ),
      ),
      localDirectories: [root],
    };
    await saveJoinedMachineCredential(local, credential);
    const wire = joinedSeatTransport(credential, fetch);
    let launch: ReturnType<typeof JoinedWorkerLaunchSchema.parse> | undefined;
    let nativeSession: string = randomUUID();
    let launches = 0,
      proofs = 0;
    let oldProof: string | undefined;
    let replayProof = false;
    let beforeProof: (() => Promise<void>) | undefined;
    const paneId = "fixture-worker";
    const nativeFile = join(root, "native.json");
    const observe = async () =>
      JSON.stringify({
        result: {
          agent: {
            pane_id: paneId,
            cwd: root,
            agent_session: { agent: harness, kind: "id", value: nativeSession },
          },
        },
      });
    const writeNative = async () => writeFile(nativeFile, await observe());
    await mkdir(join(root, "bin"));
    await writeFile(
      join(root, "bin/herdr"),
      `#!${process.execPath}\nimport {readFileSync} from 'node:fs';process.stdout.write(readFileSync(${JSON.stringify(nativeFile)},'utf8'));\n`,
    );
    await chmod(join(root, "bin/herdr"), 0o755);
    await writeNative();
    const adapter = joinedWorkerPorts(credential, {
      env: { HOME: root, PATH: process.env.PATH },
      run: async (args) => {
        expect(args).toEqual(["agent", "get", paneId]);
        return observe();
      },
    });
    const abort = new AbortController();
    const channel = runJoinedMachineChannel(credential, {
      store: local,
      signal: abort.signal,
      intervalMs: 10,
      ports: {
        workers: async (request, directory, signal) => {
          const raw: unknown = JSON.parse(request);
          if (JoinedWorkerProofSchema.safeParse(raw).success) {
            proofs++;
            const action = beforeProof;
            beforeProof = undefined;
            await action?.();
            const response = await adapter(request, directory, signal);
            if (replayProof && oldProof !== undefined) return oldProof;
            oldProof = response;
            return response;
          }
          launch = JoinedWorkerLaunchSchema.parse(raw);
          launches++;
          nativeSession = harness === "claude" ? launch.sessionId : randomUUID();
          await writeNative();
          const response = await wire.rpc({
            method: "POST",
            path: "/workers/admit",
            headers: { authorization: `Bearer ${launch.token}` },
            body: JSON.stringify({
              paneId,
              sessionId: launch.sessionId,
              ...(harness === "codex" ? { nativeSessionId: nativeSession } : {}),
            }),
          });
          expect(response.status).toBe(200);
          return "Native launch fixture admitted";
        },
      },
    });
    cleanup.push(async () => {
      abort.abort();
      await channel;
    });
    const hire = await joins.hireWorker({
      machineId: credential.lease.machineId,
      conversationId: "global-default",
      title: "Worker",
      brief: "Report fixture output",
      workingDirectory: root,
      harness,
    });
    expect(hire.outcome).toBe("started");
    expect(launch).toBeDefined();
    const id = String(hire.joinedHireId);
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      PATH: `${join(root, "bin")}:${process.env.PATH}`,
      CLANKIE_CREDENTIALS_FILE: join(root, "local-secrets.json"),
      HERDR_PANE_ID: paneId,
      CLANKIE_CONVERSATION_ID: "global-default",
      CLANKIE_JOINED_SEAT_TOKEN: launch!.token,
      CLANKIE_JOINED_WORKER_SESSION: launch!.sessionId,
      CLANKIE_JOINED_WORKER_HARNESS: harness,
      CLANKIE_SEAT_PARENT_ARGV: harness === "claude" ? `claude --session-id ${launch!.sessionId}` : "codex",
    };
    let client: Client | undefined;
    let bridged: Promise<unknown> | undefined;
    let lostDeliveryId: string | undefined;
    const connect = async () => {
      const [harnessTransport, bridge] = InMemoryTransport.createLinkedPair();
      const forward = bridge.send.bind(bridge);
      bridge.send = async (message) => {
        if (lostDeliveryId && "result" in message && JSON.stringify(message).includes(lostDeliveryId)) {
          lostDeliveryId = undefined;
          await bridge.close(); // Service accepted; the original harness receives no reply.
          return;
        }
        await forward(message);
      };
      const options: HeadlessCaptainCommandOptions & McpCommandOptions = {
        repoRoot,
        env,
        transport: bridge,
        stderr: { write: () => true },
      };
      bridged = runJoinedSeatHook("mcp", ["--seat"], options);
      client = new Client({ name: "joined-worker", version: "1" }, { capabilities: {} });
      await Promise.race([
        client.connect(harnessTransport),
        bridged.then(() => {
          throw Error("Joined bridge exited before connect");
        }),
      ]);
    };
    cleanup.push(async () => {
      await client?.close();
      await bridged;
    });
    const tool = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client!.callTool({ name, arguments: args });
      if (result.isError) throw Error(JSON.stringify(result));
      return decodeMcpResult(result) as Record<string, unknown> & {
        deliveryId: string;
        leads: { id: string }[];
      };
    };
    const report = (text: string, target?: string, deliveryId: string = randomUUID()) =>
      tool("message_clankie", { text, deliveryId, ...(target === undefined ? {} : { target }) });
    const ownerFetcher = {
      fetch: (path: string, init?: RequestInit) =>
        fetch(origin + path, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            authorization: "Bearer fixture-owner",
          },
        }),
    };
    const manage = (args: string[]) =>
      runFleetReportLeadsCommand(["--joined-hire", id, ...args], { host: origin, ownerFetcher });
    const reports = async (conversationId: string) => {
      const result = await captain.serveOperatorConversation({
        op: "worker_reports",
        schemaVersion: 1,
        conversationId,
      });
      if (result.op !== "worker_reports") throw Error("Missing reports");
      return result.page.items;
    };
    await connect();
    expect((await client!.listTools()).tools.map((entry) => entry.name).sort()).toEqual([
      "evidence_fetch",
      "evidence_list",
      "evidence_push",
      "list_report_leads",
      "message_clankie",
      "message_clankie_status",
      "reconcile_seat_call",
      "reply",
    ]);
    expect(await tool("list_report_leads")).toMatchObject({ leads: [{ id: "conversation:global-default" }] });
    expect(await report("Unknown destination", `conversation:${otherId}`)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    expect(await reports(otherId)).toHaveLength(0);
    expect(await reports("global-default")).toHaveLength(0);
    replayProof = true;
    await expect(report("A replayed native snapshot is not proof")).rejects.toThrow();
    replayProof = false;
    expect(await reports("global-default")).toHaveLength(0);
    expect(
      (
        await wire.rpc({
          method: "GET",
          path: "/workers/check",
          headers: { authorization: "Bearer unknown-worker" },
        })
      ).status,
    ).toBe(403);
    await expect(manage(["grant", "missing-conversation"])).rejects.toThrow();
    const foreignCode = randomBytes(32).toString("base64url"),
      foreignClaim = randomBytes(32).toString("base64url");
    const foreignTicket = joins.start({
      name: "other fixture machine",
      platform: "darwin",
      directories: [root],
      claimSecret: foreignClaim,
      approvalHash: machineJoinHash(foreignCode),
    });
    await joins.approve({ code: foreignCode, accessLevel: "workers", directories: [root] }, async () => {});
    const foreignStatus = MachineJoinStatusSchema.parse(joins.status(foreignTicket.joinId, foreignClaim));
    if (foreignStatus.state !== "approved") throw Error("Foreign fixture join refused");
    const foreign = {
      origin,
      localDirectories: [root],
      lease: MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(
            machineJoinKey(foreignCode),
            foreignStatus.sealedLease,
            machineJoinLeaseAad(foreignTicket.joinId),
          ),
        ),
      ),
    };
    expect(
      (
        await joinedSeatTransport(foreign, fetch).rpc({
          method: "GET",
          path: "/workers/check",
          headers: { authorization: `Bearer ${launch!.token}` },
        })
      ).status,
    ).toBe(403);

    const grant = await manage(["grant", otherId]);
    const target = grant.leads.find((entry) => entry.conversationId === otherId)!.id;
    let ownerChecks = 0;
    const revokeOwner = async (): Promise<void> => {
      if (++ownerChecks < 2) beforeProof = revokeOwner;
      else ownerAllowed = false;
    };
    beforeProof = revokeOwner;
    await expect(manage(["grant", otherId])).rejects.toThrow();
    ownerAllowed = true;
    expect((await manage(["list"])).leads.filter((entry) => entry.conversationId === otherId)).toHaveLength(
      1,
    );
    const accepted = await report("Only for the permitted lead", target);
    expect(accepted).toMatchObject({ received: true, deliveryStage: "stored" });
    expect(await reports(otherId)).toMatchObject([{ text: "Only for the permitted lead" }]);
    expect(await reports("global-default")).toHaveLength(0);
    expect(await report("Original home behavior")).toMatchObject({ received: true });
    expect(await reports("global-default")).toMatchObject([{ text: "Original home behavior" }]);
    const ownerBody = JSON.stringify({ joinedHireId: id, change: { op: "grant", conversationId: otherId } });
    expect(
      (
        await fetch(origin + "/v1/fleet/report-leads", {
          method: "POST",
          headers: { authorization: `Bearer ${launch!.token}`, "content-type": "application/json" },
          body: ownerBody,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await wire.rpc({
          method: "POST",
          path: "/v1/fleet/report-leads",
          headers: { authorization: `Bearer ${launch!.token}` },
          body: ownerBody,
        })
      ).status,
    ).toBe(403);
    const appToken = (deviceId: string) =>
      new DeviceSessionSigner(deviceSessionKey).issue(
        mintDeviceSessionClaims({ deviceId, nowEpochSeconds: Math.floor(now / 1000), ttlSeconds: 3600 }),
      );
    expect(
      (
        await fetch(origin + "/v1/fleet/report-leads", {
          method: "POST",
          headers: { authorization: `Bearer ${appToken("allowed-app")}`, "content-type": "application/json" },
          body: ownerBody,
        })
      ).status,
    ).toBe(403);
    const appGrant = await manage(["grant", otherId, "allowed-app", "joined-report"]);
    const appTarget = appGrant.leads.find((entry) => entry.deviceId === "allowed-app")!.id;
    expect(await report("Apps lead mode is required", appTarget)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    const handoff = await fetch(origin + "/operator/v1/dispatch", {
      method: "POST",
      headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
      body: JSON.stringify({ op: "lead", schemaVersion: 1, command: { action: "set", lead: "apps" } }),
    });
    expect(handoff.status).toBe(200);
    expect(await report("App inbox only", appTarget)).toMatchObject({ received: true });
    const appReports = async (deviceId: string) => {
      const response = await fetch(relayOrigin + "/operator/v1/dispatch", {
        method: "POST",
        headers: { authorization: `Bearer ${appToken(deviceId)}`, "content-type": "application/json" },
        body: JSON.stringify({ op: "worker_reports", schemaVersion: 1, conversationId: otherId }),
      });
      expect(response.status).toBe(200);
      return (await response.json()).page.items;
    };
    expect(await appReports("allowed-app")).toMatchObject([{ text: "App inbox only" }]);
    expect(await appReports("unrelated-app")).toHaveLength(0);
    await manage(["revoke", appTarget]);
    expect(await report("Revoked app must never see this", appTarget)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    expect(
      (await appReports("allowed-app")).some((item: { text: string }) => item.text.includes("Revoked")),
    ).toBe(false);
    // Reusing an ID cannot change its target or text, even when both targets were permitted.
    expect(
      await report("Only for the permitted lead", "conversation:global-default", accepted.deliveryId),
    ).toMatchObject({ received: false });
    expect(await report("Changed text", target, accepted.deliveryId)).toMatchObject({ received: false });
    const restart = async () => {
      await client!.close();
      await bridged;
      await service.close();
      const retired = await service.app.request("/v1/fleet/report-leads", {
        method: "POST",
        headers: { authorization: "Bearer fixture-owner", "content-type": "application/json" },
        body: JSON.stringify({ joinedHireId: id, change: { op: "list" } }),
      });
      expect(retired.status).toBe(403);
      await captain.close();
      captain = makeCaptain();
      await captain.pollSeatEvents(1, undefined, "global-default");
      await captain.pollSeatEvents(1, undefined, otherId);
      joins = new MachineJoins({ settings, secrets, directory: join(root, "joins") });
      service = await makeService();
      await connect();
    };
    const lostId = randomUUID();
    lostDeliveryId = lostId;
    await expect(report("Lost reply retains its destination", target, lostId)).rejects.toThrow();
    await restart();
    expect(await report("Lost reply retains its destination", target, lostId)).toMatchObject({
      received: true,
      deliveryId: lostId,
    });
    expect((await reports(otherId)).filter((item) => item.deliveryId === lostId)).toHaveLength(1);
    expect((await reports("global-default")).filter((item) => item.deliveryId === lostId)).toHaveLength(0);
    expect(await report("Only for the permitted lead", target, accepted.deliveryId)).toMatchObject({
      received: true,
      deliveryId: accepted.deliveryId,
    });
    expect((await reports(otherId)).filter((item) => item.deliveryId === accepted.deliveryId)).toHaveLength(
      1,
    );
    expect(await tool("message_clankie_status", { deliveryId: accepted.deliveryId })).toMatchObject({
      deliveryId: accepted.deliveryId,
    });
    expect(
      (await tool("list_report_leads")).leads.some((entry: { id: string }) => entry.id === appTarget),
    ).toBe(false);
    expect(await report("Still revoked after restart", appTarget)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    await manage(["revoke", target]);
    expect(await report("Revoked conversation", target)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    const again = await manage(["grant", otherId]);
    const next = again.leads.find((entry) => entry.conversationId === otherId)!.id;
    // Revoke while the final adapter proof is outstanding; no acceptance afterwards.
    let seen = 0;
    const revokeDuringProof = async (): Promise<void> => {
      if (++seen < 3) {
        beforeProof = revokeDuringProof;
        return;
      }
      const files = await import("node:fs/promises");
      const directory = join(root, "seat-calls.json.joined-workers");
      const path = join(directory, `${id}.json`);
      // Owner route runs independently while the report awaits its native proof.
      await manage(["revoke", next]);
      expect(
        JSON.parse(await files.readFile(path, "utf8")).reportLeads.some(
          (entry: { id: string }) => entry.id === next,
        ),
      ).toBe(false);
    };
    beforeProof = revokeDuringProof;
    expect(await report("Revoked during final proof", next)).toMatchObject({
      received: false,
      definitive: "not_sent",
    });
    expect((await reports(otherId)).some((item) => item.text === "Revoked during final proof")).toBe(false);
    // Empty means empty after restart; legacy default reports remain separate.
    await manage(["revoke", "conversation:global-default"]);
    await restart();
    expect(await tool("list_report_leads")).toMatchObject({ leads: [] });
    await settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
    await expect(report("Watch must block reporting")).rejects.toThrow();
    await settings.update((current) => {
      const { watch: _watch, ...autonomy } = current.autonomy ?? {};
      return { ...current, autonomy };
    });
    expect(await report("Default still goes home")).toMatchObject({ received: true });
    const saved = JSON.parse(
      await readFile(join(root, "seat-calls.json.joined-workers", `${id}.json`), "utf8"),
    );
    expect(saved.reportLeads).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(launch!.token);
    nativeSession = randomUUID();
    await writeNative();
    await expect(manage(["grant", otherId])).rejects.toThrow();
    // Restart must not turn the persisted identity into native proof or re-launch it.
    await client!.close();
    await bridged;
    client = undefined;
    bridged = undefined;
    await service.close();
    await captain.close();
    captain = makeCaptain();
    joins = new MachineJoins({ settings, secrets, directory: join(root, "joins") });
    service = await makeService();
    expect(
      (
        await wire.rpc({
          method: "GET",
          path: "/workers/check",
          headers: { authorization: `Bearer ${launch!.token}` },
        })
      ).status,
    ).toBe(403);
    nativeSession = saved.nativeSessionId;
    await writeNative();
    await settings.update((current) => ({
      ...current,
      machineAccess: { ...current.machineAccess, [credential.lease.machineId]: "portal" },
    }));
    expect(
      (
        await wire.rpc({
          method: "GET",
          path: "/workers/check",
          headers: { authorization: `Bearer ${launch!.token}` },
        })
      ).status,
    ).toBe(403);
    const beforeRestore = proofs;
    await settings.update((current) => ({
      ...current,
      machineAccess: { ...current.machineAccess, [credential.lease.machineId]: "workers" },
    }));
    // The owner can raise the ceiling again; the original native session still needs fresh proof.
    expect(
      (
        await wire.rpc({
          method: "GET",
          path: "/workers/check",
          headers: { authorization: `Bearer ${launch!.token}` },
        })
      ).status,
    ).toBe(200);
    expect(proofs).toBeGreaterThan(beforeRestore);
    expect(launches).toBe(1);
    expect(proofs).toBeGreaterThan(0);
  },
  60_000,
);
