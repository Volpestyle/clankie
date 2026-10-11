import { randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { expect, test } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  MachineJoinLeaseSchema,
  MachineJoinStatusSchema,
  machineJoinLeaseAad,
} from "@clankie/protocol/machine-join";
import { MachineJoins } from "../src/machine-joins.ts";
import { createMachineJoinRoutes } from "../src/machine-join-routes.ts";
import { createJoinedSeats } from "../src/joined-seats.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { logger } from "../src/app/log.ts";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue } from "../src/gateway-encryption.ts";
import { saveJoinedMachineCredential } from "../../tui/bin/joined-machine-client.ts";
import { joinedSeatTransport, runJoinedSeatHook } from "../../tui/src/command/joined-seat.ts";
import { runSeatCommand } from "../../tui/src/command/seat.ts";
import { runHeadlessCaptainCommand } from "../../tui/bin/headless-captain.ts";
import { connectLaneUpstream } from "../../tui/src/command/mcp.ts";

// Real socket, join approval/envelopes, broker, conversation store and MCP client/server.
// Native launch is observed at the spawn boundary; Windows/Claude UI proof is separate.
test("joined Claude uses a home workspace chat, plugin, lead bank and transcript through encrypted join", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joined-seat-")));
  const repoRoot = await realpath(join(import.meta.dirname, "../../.."));
  const directory = await realpath(process.cwd());
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, maximumTrustMode: true }));
  const secrets = new FileCredentialStore(join(root, "home-secrets.json"));
  const localFile = join(root, "local-secrets.json");
  const local = new FileCredentialStore(localFile);
  const mcp = createMcpHost({ settings, credentials: secrets, logger });
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp,
    } as unknown as CaptainDeps,
    { repoRoot, stateDir: root, settings },
  );
  const joins = new MachineJoins({ settings, secrets, directory: join(root, "joins") });
  const seats = createJoinedSeats({ joins, captain, settings });
  const relay = new Hono().route(
    "/h/fixture",
    createMachineJoinRoutes(joins, async () => "authentication_required"),
  );
  const server = serve({ fetch: relay.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/h/fixture`;
  const approve = async (accessLevel = "workers") => {
    const code = randomBytes(32).toString("base64url");
    const claimSecret = randomBytes(32).toString("base64url");
    const ticket = joins.start({
      name: "joined fixture",
      platform: "darwin",
      directories: [directory],
      claimSecret,
      approvalHash: machineJoinHash(code),
    });
    await joins.approve({ code, accessLevel, directories: [directory] }, async () => {});
    const status = MachineJoinStatusSchema.parse(joins.status(ticket.joinId, claimSecret));
    if (status.state !== "approved") throw Error("approval failed");
    return {
      origin,
      lease: MachineJoinLeaseSchema.parse(
        JSON.parse(
          openGatewayValue(machineJoinKey(code), status.sealedLease, machineJoinLeaseAad(ticket.joinId)),
        ),
      ),
      localDirectories: [directory],
    };
  };
  const credential = await approve();
  await saveJoinedMachineCredential(local, credential);
  const wire = joinedSeatTransport(credential, fetch);
  const env = {
    ...process.env,
    CLANKIE_CREDENTIALS_FILE: localFile,
    CLANKIE_SETTINGS_FILE: join(root, "client-settings.json"),
    XDG_STATE_HOME: join(root, "state"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CLANKIE_OPERATOR_TOKEN: undefined,
    CLANKIE_CAPTAIN_TOKEN: undefined,
  };
  let chat = "";
  let launches = 0;
  const cli = {
    repoRoot,
    env,
    joinCredentialStore: local,
    execFileImpl: async () => ({ stdout: "Claude Code fixture version", stderr: "" }),
    spawnImpl: async (
      _command: string,
      args: readonly string[],
      cwd: string,
      childEnv?: NodeJS.ProcessEnv,
    ) => {
      launches += 1;
      expect(cwd).toBe(directory);
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("plugin:clankie@inline");
      const plugin = args[args.indexOf("--plugin-dir") + 1]!;
      expect(JSON.parse(await readFile(join(plugin, ".mcp.json"), "utf8")).mcpServers.lead.args).toEqual([
        "mcp",
        "--lane",
        "operator",
      ]);
      const permission = JSON.parse(args[args.indexOf("--settings") + 1]!).permissions.allow;
      expect(permission).toContain("mcp__plugin_clankie_lead");
      expect(childEnv?.CLANKIE_OPERATOR_TOKEN).toBeUndefined();
      const conversationId = childEnv!.CLANKIE_CONVERSATION_ID!;
      if (chat) expect(conversationId).toBe(chat);
      else chat = conversationId;
      expect(captain.seatContext(chat)).toEqual({
        conversationId: chat,
        cwd: directory,
        machineId: credential.lease.machineId,
      });
      const token = childEnv!.CLANKIE_JOINED_SEAT_TOKEN!;
      let prompt = "";
      expect(
        await runJoinedSeatHook(
          "prompt",
          ["--lane", "operator", "--conversation", chat, "--harness", "claude"],
          {
            repoRoot,
            env: childEnv!,
            stdout: {
              write: (value) => {
                prompt += value;
              },
            },
          },
        ),
      ).toBe(0);
      expect(prompt).toContain("Clankie");
      const nativePrompt = await promisify(execFile)(
        process.execPath,
        [join(repoRoot, "apps/tui/bin/clankie.ts"), "prompt", "--lane", "operator", "--conversation", chat],
        { env: childEnv!, cwd: directory, timeout: 10_000 },
      );
      expect(nativePrompt.stdout).toContain("Clankie");
      const upstream = await connectLaneUpstream({
        host: "http://joined-seat.invalid",
        bearer: "synthetic-adapter-bearer",
        conversationId: chat,
        fetchImpl: wire.fetchFor(token),
      });
      try {
        const tools = await upstream.listTools();
        expect(tools.map((tool) => tool.name)).toContain("message_seat");
        expect(tools.map((tool) => tool.name)).not.toContain("shell");
        const foreign = await wire.fetchFor(token)(
          "http://joined-seat.invalid/v1/captain/prompt?conversationId=global-default",
        );
        expect(foreign.status).toBe(403);
        const foreignSession = await wire.fetchFor(token)(
          `http://joined-seat.invalid/v1/seat/transcript?conversationId=${chat}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: randomUUID(), entries: [] }),
          },
        );
        expect(foreignSession.status).toBe(403);
        const synced = await wire.fetchFor(token)(
          `http://joined-seat.invalid/v1/seat/transcript?conversationId=${chat}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionId: childEnv!.CLANKIE_SEAT_SESSION_ID,
              entries: [
                {
                  type: "message",
                  id: randomUUID(),
                  role: "agent",
                  text: "Joined seat transcript arrived at home.",
                },
              ],
            }),
          },
        );
        expect(synced.status).toBe(200);
        const conversation = await captain.serveOperatorConversation({
          op: "replay",
          schemaVersion: 1,
          replay: { schemaVersion: 1, conversationId: chat, surfaceClientId: "joined-proof", limit: 100 },
        });
        expect(JSON.stringify(conversation)).toContain("Joined seat transcript arrived at home.");
        const secondMachine = joinedSeatTransport(await approve(), fetch);
        expect(
          (
            await secondMachine.rpc({
              method: "GET",
              path: "/v1/fleet/lead/prompt",
              headers: { authorization: `Bearer ${token}` },
            })
          ).status,
        ).toBe(403);
        const race = await wire.rpc({
          method: "POST",
          path: "/launch",
          headers: {},
          body: JSON.stringify({
            directory,
            sessionId: randomUUID(),
            conversationId: chat,
            fresh: false,
            dryRun: false,
          }),
        });
        expect(race.status).toBe(409);
        if (launches === 2) {
          // A remote native seat needs its own workers consent, not shell on the home.
          await settings.update((current) => ({
            ...current,
            machineAccess: { ...current.machineAccess, local: "portal" },
          }));
          const headers = {
            "x-clankie-seat-capabilities": JSON.stringify({
              schemaVersion: 1,
              eventKinds: ["wake", "watch", "message", "escalation", "turn"],
              ownerOrigin: true,
            }),
          };
          const poll = (wait: number) =>
            wire.fetchFor(token)(
              `http://joined-seat.invalid/v1/seat/events?conversationId=${chat}&wait=${wait}`,
              { headers },
            );
          expect((await poll(1)).status).toBe(200);
          expect(captain.operatorSeatReady?.(chat)).toBe(true);
          const wake = captain.wakeConversation(
            { conversationId: chat },
            "Joined channel wake proof",
            undefined,
            "machine",
            false,
          );
          const page = await (await poll(2000)).json();
          const event = page.events.find(
            (item: { content: string }) => item.content === "Joined channel wake proof",
          );
          expect(event).toBeDefined();
          const ack = await wire.fetchFor(token)(
            `http://joined-seat.invalid/v1/seat/events/${event.id}/ack?conversationId=${chat}`,
            { method: "POST" },
          );
          expect(ack.status).toBe(200);
          expect(await wake).toBe(true);
        }
      } finally {
        await upstream.close();
      }
      return 0;
    },
  };
  try {
    let dry = "";
    expect(
      await runSeatCommand(["--new", "--dry-run"], {
        ...cli,
        stdout: {
          write: (value) => {
            dry += value;
          },
        },
      }),
    ).toBe(0);
    expect(JSON.parse(dry).newConversation).toBeDefined();
    expect(await captain.serveOperatorConversation({ op: "list", schemaVersion: 1 })).toMatchObject({
      conversations: [{ conversationId: "global-default" }],
    });
    expect(await runSeatCommand(["--new"], cli)).toBe(0);
    expect(await runSeatCommand(["--conversation", chat], cli)).toBe(0);
    expect(launches).toBe(2);
    const denied = await wire.rpc({
      method: "POST",
      path: "/launch",
      headers: {},
      body: JSON.stringify({
        directory,
        sessionId: randomUUID(),
        conversationId: "global-default",
        fresh: false,
        dryRun: false,
      }),
    });
    expect(denied.status).toBe(403);
    await expect(runSeatCommand(["--resume"], cli)).rejects.toThrow("resume and other seats");
    let error = "";
    expect(
      await runHeadlessCaptainCommand(["start"], {
        repoRoot,
        env,
        stderr: {
          write: (value) => {
            error += value;
          },
        },
      }),
    ).toBe(1);
    expect(error).toContain("service runs at the joined home");
    await settings.update((current) => ({
      ...current,
      machineAccess: { ...current.machineAccess, [credential.lease.machineId]: "portal" },
    }));
    await expect(runSeatCommand(["--new"], cli)).rejects.toThrow("join_channel_unavailable");
    await joins.remove(credential.lease.machineId);
    await expect(runSeatCommand(["--new"], cli)).rejects.toThrow("revoked");
  } finally {
    await seats.close();
    await captain.close();
    await mcp.close();
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
