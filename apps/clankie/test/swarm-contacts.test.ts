import { localEndpoint } from "swarm-mcp/runtime";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SwarmHost } from "@clankie/swarm";
import { SettingsStore } from "@clankie/settings";
import {
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createClankieApp } from "../src/app.ts";

it("discovers and messages a Swarm persona through the public API without a Herdr seat or captain model", async () => {
  const root = await mkdtemp("/tmp/clankie-contact-");
  const swarmDir = join(root, "swarm");
  const settings = new SettingsStore(join(root, "settings.json"));
  const open = async () => {
    const swarm = new SwarmHost({
      stateDirectory: swarmDir,
      canDispatch: () => false,
      warn: () => undefined,
    });
    const captain = createCaptain({ herdrAvailable: () => false } as unknown as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      settings,
      swarm,
      workingDirectory: root,
    });
    const app = await createClankieApp({
      captain,
      authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
    });
    const client = createOperatorConversationServiceClient(async (request) => {
      const response = await app.app.request("/operator/v1/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      return OperatorConversationServiceResultSchema.parse(await response.json());
    });
    const caller = async (conversationId: string) => {
      const tools = await swarm.tools({ conversationId, cwd: root });
      return async (name: string, args: Record<string, unknown>) => {
        const result = await tools
          .find((tool) => tool.name === name)!
          .execute("test", args, undefined, undefined, {} as never);
        return JSON.parse((result.content[0] as { text: string }).text).data;
      };
    };
    return {
      swarm,
      captain,
      client,
      caller,
      close: async () => {
        app.close();
        await captain.close();
      },
    };
  };
  let service = await open();
  try {
    const lead = await service.caller("global-default");
    let worker = await service.caller("worker");
    const leader = await lead("swarm_sync", {});
    const peer = await worker("swarm_sync", {});
    const fleet = await service.client.fleet!();
    expect(fleet.seats).toEqual([]);
    const persona = fleet.personas.find(
      (entry) => entry.swarm?.actor === peer.actor && entry.swarm?.conversationId === "global-default",
    )!;
    expect(persona.swarm?.available).toBe(true);
    expect(persona.activeSeatId).toBeUndefined();
    expect(JSON.stringify(persona)).not.toContain("sock");
    const conversation = await service.client.create({
      scope: { kind: "persona", personaId: persona.personaId },
      title: persona.name,
    });
    const turn = await service.client.send({
      schemaVersion: 1,
      conversationId: conversation.conversationId,
      surfaceClientId: "phone",
      expectedRevision: conversation.revision,
      kind: "message",
      message: "What did you find?",
    });
    expect(turn.status).toBe("accepted");
    let fetchId = 0;
    let delivery:
      | { message: { id: string; threadId: string; recipientGeneration: number }; leaseToken: string }
      | undefined;
    await vi.waitFor(async () => {
      delivery ??= (
        await worker("swarm_inbox", { commandId: `fetch-${++fetchId}`, action: "fetch", consumer: "worker" })
      ).value.deliveries[0];
      expect(delivery?.message.threadId).toBe(conversation.conversationId);
    });
    expect(delivery!.message.recipientGeneration).toBe(persona.swarm!.generation);
    await worker("swarm_inbox", {
      commandId: "ack-question",
      action: "ack",
      messageId: delivery!.message.id,
      leaseToken: delivery!.leaseToken,
    });
    // The captain is unbound. Only the contact's thread may be consumed here.
    const ordinary = await worker("swarm_send", {
      commandId: "ordinary",
      recipient: leader.actor,
      kind: "reply",
      body: "Captain context",
      threadId: "unrelated",
    });
    await worker("swarm_send", {
      commandId: "reply",
      recipient: leader.actor,
      kind: "reply",
      body: "The tests pass.",
      threadId: conversation.conversationId,
    });
    const history = () =>
      service.client.replay({
        schemaVersion: 1,
        conversationId: conversation.conversationId,
        surfaceClientId: "phone",
      });
    await vi.waitFor(async () => expect(JSON.stringify(await history())).toContain("The tests pass."), {
      timeout: 5000,
    });
    const inbox = await lead("swarm_inbox", {
      commandId: "inspect-ordinary",
      action: "fetch",
      consumer: "test",
    });
    expect(inbox.value.deliveries[0].message.id).toBe(ordinary.value.messageId);
    expect(inbox.value.deliveries[0].attempt).toBe(1);
    await lead("swarm_inbox", {
      commandId: "ack-ordinary",
      action: "ack",
      messageId: ordinary.value.messageId,
      leaseToken: inbox.value.deliveries[0].leaseToken,
    });
    await service.close();
    service = await open();
    worker = await service.caller("worker");
    const restored = await service.client.fleet!();
    expect(restored.personas.find((entry) => entry.personaId === persona.personaId)?.swarm?.available).toBe(
      false,
    );
    const replacement = restored.personas.find(
      (entry) =>
        entry.swarm?.actor === peer.actor &&
        entry.swarm?.conversationId === "global-default" &&
        entry.swarm?.available,
    )!;
    expect(replacement.personaId).not.toBe(persona.personaId);
    expect(JSON.stringify(await history())).toContain("The tests pass.");
    const stale = await service.client.send({
      schemaVersion: 1,
      conversationId: conversation.conversationId,
      surfaceClientId: "phone",
      expectedRevision: (await service.client.get(conversation.conversationId))!.revision,
      kind: "message",
      message: "Old contact must not be retargeted",
    });
    expect(stale.status).toBe("accepted");
    await vi.waitFor(async () => expect(JSON.stringify(await history())).toContain("Recipient session"));
    expect(
      (await worker("swarm_inbox", { commandId: "replacement-empty", action: "fetch", consumer: "worker" }))
        .value.deliveries,
    ).toEqual([]);
  } finally {
    await service.close();
    for (const entry of await readdir(swarmDir).catch(() => [])) {
      try {
        const config = JSON.parse(await readFile(join(swarmDir, entry, "owner.json"), "utf8"));
        const pids = execFileSync("lsof", ["-t", "--", localEndpoint(config.databasePath)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim()
          .split(/\s+/u);
        for (const pid of pids) if (/^\d+$/u.test(pid)) process.kill(Number(pid), "SIGTERM");
      } catch {
        /* Not a coordinator directory. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it("keeps received message identity across an interrupted metadata write and restart", async () => {
  const { ConversationStore } = await import("../src/captain/conversations.ts");
  const { writeFile } = await import("node:fs/promises");
  const root = await mkdtemp("/tmp/clankie-contact-replay-");
  try {
    let store = new ConversationStore(root, async () => {
      throw new Error("No captain turn");
    });
    const result = await store.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "persona", personaId: "swarm-peer" },
      title: "Peer",
    });
    if (result.op !== "create") throw new Error("Missing conversation");
    const id = result.conversation.conversationId;
    expect(store.receiveSwarmMessage(id, "another-peer", "message-1", "reply")).toBe(false);
    expect(store.receiveSwarmMessage(id, "swarm-peer", "message-1", "reply")).toBe(true);
    const metaPath = join(root, id, "meta.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8"));
    delete meta.swarmMessages; // Crash after the event append, before the receipt checkpoint.
    await writeFile(metaPath, JSON.stringify(meta));
    store = new ConversationStore(root, async () => {});
    expect(store.receiveSwarmMessage(id, "swarm-peer", "message-1", "reply")).toBe(true);
    const page = await store.serve({
      op: "replay",
      schemaVersion: 1,
      replay: { schemaVersion: 1, conversationId: id, surfaceClientId: "test" },
    });
    expect(JSON.stringify(page).match(/"swarmMessageId":"message-1"/gu)).toHaveLength(1);
    const checkpoint = JSON.parse(await readFile(metaPath, "utf8"));
    expect(checkpoint.swarmMessages).toEqual(["message-1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
