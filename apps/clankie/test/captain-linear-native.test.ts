import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { HerdrWatchStore, type HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { AutonomyStore } from "../src/captain/autonomy.ts";
import * as fleetRunner from "../src/captain/herdr-fleet-runner.ts";

vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({ runtime: {} }),
}));
const fixtures: { captain: ReturnType<typeof createCaptain>; root: string }[] = [];
afterEach(async () => {
  for (const { captain, root } of fixtures.splice(0)) {
    await captain.close();
    rmSync(root, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
function fixture(local = false) {
  const root = mkdtempSync(join(tmpdir(), "captain-linear-native-"));
  let agent: HerdrAgentSnapshot = {
    paneId: local ? "w3:pK" : "kh2/w3:pK",
    terminalId: local ? "term-author" : "kh2/term-author",
    agent: "claude",
    status: "idle",
    title: "Native author",
    session: { source: "herdr:claude", kind: "id", value: "original-session" },
  };
  const get = async () => agent;
  vi.spyOn(fleetRunner, "routeHerdrFleets").mockReturnValue({ get, wait: get, resolveTerminal: get });
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(AutonomyStore.prototype, "start").mockImplementation(() => {});
  const create = () =>
    createCaptain({ memory: {} } as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      discordEnvironment: {},
      personaImages: async () => ({ images: [], hash: "fake", files: [] }),
    });
  const captain = create();
  const settings = new SettingsStore(join(root, "settings.json"));
  fixtures.push({ captain, root });
  const proof: ProjectProcessProof = {
    fleet: local ? "default" : "kh2",
    pane: "w3:pK",
    nativeOccupantId: occupantIdForHerdrSession(agent.session!),
    binding: { socketPath: "verified-herdr" },
    processes: [{ pid: 42, startTime: "native-start" }],
    shell: { pid: 40, startTime: "shell-start" },
  };
  return {
    captain,
    agent,
    proof,
    create,
    root,
    settings,
    principal: `fleet:${proof.fleet}:pane:w3:pK`,
    replace: () => {
      agent = { ...agent, session: { ...agent.session!, value: "replacement-session" } };
    },
  };
}

it("captures an unadopted remote native author without inventing a local conversation", async () => {
  const { captain, principal, proof, agent } = fixture();
  const authority = await captain.fleetWriteAuthority(principal, async () => proof);
  expect(authority?.conversationAuthority).toBeUndefined();
  expect(authority?.nativeRecipientAuthority?.recipient).toMatchObject({
    kind: "native",
    paneId: "kh2/w3:pK",
    seatId: "kh2/term-author",
    occupantId: occupantIdForHerdrSession(agent.session!),
    binding: expect.stringMatching(/^[a-f0-9]{64}$/u),
  });
  expect(authority?.nativeRecipientAuthority?.recipient.owner).toBeUndefined();
});

it("refuses author attribution for unverified principals, absent kernel proof, and mismatched native proof", async () => {
  const { captain, principal, proof } = fixture();
  expect(await captain.fleetWriteAuthority(principal)).toBeUndefined();
  expect(await captain.fleetWriteAuthority("fleet:kh2:pane:unverified", async () => proof)).toBeUndefined();
  for (const change of [
    { fleet: "pc" },
    { pane: "w3:pOther" },
    { nativeOccupantId: "replacement" },
    { nativeSessionPending: true as const },
  ])
    expect(
      await captain.fleetWriteAuthority(principal, async () => ({ ...proof, ...change })),
    ).toBeUndefined();
});

it("retains original room attribution authority and refuses it after the actor's grant is revoked", async () => {
  const { captain, principal, proof, settings } = fixture();
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, systemActorUserIds: ["11111"] },
  }));
  const conversationId = captain.bodyRoomConversation("discord_presence", "12345:67890");
  const owner = {
    conversationId,
    discord: {
      baseSessionKey: "discord:clankie:body:67890",
      targetId: "12345:67890",
      actorId: "11111",
      guildId: "12345",
      channelId: "67890",
      messageId: "original",
      transportKind: "bot" as const,
    },
  };
  vi.spyOn(HerdrWatchStore.prototype, "nativeOwner").mockReturnValue(owner);
  const source = (await captain.fleetWriteAuthority(principal, async () => proof))!.nativeRecipientAuthority!;
  expect(source.recipient.owner).toEqual(owner);
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, systemActorUserIds: [] },
  }));
  expect(await source.authorize()).toBe(false);
});
