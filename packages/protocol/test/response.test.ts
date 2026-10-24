import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  OperatorConversationServiceRequestSchema,
  OperatorConversationStreamEventSchema,
  OperatorFleetSeatSchema,
  OperatorFleetSnapshotSchema,
  OperatorSeatSubagentsSchema,
} from "../src/index.ts";
import { additiveEnum, parseProtocolResponse, safeParseProtocolResponse } from "../src/response.ts";

// Freeze the client shape from before VUH-1587/VUH-1607; do not extend it when
// hosts grow more optional fields. This client must keep reading schema v1.
const oldSeat = OperatorFleetSeatSchema.omit({ harnessBridge: true, toolCatalog: true }).extend({
  subagents: OperatorSeatSubagentsSchema.extend({
    recent: z
      .array(z.object({ label: z.string().max(120), status: z.enum(["running", "done"]) }).strict())
      .max(8),
  }).optional(),
});
const oldSnapshot = OperatorFleetSnapshotSchema.extend({ seats: z.array(oldSeat).max(48) });
const oldResult = z.discriminatedUnion("op", [
  z
    .object({ op: z.literal("roster"), schemaVersion: z.literal(1), seats: z.array(oldSeat).max(48) })
    .strict(),
  z.object({ op: z.literal("fleet"), schemaVersion: z.literal(1), snapshot: oldSnapshot }).strict(),
]);
const seat = {
  seatId: "w1:p1",
  occupantId: "fixture-session",
  personaId: "agent-juno",
  harness: "codex",
  status: "busy",
  title: "Juno 🌱",
  subagents: { running: 1, recent: [{ label: "Review café", status: "running" }] },
};
const newSeat = {
  ...seat,
  harnessBridge: { status: "live-process", detail: "Fixture bridge" },
  toolCatalog: {
    status: "unverified",
    harness: "codex",
    bridge: "worker",
    missing: [],
    detail: "Embedded Codex exposes no native catalog endpoint.",
    remediation: "Ask Clankie to launch a managed hire for a verified catalog.",
  },
  futureSeatField: { optional: true },
  subagents: {
    ...seat.subagents,
    futureSubagentsField: true,
    recent: [
      {
        ...seat.subagents.recent[0],
        id: "fixture-child",
        startedAt: "2026-10-04T19:58:00.000Z",
        endedAt: "2026-10-04T19:59:00.000Z",
        futureChildField: true,
      },
    ],
  },
};

describe("additive protocol response reads", () => {
  it.each(["roster", "fleet"] as const)(
    "lets an old-shape client read a new-host %s without weakening the shared schema",
    (op) => {
      const snapshot = { schemaVersion: 1, cursor: "fixture:1", seats: [seat], personas: [], channels: [] };
      const expected =
        op === "roster" ? { op, schemaVersion: 1, seats: [seat] } : { op, schemaVersion: 1, snapshot };
      const newer =
        op === "roster"
          ? { ...expected, seats: [newSeat], futureResultField: true }
          : {
              ...expected,
              snapshot: { ...snapshot, seats: [newSeat], futureSnapshotField: true },
              futureResultField: true,
            };
      expect(oldResult.safeParse(newer).success).toBe(false);
      expect(parseProtocolResponse(oldResult, newer)).toEqual(expected);
      expect(newSeat.subagents.recent[0]).toHaveProperty("id", "fixture-child");
      expect(oldResult.safeParse(newer).success).toBe(false);
    },
  );

  it.each([
    { schemaVersion: 2 },
    { op: "future-op" },
    { seats: [{ ...newSeat, occupantId: undefined }] },
    { seats: [{ ...newSeat, subagents: { running: -1, recent: [] } }] },
    {
      seats: [
        {
          ...newSeat,
          subagents: { running: 1, recent: [{ label: "Review", status: "future-status", extra: true }] },
        },
      ],
    },
    { seats: Array.from({ length: 49 }, () => newSeat) },
  ])("still rejects malformed known data %j", (patch) => {
    expect(() =>
      parseProtocolResponse(oldResult, { op: "roster", schemaVersion: 1, seats: [newSeat], ...patch }),
    ).toThrow(z.ZodError);
  });

  it("handles unknown keys inside a plain union and preserves refinements, record entries and catchall data", () => {
    const schema = z
      .object({
        choice: z.union([
          z.object({ number: z.number().positive() }).strict(),
          z.object({ text: z.string() }).strict(),
        ]),
        record: z.record(z.string(), z.object({ count: z.number() }).strict()),
        open: z.object({ known: z.boolean() }).catchall(z.string()),
      })
      .strict()
      .refine((value) => "number" in value.choice && value.choice.number > 1);
    const value = {
      choice: { number: 2, added: true },
      record: { dynamic: { count: 1, added: true } },
      open: { known: true, added: "retained" },
    };
    expect(parseProtocolResponse(schema, value)).toEqual({
      choice: { number: 2 },
      record: { dynamic: { count: 1 } },
      open: value.open,
    });
    expect(() => parseProtocolResponse(schema, { ...value, choice: { number: 1, added: true } })).toThrow(
      z.ZodError,
    );
    expect(() => parseProtocolResponse(schema, { ...value, choice: { number: -1, added: true } })).toThrow(
      z.ZodError,
    );
  });

  it("keeps host request validation strict, including nested commands", () => {
    expect(
      OperatorConversationServiceRequestSchema.safeParse({ op: "roster", schemaVersion: 1, extra: true })
        .success,
    ).toBe(false);
    expect(
      OperatorConversationServiceRequestSchema.safeParse({
        op: "connections",
        schemaVersion: 1,
        command: { action: "list", extra: true },
      }).success,
    ).toBe(false);
  });

  it("offers the same projection and rejection through safe parsing", () => {
    expect(safeParseProtocolResponse(oldSeat, newSeat)).toEqual({ success: true, data: seat });
    expect(safeParseProtocolResponse(oldSeat, { ...newSeat, status: 42 }).success).toBe(false);
  });

  it("does not traverse opaque known JSON or mutate the original response", () => {
    let opaque: unknown = { value: true };
    for (let depth = 0; depth < 20_000; depth++) opaque = { child: opaque };
    const schema = z
      .object({ opaque: z.unknown(), known: z.object({ value: z.string() }).strict() })
      .strict();
    const original = { opaque, known: { value: "retained", added: true }, added: true };
    const projected = parseProtocolResponse(schema, original);
    expect(projected.opaque).toBe(opaque);
    expect(projected.known).toEqual({ value: "retained" });
    expect(original.known.added).toBe(true);
    expect(original.added).toBe(true);
  });

  it("drops the list entry holding a new additive value and keeps every other rule", () => {
    const Kind = additiveEnum(["text", "ids"]);
    const schema = z
      .object({
        fields: z.array(z.object({ key: Kind, label: z.string() }).strict()).min(1),
        keys: z.array(Kind),
        primary: Kind,
        status: z.enum(["passed", "failed"]),
      })
      .strict();
    const value = {
      fields: [
        { key: "text", label: "Known" },
        { key: "future", label: "Newer", added: true },
      ],
      keys: ["ids", "future", "text"],
      primary: "text",
      status: "passed",
    };
    expect(schema.safeParse(value).success).toBe(false);
    expect(parseProtocolResponse(schema, value)).toEqual({
      fields: [{ key: "text", label: "Known" }],
      keys: ["ids", "text"],
      primary: "text",
      status: "passed",
    });
    expect(value.keys).toHaveLength(3);
    for (const patch of [
      { primary: "future" },
      { status: "future" },
      { keys: [42] },
      { fields: [{ key: "future", label: "Newer" }] },
      { fields: [{ key: "future", label: 42 }, value.fields[0]], keys: [] },
    ])
      expect(() => parseProtocolResponse(schema, { ...value, ...patch })).toThrow(z.ZodError);
    expect(schema.safeParse({ ...value, primary: "future" }).error?.issues[0]?.message).toMatch(
      /expected one of text\|ids/u,
    );
  });
});

// VUH-2764: a call line recorded as spoken. Apps built before the marker read
// it as an ordinary message: the reader drops the key and keeps the page.
describe("a spoken call line to an older reader", () => {
  const message = OperatorConversationStreamEventSchema.options.find(
    (option) => option.shape.type.value === "message",
  )!;
  // The message as apps before VUH-2764 have it: every field but the marker.
  const { spoken: _marker, ...before } = message.shape as Record<string, z.ZodType>;
  const oldPage = z.object({ events: z.array(z.object(before).strict()) }).strict();
  const line = {
    schemaVersion: 1,
    conversationId: "global-default",
    cursor: "000000000001",
    revision: 1,
    occurredAt: "2026-10-24T00:00:00.000Z",
    type: "message",
    role: "operator",
    text: "Let's grab lunch.",
    streaming: false,
  } as const;

  it("is a plain message to an app that predates the marker, and spoken to one that knows it", () => {
    const page = {
      events: [
        { ...line, spoken: true },
        { ...line, cursor: "000000000002", role: "captain", text: "Sure." },
      ],
    };
    expect(oldPage.safeParse(page).success).toBe(false);
    expect(parseProtocolResponse(oldPage, page)).toEqual({ events: [line, page.events[1]] });
    expect(OperatorConversationStreamEventSchema.parse(page.events[0])).toMatchObject({ spoken: true });
  });

  it("is never anything but true", () => {
    expect(OperatorConversationStreamEventSchema.safeParse({ ...line, spoken: false }).success).toBe(false);
  });
});
