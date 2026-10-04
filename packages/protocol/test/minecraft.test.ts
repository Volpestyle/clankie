import { describe, expect, it } from "vitest";
import {
  MinecraftActionRequestSchema,
  MinecraftActionStatusSchema,
  MinecraftEffectEvidenceSchema,
  MinecraftJoinRequestSchema,
  MinecraftObservationSchema,
  MinecraftServerProfileSchema,
  MinecraftSessionStatusSchema,
  MinecraftStatusSchema,
} from "../src/index.ts";

const session = { sessionId: "play-1", connectionGeneration: 1 };
const position = { x: 1, y: 64, z: 2 };
const check = { type: "block", position, expected: "minecraft:air", observed: "minecraft:air" };

describe("Minecraft external-body contract", () => {
  it("accepts owner profile references and rejects endpoint/account-shaped escape fields", () => {
    expect(MinecraftServerProfileSchema.parse({ id: "friends-lan", name: "Friends" }).id).toBe("friends-lan");
    for (const extra of [{ host: "example.org" }, { auth: "microsoft" }, { accessToken: "secret" }]) {
      expect(
        MinecraftServerProfileSchema.safeParse({ id: "friends-lan", name: "Friends", ...extra }).success,
      ).toBe(false);
      expect(
        MinecraftJoinRequestSchema.safeParse({ profileId: "friends-lan", session, ...extra }).success,
      ).toBe(false);
    }
    expect(MinecraftJoinRequestSchema.safeParse({ profileId: "https://example.org", session }).success).toBe(
      false,
    );
  });

  it("requires a complete connection identity and bounded typed actions", () => {
    const request = { session, actionId: "dig-1", action: { type: "dig", position } };
    expect(MinecraftActionRequestSchema.safeParse(request).success).toBe(true);
    for (const invalidSession of [
      { sessionId: "play-1" },
      { ...session, connectionGeneration: 0 },
      { ...session, connectionGeneration: 1.5 },
    ]) {
      expect(MinecraftActionRequestSchema.safeParse({ ...request, session: invalidSession }).success).toBe(
        false,
      );
    }
    expect(
      MinecraftActionRequestSchema.safeParse({
        ...request,
        action: { type: "dig", position: { ...position, x: 1.5 } },
      }).success,
    ).toBe(false);
    expect(
      MinecraftActionRequestSchema.safeParse({
        ...request,
        action: { type: "goto", position: { ...position, x: Infinity }, tolerance: 1 },
      }).success,
    ).toBe(false);
    expect(
      MinecraftActionRequestSchema.safeParse({
        ...request,
        action: { type: "build", placements: Array(65).fill({ position, item: "stone" }) },
      }).success,
    ).toBe(false);
  });

  it("never lets pending/uncertain termination masquerade as confirmed disconnect", () => {
    const status = { session, profileId: "friends-lan" };
    expect(
      MinecraftSessionStatusSchema.safeParse({
        ...status,
        phase: "stopping",
        termination: { state: "pending", requestedAt: 100 },
      }).success,
    ).toBe(true);
    expect(
      MinecraftSessionStatusSchema.safeParse({
        ...status,
        phase: "uncertain",
        termination: { state: "uncertain", requestedAt: 100, code: "timeout" },
      }).success,
    ).toBe(true);
    expect(
      MinecraftSessionStatusSchema.safeParse({
        ...status,
        phase: "disconnected",
        termination: { state: "uncertain", requestedAt: 100, code: "timeout" },
      }).success,
    ).toBe(false);
    expect(
      MinecraftSessionStatusSchema.safeParse({
        ...status,
        phase: "disconnected",
        termination: { state: "confirmed", confirmedAt: 101, source: "connection_end" },
      }).success,
    ).toBe(true);
  });

  it("keeps optimistic/local observations usable without admitting them as verified effects", () => {
    expect(
      MinecraftObservationSchema.safeParse({
        session,
        observedAt: 101,
        facts: [{ source: "bot_cache", observedAt: 101, fact: { type: "block", position, block: "air" } }],
      }).success,
    ).toBe(true);
    for (const source of ["bot_cache", "adapter_report"]) {
      expect(
        MinecraftEffectEvidenceSchema.safeParse({
          outcome: "verified",
          source,
          observedAt: 101,
          checks: [check],
        }).success,
      ).toBe(false);
    }
    expect(
      MinecraftEffectEvidenceSchema.safeParse({
        outcome: "unknown",
        reason: "optimistic_cache",
        checks: [check],
      }).success,
    ).toBe(false);
  });

  it("refutes a protected dig or failed placement instead of treating a different block state as success", () => {
    const blocked = { ...check, observed: "minecraft:stone" };
    const evidence = { source: "server_observer", observedAt: 101, checks: [blocked] };
    expect(MinecraftEffectEvidenceSchema.safeParse({ ...evidence, outcome: "verified" }).success).toBe(false);
    expect(MinecraftEffectEvidenceSchema.safeParse({ ...evidence, outcome: "refuted" }).success).toBe(true);
    expect(
      MinecraftEffectEvidenceSchema.safeParse({ ...evidence, checks: [check], outcome: "refuted" }).success,
    ).toBe(false);
  });

  it("allows a completed adapter call with unknown effects and requires fresh evidence for verification", () => {
    const status = {
      session,
      actionId: "dig-1",
      requested: { type: "dig", position },
      state: "completed",
      requestedAt: 100,
      updatedAt: 102,
      evidence: { outcome: "unknown", reason: "local_report_only" },
    };
    expect(MinecraftActionStatusSchema.safeParse(status).success).toBe(true);
    for (const observedAt of [99, 103]) {
      expect(
        MinecraftActionStatusSchema.safeParse({
          ...status,
          evidence: { outcome: "verified", source: "server_packet", observedAt, checks: [check] },
        }).success,
      ).toBe(false);
    }
    expect(
      MinecraftActionStatusSchema.safeParse({
        ...status,
        evidence: { outcome: "verified", source: "server_packet", observedAt: 101, checks: [check] },
      }).success,
    ).toBe(true);
    expect(MinecraftActionStatusSchema.safeParse({ ...status, updatedAt: 99 }).success).toBe(false);
    expect(
      MinecraftActionStatusSchema.safeParse({
        ...status,
        evidence: { outcome: "unknown", reason: "stale_observation" },
      }).success,
    ).toBe(true);
    const current = {
      session,
      profileId: "friends-lan",
      phase: "active",
      termination: { state: "not_requested" },
    };
    expect(
      MinecraftStatusSchema.safeParse({
        session: current,
        actions: [{ ...status, session: { ...session, connectionGeneration: 2 } }],
      }).success,
    ).toBe(false);
    expect(MinecraftStatusSchema.safeParse({ session: null, actions: [status] }).success).toBe(false);
  });
});
