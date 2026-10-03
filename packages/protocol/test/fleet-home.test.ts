import { expect, it } from "vitest";
import {
  defaultOperatorAgentAppearance,
  operatorFleetHome,
  OperatorConversationServiceRequestSchema,
  type OperatorFleetSnapshot,
  type OperatorAgentPersona,
} from "../src/index.ts";

const at = "2026-09-28T00:00:00.000Z";
const persona = (personaId: string): OperatorAgentPersona => ({
  schemaVersion: 1,
  personaId,
  name: personaId,
  appearance: defaultOperatorAgentAppearance(personaId),
  harness: "codex",
  createdAt: at,
  updatedAt: at,
});

it("keeps the full contract by default and accepts an additive home projection", () => {
  expect(
    OperatorConversationServiceRequestSchema.parse({ op: "fleet", schemaVersion: 1 }),
  ).not.toHaveProperty("view");
  expect(
    OperatorConversationServiceRequestSchema.parse({ op: "fleet", schemaVersion: 1, view: "home" }),
  ).toHaveProperty("view", "home");
});

it("removes historical personas without losing seated people or room participants", () => {
  const snapshot: OperatorFleetSnapshot = {
    schemaVersion: 1,
    cursor: "fleet:1",
    channels: [],
    seats: [
      {
        seatId: "seat",
        occupantId: "occupant",
        personaId: "live",
        harness: "codex",
        status: "working",
        title: "Work",
      },
    ],
    personas: [persona("live"), ...Array.from({ length: 419 }, (_, n) => persona(`archived-${n}`))],
    tallies: [],
    edges: [],
  };
  const projected = operatorFleetHome(snapshot);
  expect(projected.personas.map((p) => p.personaId)).toEqual(["live"]);
  expect(projected.seats).toBe(snapshot.seats);
  expect(projected.cursor).toBe(snapshot.cursor);
  expect(snapshot.personas).toHaveLength(420);
});
