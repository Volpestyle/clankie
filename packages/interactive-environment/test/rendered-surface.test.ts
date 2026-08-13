import { describe, expect, it } from "vitest";
import {
  RENDERED_SURFACE_OVERLAY_SCHEMA_VERSION,
  RenderedSurfaceMessageSchema,
  RenderedSurfaceOverlaySchema,
} from "../src/index.ts";

const BASE = {
  surface: "gba_emulator",
  sequence: 4,
  updatedAt: "2026-08-12T18:00:00.000Z",
};

const STRUCTURED = {
  ...BASE,
  objective: "reach Pewter City",
  intent: "take the north path",
  monologue: "The path north is clear.",
  effect: "entered Viridian Forest",
};

describe("rendered surface overlay versioning", () => {
  it("keeps accepting the v1 lines payload from a producer built before v2", () => {
    const parsed = RenderedSurfaceOverlaySchema.parse({
      ...BASE,
      schemaVersion: 1,
      lines: ["PIKACHU Lv12", "used THUNDERSHOCK"],
    });
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      lines: ["PIKACHU Lv12", "used THUNDERSHOCK"],
    });
  });

  it("stamps an honest v2 on the structured overlay, even from a producer still stamping 1", () => {
    for (const stale of [1, 2]) {
      const parsed = RenderedSurfaceOverlaySchema.parse({ ...STRUCTURED, schemaVersion: stale });
      expect(parsed.schemaVersion).toBe(RENDERED_SURFACE_OVERLAY_SCHEMA_VERSION);
      expect(parsed).toMatchObject({ monologue: "The path north is clear." });
    }
  });

  it("rejects shapes that lie about their version", () => {
    // lines is a v1-only shape; it cannot claim v2.
    expect(() =>
      RenderedSurfaceOverlaySchema.parse({ ...BASE, schemaVersion: 2, lines: ["a"] }),
    ).toThrow();
    // The structured shape has no version 3.
    expect(() => RenderedSurfaceOverlaySchema.parse({ ...STRUCTURED, schemaVersion: 3 })).toThrow();
  });

  it("carries both overlay versions through the message envelope", () => {
    const v1 = RenderedSurfaceMessageSchema.parse({
      kind: "overlay",
      overlay: { ...BASE, schemaVersion: 1, lines: ["party healed"] },
    });
    const v2 = RenderedSurfaceMessageSchema.parse({
      kind: "overlay",
      overlay: { ...STRUCTURED, schemaVersion: 2 },
    });
    expect(v1.kind === "overlay" && "lines" in v1.overlay).toBe(true);
    expect(v2.kind === "overlay" && v2.overlay.schemaVersion === 2).toBe(true);
  });
});
