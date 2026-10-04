import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";
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
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function fixture(local = false, adapter?: HarnessSeatAdapter) {
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
      seatAdapters: adapter ? [adapter] : [],
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

it("retains the original room authority and refuses a native author reply after that actor's grant is revoked", async () => {
  const { captain, principal, proof, settings, agent } = fixture();
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
  expect(
    await captain.deliverLinearNativeRecipient(source.recipient, "approval", "room-reply", async () => {}),
  ).toMatchObject({ outcome: "undelivered" });
  expect(await captain.pollFleetSeatEvents(agent.paneId, 0)).toEqual([]);
});

it("delivers a remote author's reply once through its existing native mailbox and keeps its original route across restart", async () => {
  const { captain, principal, proof, agent, create, root } = fixture();
  const source = (await captain.fleetWriteAuthority(principal, async () => proof))!.nativeRecipientAuthority!;
  const guard = vi.fn(async () => {});
  const polling = captain.pollFleetSeatEvents(agent.paneId, 5000);
  const delivery = captain.deliverLinearNativeRecipient(
    source.recipient,
    "James: I APPROVE all!!",
    "signed-reply",
    guard,
  );
  const [event] = (await polling)!;
  expect(event).toMatchObject({
    source: "linear",
    conversationId: "kh2/term-author",
    content: "Linear event signed-reply\nJames: I APPROVE all!!",
  });
  await captain.acknowledgeFleetSeatEvent(agent.paneId, event!.id);
  expect(await delivery).toMatchObject({ outcome: "delivered" });
  expect(
    await captain.deliverLinearNativeRecipient(
      source.recipient,
      "James: I APPROVE all!!",
      "signed-reply",
      guard,
    ),
  ).toMatchObject({ outcome: "delivered" });
  expect(await captain.pollFleetSeatEvents(agent.paneId, 0)).toEqual([]);
  await captain.close();
  const restarted = create();
  fixtures.find((entry) => entry.root === root)!.captain = restarted;
  expect(
    await restarted.deliverLinearNativeRecipient(
      source.recipient,
      "James: I APPROVE all!!",
      "signed-reply",
      guard,
    ),
  ).toMatchObject({ outcome: "delivered" });
  expect(
    await restarted.deliverLinearNativeRecipient(source.recipient, "changed content", "signed-reply", guard),
  ).toMatchObject({ outcome: "undelivered" });
  expect(await restarted.pollFleetSeatEvents(agent.paneId, 0)).toEqual([]);
});

it("checks the original author after adapter attachment and refuses replacement before sending", async () => {
  const attaching = gate();
  const attached = gate();
  const send = vi
    .fn<SeatControl["send"]>()
    .mockResolvedValue({ outcome: "accepted", messageId: "native", state: "started" });
  const control: SeatControl = {
    ref: { harness: "claude", paneId: "w3:pK", sessionId: "original-session" },
    send,
    status: async () => "idle",
    settled: async () => ({ type: "released", at: new Date().toISOString() }),
    interrupt: async () => false,
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: "claude",
    start: async () => ({ outcome: "started", control }),
    attach: async () => {
      attaching.release();
      await attached.promise;
      return control;
    },
  };
  const { captain, principal, proof, replace } = fixture(true, adapter);
  const source = (await captain.fleetWriteAuthority(principal, async () => proof))!.nativeRecipientAuthority!;
  const pending = captain.deliverLinearNativeRecipient(source.recipient, "approval", "reply", async () => {});
  await attaching.promise;
  replace();
  attached.release();
  expect(await pending).toMatchObject({ outcome: "undelivered", deliveryStage: "unavailable" });
  expect(send).not.toHaveBeenCalled();
  expect(await source.authorize()).toBe(false);
});

it("keeps a lost native acknowledgment uncertain across restart and never retries through another channel", async () => {
  const send = vi.fn<SeatControl["send"]>().mockRejectedValue(new Error("lost native acknowledgement"));
  const control: SeatControl = {
    ref: { harness: "claude", paneId: "w3:pK", sessionId: "original-session" },
    send,
    status: async () => "idle",
    settled: async () => ({ type: "released", at: new Date().toISOString() }),
    interrupt: async () => false,
    close: async () => {},
  };
  const adapter: HarnessSeatAdapter = {
    harness: "claude",
    attach: async () => control,
    start: async () => ({ outcome: "started", control }),
  };
  const { captain, principal, proof, create, root } = fixture(true, adapter);
  const source = (await captain.fleetWriteAuthority(principal, async () => proof))!.nativeRecipientAuthority!;
  expect(
    await captain.deliverLinearNativeRecipient(source.recipient, "approval", "reply", async () => {}),
  ).toMatchObject({ outcome: "unconfirmed", deliveryStage: "uncertain" });
  await captain.close();
  const restarted = create();
  fixtures.find((entry) => entry.root === root)!.captain = restarted;
  expect(
    await restarted.deliverLinearNativeRecipient(source.recipient, "approval", "reply", async () => {}),
  ).toMatchObject({ outcome: "unconfirmed", deliveryStage: "uncertain" });
  expect(send).toHaveBeenCalledTimes(1);
});
