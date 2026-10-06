import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { DiscordVoiceTranscriptStore } from "@clankie/discord-presence-core";
import { createBearerAuthenticator, createClankieApp, type ClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { runtimeUpdateTools } from "../src/captain/update-tools.ts";
import type { TurnContext } from "../src/captain/tools.ts";
import { captureDiscordBodyIdentity } from "../src/captain/body-identity.ts";
import type { RuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
const roots: string[] = [],
  apps: ClankieApp[] = [];
afterEach(() => {
  apps.splice(0).forEach((app) => app.close());
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const status = {
  runtime: {
    root: "/fixture/pinned",
    commit: "a".repeat(40),
    instanceId: "11111111-1111-1111-1111-111111111111",
    pid: 1234,
  },
};
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "clankie-update-api-"));
  roots.push(root);
  let granted = true,
    accepted = 0;
  let prepare = async () => {};
  const updater: RuntimeUpdater = {
    runtime: status.runtime,
    status: () => status,
    request: async (_ref, source) => {
      await prepare();
      await source.guard();
      if (!source.current()) throw Error("revoked");
      accepted++;
      return { ...status, accepted: true };
    },
  };
  const base = createBearerAuthenticator("fixture-operator", {
    operatorId: "operator",
    steerSourceLane: "tui" as const,
  });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    runtimeUpdater: updater,
    settings: new SettingsStore(join(root, "settings.json")),
    voiceTranscriptStore: new DiscordVoiceTranscriptStore(join(root, "voice.jsonl")),
    authenticateOperator: (request) => (granted ? base(request) : Promise.resolve(undefined)),
  });
  apps.push(service);
  return {
    app: service.app,
    updater,
    accepted: () => accepted,
    revoke: () => {
      granted = false;
    },
    prepare: (fn: () => Promise<void>) => {
      prepare = fn;
    },
  };
}
it("actual API accepts only operator identity, never captain/lane/header claims", async () => {
  const f = await fixture();
  for (const token of [undefined, "social", "captain"]) {
    const response = await f.app.request("/v1/runtime-update", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clankie-lane": "operator",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: "{}",
    });
    expect(response.status).toBe(403);
  }
  expect(f.accepted()).toBe(0);
  const accepted = await f.app.request("/v1/runtime-update", {
    method: "POST",
    headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
    body: "{}",
  });
  expect(accepted.status).toBe(202);
  expect(f.accepted()).toBe(1);
  expect(
    await (
      await f.app.request("/v1/runtime-update", { headers: { authorization: "Bearer fixture-operator" } })
    ).json(),
  ).toEqual(status);
});
it("API revocation during asynchronous preparation rejects before acceptance", async () => {
  const f = await fixture();
  f.prepare(async () => {
    await Promise.resolve();
    f.revoke();
  });
  const response = await f.app.request("/v1/runtime-update", {
    method: "POST",
    headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(403);
  expect(f.accepted()).toBe(0);
});
it("API refuses arbitrary paths or source claims in its body", async () => {
  const f = await fixture();
  const response = await f.app.request("/v1/runtime-update", {
    method: "POST",
    headers: { authorization: "Bearer fixture-operator", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", runtime: "/owner", actorId: "operator" }),
  });
  expect(response.status).toBe(400);
  expect(f.accepted()).toBe(0);
});
it("social tool bank remains absent even after a later promotion", async () => {
  const f = await fixture();
  const turn: TurnContext = { shell: false };
  const tools = runtimeUpdateTools(f.updater, turn);
  turn.shell = true;
  expect(tools).toEqual([]);
});
it("machine tool rejects a later downgrade at call time", async () => {
  const f = await fixture();
  const turn: TurnContext = { shell: true };
  const tools = runtimeUpdateTools(f.updater, turn);
  turn.shell = false;
  await expect(tools[0]!.execute("fixture", {}, undefined, undefined, {} as never)).rejects.toThrow(
    "Machine tools",
  );
  expect(f.accepted()).toBe(0);
});
it("actual Discord machine source rechecks grant and immutable turn identity after prep", async () => {
  const f = await fixture();
  let granted = true;
  const turn: TurnContext = { shell: true };
  const origin = {
    baseSessionKey: "room",
    targetId: "guild:channel",
    actorId: "person",
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    transportKind: "bot" as const,
  };
  const identity = captureDiscordBodyIdentity(turn, "conversation", origin, async () => ({
    systemActorUserIds: granted ? ["person"] : [],
    systemActorGuildIds: [],
    systemActorChannelIds: [],
  }));
  turn.bodyIdentity = identity;
  turn.conversationAuthority = {
    owner: { conversationId: "conversation", discord: origin },
    current: identity.current,
    authorize: () => identity.authorize("discord_mouth", "effect"),
  };
  f.prepare(async () => {
    granted = false;
  });
  const tool = runtimeUpdateTools(f.updater, turn)[0]!;
  await expect(tool.execute("fixture", {}, undefined, undefined, {} as never)).rejects.toThrow("authority");
  expect(f.accepted()).toBe(0);
});
