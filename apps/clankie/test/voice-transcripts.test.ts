import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { DiscordVoiceTranscriptStore } from "@clankie/discord-presence-core";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

it("keeps retained voice transcripts captain-authenticated and unreadable while logging is disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-voice-transcript-api-"));
  roots.push(root);
  const store = new DiscordVoiceTranscriptStore(join(root, "transcripts.jsonl"));
  await store.append("bot", {
    occurredAt: "2026-08-18T04:24:21.550Z",
    guildId: "866430493889134672",
    channelId: "866430493889134676",
    deliveryId: "delivery-1",
    speakerId: "830574404453793842",
    displayName: "James",
    text: "private exact line",
  });
  await store.append("bot", {
    occurredAt: "2026-08-18T04:24:22.550Z",
    guildId: "866430493889134672",
    channelId: "866430493889134676",
    deliveryId: "delivery-1",
    role: "assistant",
    speakerId: "clankie",
    displayName: "Clankie",
    itemId: "answer",
    text: "private generated reply",
    textSource: "tts_text",
    textComplete: true,
    outcome: "played",
    audioStarted: true,
    playbackMs: 700,
  });
  let enabled = false;
  const settings = () =>
    ClankieSettingsSchema.parse({ schemaVersion: 1, discord: { voiceTranscriptLoggingEnabled: enabled } });
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    voiceTranscriptStore: store,
    settings: { load: async () => settings() },
    authenticateCaptain: createBearerAuthenticator("captain-token", {
      captainId: "test",
      steerSourceLane: "api",
    }),
  });

  const unauthorized = await app.request("/v1/discord/voice-transcripts");
  expect(unauthorized.status).toBe(401);

  const headers = { authorization: "Bearer captain-token" };
  const disabled = await app.request("/v1/discord/voice-transcripts", { headers });
  expect(await disabled.json()).toMatchObject({ enabled: false, entries: [] });

  enabled = true;
  const visible = await app.request("/v1/discord/voice-transcripts", { headers });
  expect(await visible.json()).toMatchObject({
    enabled: true,
    entries: [
      { displayName: "James", text: "private exact line" },
      { role: "assistant", text: "private generated reply", outcome: "played" },
    ],
  });
});
