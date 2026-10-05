import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createClankieApp } from "../src/app.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { captainTools } from "../src/captain/tools.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneLog } from "../src/captain/lane-log.ts";
import { runLinearCommand } from "../../tui/src/command/linear.ts";

it("shares durable wake settings between Clankie's tool, CLI and HTTP with ordinary chat validation", async () => {
  const root = await mkdtemp(join(tmpdir(), "linear-settings-integration-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {});
  const created = await conversations.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "global" },
    title: "Linear",
  });
  if (created.op !== "create") throw new Error("No chat created");
  const id = created.conversation.conversationId;
  const env = { CLANKIE_OPERATOR_TOKEN: "integration-operator" };
  const service = await createClankieApp({
    settings,
    captain: createStubCaptain({
      linearWakeTargetAllowed: (conversationId) => conversations.linearWakeTargetAllowed(conversationId),
    }),
    authenticateOperator: createCredentialBackedOperatorAuthenticator({
      env,
      store: new FileCredentialStore(join(root, "credentials.json")),
      identity: { operatorId: "integration" },
    }),
  });
  const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const options = {
    settings,
    credentials: new FileCredentialStore(join(root, "credentials.json")),
    env: { ...env, CLANKIE_CONTROL_PLANE_URL: baseUrl },
  };
  const unused = (): never => {
    throw new Error("Unrelated tool dependency called");
  };
  const deps: CaptainDeps = {
    linearWake: {
      settings,
      targetAllowed: (conversationId) => conversations.linearWakeTargetAllowed(conversationId),
    },
    mcp: { catalog: async () => [], call: unused },
    email: { list: unused, read: unused, search: unused, send: unused },
    browser: { catalog: unused, call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    activity: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused, listRecentVoiceSpeech: unused },
    memory: { appendEpisode: unused, recallEpisodeCard: unused, searchEpisodeCard: unused },
  };
  const offered = captainTools(deps, {}, {} as LaneLog, "operator");
  const tool = offered.find((entry) => entry.name === "linear_wake")!;
  const execute = (input: Record<string, unknown>) =>
    tool.execute("settings-integration", input as never, undefined, undefined, {} as never);
  try {
    expect(
      captainTools(deps, {}, {} as LaneLog, "discord_presence").some((entry) => entry.name === "linear_wake"),
    ).toBe(false);
    // A trusted guild admits non-owner humans to shell tools, not owner settings.
    expect(
      captainTools(
        deps,
        { shell: true, actorId: "non-owner-member", guildId: "trusted-guild" },
        {} as LaneLog,
        "discord_presence",
      ).some((entry) => entry.name === "linear_wake"),
    ).toBe(false);
    await execute({
      action: "set",
      wake: { ownerUserEmails: ["volpestyle@gmail.com"], notificationTypes: ["issueNewComment"] },
    });
    expect(await runLinearCommand(["wake", "show"], options)).toMatchObject({
      wake: { notificationTypes: ["issueNewComment"] },
    });
    await runLinearCommand(
      ["wake", "set", "--owner-user-emails", "volpestyle@gmail.com,second@example.test"],
      options,
    );
    const headers = {
      authorization: `Bearer ${env.CLANKIE_OPERATOR_TOKEN}`,
      "content-type": "application/json",
    };
    expect(await (await fetch(`${baseUrl}/v1/linear/wake`, { headers })).json()).toMatchObject({
      wake: { ownerUserEmails: ["volpestyle@gmail.com", "second@example.test"] },
    });
    expect(await runLinearCommand(["target", "set", id], options)).toMatchObject({ wakeConversationId: id });
    expect(await execute({ action: "show" })).toMatchObject({ details: { wakeConversationId: id } });
    expect((await new SettingsStore(settings.path).load()).linearWebhook.wakeConversationId).toBe(id);
    await expect(execute({ action: "set", conversationId: "missing-chat" })).rejects.toThrow(
      "ordinary global chat",
    );
    await expect(runLinearCommand(["target", "set", "missing-chat"], options)).rejects.toThrow("failed: 409");
    for (const args of [
      ["inbox", "read"],
      ["inbox", "ack", "000000000001"],
      ["work", "list"],
    ])
      await expect(runLinearCommand(args, options)).rejects.toThrow("Usage:");
    expect((await fetch(`${baseUrl}/v1/linear/target`)).status).toBe(401);
    await runLinearCommand(["webhook", "clear"], { ...options, credentials: { get: async () => undefined } });
    expect((await settings.load()).linearWebhook.wakeConversationId).toBe(id);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    service.close();
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});
