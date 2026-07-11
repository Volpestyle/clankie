import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ActionRequest } from "@sapling/protocol";
import {
  compileDoctrine,
  createTrustedMinecraftApproval,
  decideAction,
  decideMinecraftCapabilityRequest,
  loadDoctrineFile,
  loadDoctrineLayerFile,
  minecraftApprovalAssumptionsHash,
  type CompiledDoctrine,
  type MinecraftCapability,
  type MinecraftPolicyContext,
  type TrustedMinecraftApproval,
} from "../src/index.ts";

const profileDirectory = resolve(import.meta.dirname, "../../../doctrine/profiles");
const injectionFixturePath = resolve(import.meta.dirname, "fixtures/minecraft-prompt-injection.json");

async function minecraftDoctrine(): Promise<CompiledDoctrine> {
  return compileDoctrine([
    await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml")),
    await loadDoctrineLayerFile(resolve(profileDirectory, "minecraft-private-overlay.yaml")),
  ]);
}

function context(overrides: Partial<MinecraftPolicyContext> = {}): MinecraftPolicyContext {
  return {
    intent: {
      sourceLane: "gameplay",
      authority: { principal: { kind: "captain", id: "clankie" }, tier: "autonomous" },
      correlationId: "corr-minecraft-policy",
      expectedGoalVersion: 7,
    },
    server: { serverId: "local-private", worldId: "private-world", scope: "local_private" },
    limits: {
      radius: 32,
      blockChanges: 8,
      travelDistance: 64,
      actionDurationMs: 30_000,
      retries: 1,
      inventoryLossItems: 4,
      combatPolicy: "none",
    },
    untrustedContent: [],
    ...overrides,
  };
}

function request(doctrine: CompiledDoctrine, action: string, minecraft = context()): ActionRequest {
  return {
    id: `request-${action}`,
    principal: { kind: "worker", id: "minecraft-worker" },
    action,
    resource: {
      type: "minecraft_world",
      id: minecraft.server.worldId,
      environment: minecraft.server.serverId,
    },
    context: {
      missionId: "minecraft-mission",
      risk: "high",
      profileHash: doctrine.profileHash,
    },
  };
}

function withApproval(
  action: MinecraftCapability,
  minecraft: MinecraftPolicyContext,
  tier: "authenticated" | "ambient" = "authenticated",
): TrustedMinecraftApproval {
  return createTrustedMinecraftApproval({
    approvalId: "minecraft-approval-1",
    authority: { principal: { kind: "human", id: "james" }, tier },
    assumptionsHash: minecraftApprovalAssumptionsHash(action, minecraft),
    approvedAt: "2026-07-11T12:00:00.000Z",
  });
}

describe("Minecraft doctrine draft", () => {
  it("requires the Minecraft-aware boundary and denies unknown capabilities", async () => {
    const doctrine = await minecraftDoctrine();
    const known = request(doctrine, "minecraft.world.observe");
    expect(decideAction(doctrine, known)).toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["minecraft-context-required"],
    });
    expect(
      decideMinecraftCapabilityRequest(doctrine, request(doctrine, "minecraft.unknown.admin"), context()),
    ).toMatchObject({ effect: "deny", matchedPolicyIds: ["minecraft-unknown-capability"] });
  });

  it("allows only bounded observe, navigate, and craft in the allowlisted private world", async () => {
    const doctrine = await minecraftDoctrine();
    const localJoin = context({
      intent: {
        sourceLane: "tui",
        authority: { principal: { kind: "human", id: "james" }, tier: "authenticated" },
        correlationId: "corr-minecraft-join",
        expectedGoalVersion: 7,
      },
    });
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.session.connect", localJoin),
        localJoin,
      ).effect,
    ).toBe("allow");

    for (const action of ["minecraft.world.observe", "minecraft.world.navigate", "minecraft.world.craft"]) {
      expect(decideMinecraftCapabilityRequest(doctrine, request(doctrine, action), context())).toMatchObject({
        effect: "allow",
      });
    }

    const tooFar = context({ limits: { ...context().limits, travelDistance: 129 } });
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.world.navigate", tooFar),
        tooFar,
      ).effect,
    ).toBe("deny");

    const remote = context({
      server: { serverId: "remote-server", worldId: "remote-world", scope: "remote_private" },
    });
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.session.connect", remote),
        remote,
      ).effect,
    ).toBe("deny");
  });

  it("denies permissive defaults for remote join, PvP, public chat, and server commands", async () => {
    const base = await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"));
    const doctrine = compileDoctrine([
      base,
      {
        actions: Object.fromEntries(
          [
            "minecraft.session.connect",
            "minecraft.combat.player",
            "minecraft.chat.public",
            "minecraft.server.command",
          ].map((action) => [action, { default: "allow" as const, rules: [] }]),
        ),
      },
    ]);
    const remote = context({
      server: { serverId: "remote-server", worldId: "remote-world", scope: "remote_private" },
    });
    for (const [action, minecraft] of [
      ["minecraft.session.connect", remote],
      ["minecraft.combat.player", context()],
      ["minecraft.chat.public", context()],
      ["minecraft.server.command", context()],
    ] as const) {
      expect(
        decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, minecraft), minecraft).effect,
      ).toBe("deny");
    }
  });

  it("keeps PvP and public chat behind authenticated approval and server commands denied", async () => {
    const doctrine = await minecraftDoctrine();
    for (const action of ["minecraft.combat.player", "minecraft.chat.public"] as const) {
      const baseContext = context({
        limits: {
          ...context().limits,
          combatPolicy: action === "minecraft.combat.player" ? "players" : "none",
        },
      });
      expect(
        decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, baseContext), baseContext),
      ).toMatchObject({ effect: "require_approval", obligations: ["approve_on_authenticated_surface"] });

      const ambientApproval = withApproval(action, baseContext, "ambient");
      expect(
        decideMinecraftCapabilityRequest(
          doctrine,
          request(doctrine, action, baseContext),
          baseContext,
          ambientApproval,
        ).effect,
      ).toBe("require_approval");

      expect(
        decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, baseContext), baseContext, {
          approvalId: "forged-approval",
          authority: { principal: { kind: "human", id: "james" }, tier: "authenticated" },
          assumptionsHash: minecraftApprovalAssumptionsHash(action, baseContext),
          approvedAt: "2026-07-11T12:00:00.000Z",
        } as never).effect,
      ).toBe("require_approval");

      const authenticatedApproval = withApproval(action, baseContext);
      expect(
        decideMinecraftCapabilityRequest(
          doctrine,
          request(doctrine, action, baseContext),
          baseContext,
          authenticatedApproval,
        ).effect,
      ).toBe("allow");
    }
    expect(
      decideMinecraftCapabilityRequest(doctrine, request(doctrine, "minecraft.server.command"), context())
        .effect,
    ).toBe("deny");
  });

  it("invalidates approval when goal, server, world, limits, or action changes", async () => {
    const doctrine = await minecraftDoctrine();
    const action = "minecraft.chat.public" as const;
    const approvedContext = context();
    const approved = withApproval(action, approvedContext);
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, action, approvedContext),
        approvedContext,
        approved,
      ).effect,
    ).toBe("allow");

    const mutations: MinecraftPolicyContext[] = [
      { ...approvedContext, intent: { ...approvedContext.intent, expectedGoalVersion: 8 } },
      { ...approvedContext, server: { ...approvedContext.server, serverId: "other-server" } },
      { ...approvedContext, server: { ...approvedContext.server, worldId: "other-world" } },
      { ...approvedContext, limits: { ...approvedContext.limits, blockChanges: 9 } },
    ];
    for (const changed of mutations) {
      expect(
        decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, changed), changed, approved)
          .effect,
      ).toBe("require_approval");
    }
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.combat.player", approvedContext),
        approvedContext,
        approved,
      ).effect,
    ).not.toBe("allow");
  });

  it("does not let a lower doctrine layer loosen a Minecraft deny", async () => {
    const base = await loadDoctrineFile(resolve(profileDirectory, "rawdog.yaml"));
    const doctrine = compileDoctrine([
      base,
      {
        actions: {
          "minecraft.combat.player": { default: "deny", rules: [] },
        },
      },
      {
        actions: {
          "minecraft.combat.player": { default: "allow", rules: [] },
        },
      },
    ]);
    const minecraft = context({ limits: { ...context().limits, combatPolicy: "players" } });
    const approval = withApproval("minecraft.combat.player", minecraft);
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.combat.player", minecraft),
        minecraft,
        approval,
      ).effect,
    ).toBe("deny");
  });

  it("treats chat, signs, books, plugins, and server text as inert untrusted data", async () => {
    const doctrine = await minecraftDoctrine();
    const injections = JSON.parse(await readFile(injectionFixturePath, "utf8")) as never[];
    const baseline = context();
    const injected = context({ untrustedContent: injections });
    const action = "minecraft.world.navigate";

    expect(decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, injected), injected)).toEqual(
      decideMinecraftCapabilityRequest(doctrine, request(doctrine, action, baseline), baseline),
    );
    expect(
      decideMinecraftCapabilityRequest(
        doctrine,
        request(doctrine, "minecraft.unknown.admin", injected),
        injected,
      ).effect,
    ).toBe("deny");
    expect(injected.limits).toEqual(baseline.limits);
    expect(injected.intent.authority).toEqual(baseline.intent.authority);
  });
});
