import { describe, expect, it } from "vitest";
import {
  resolveClankieChromeMouseTargetFromBands,
  resolveClankieCommandRows,
  resolveClankieOverlayFrame,
  resolveClankieOverlayMouseTarget,
  resolveClankieTranscriptMouseTarget,
  resolveClankieTranscriptMouseTargetFromBands,
  resolveClankieTranscriptRows,
} from "../src/face/clankie-face-layout.ts";

describe("transcript and command row budgets", () => {
  it("uses all spare rows for the transcript on roomy terminals", () => {
    expect(resolveClankieTranscriptRows({ minRows: 4, reservedRows: 12, terminalRows: 30 })).toBe(18);
  });

  it("shrinks the transcript below the preferred minimum on short terminals", () => {
    expect(resolveClankieTranscriptRows({ minRows: 4, reservedRows: 14, terminalRows: 16 })).toBe(2);
  });

  it("keeps one transcript row when fixed chrome exceeds terminal height", () => {
    expect(resolveClankieTranscriptRows({ minRows: 4, reservedRows: 20, terminalRows: 16 })).toBe(1);
  });

  it("keeps the rich command typeahead menu on roomy terminals", () => {
    expect(resolveClankieCommandRows({ maxRows: 10, reservedRows: 12, terminalRows: 30 })).toBe(10);
  });

  it("shrinks the command typeahead to the available row budget", () => {
    expect(resolveClankieCommandRows({ maxRows: 10, reservedRows: 20, terminalRows: 24 })).toBe(4);
  });

  it("hides the command typeahead when the terminal has no spare rows", () => {
    expect(resolveClankieCommandRows({ maxRows: 10, reservedRows: 30, terminalRows: 24 })).toBe(0);
  });
});

describe("transcript mouse targets", () => {
  const roomy = { bannerRows: 4, belowRows: 6, terminalRows: 30, transcriptRows: 20 } as const;

  it("maps the first transcript row just below the banner", () => {
    const topHit = resolveClankieTranscriptMouseTarget({ ...roomy, mouseCol: 10, mouseRow: 5 });
    expect(topHit.inside).toBe(true);
    expect(topHit.row).toBe(0);
    expect(topHit.col).toBe(9);
  });

  it("maps the last transcript row just above the status chrome", () => {
    const bottomHit = resolveClankieTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 24 });
    expect(bottomHit.inside).toBe(true);
    expect(bottomHit.row).toBe(19);
  });

  it("clamps banner clicks to the first row, outside the band", () => {
    const aboveBand = resolveClankieTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 4 });
    expect(aboveBand.inside).toBe(false);
    expect(aboveBand.row).toBe(0);
  });

  it("clamps editor clicks to the last row, outside the band", () => {
    const belowBand = resolveClankieTranscriptMouseTarget({ ...roomy, mouseCol: 1, mouseRow: 25 });
    expect(belowBand.inside).toBe(false);
    expect(belowBand.row).toBe(19);
  });

  it("starts the transcript at screen row 1 when the banner scrolls off the top", () => {
    const cramped = resolveClankieTranscriptMouseTarget({
      bannerRows: 4,
      belowRows: 6,
      terminalRows: 10,
      mouseCol: 3,
      mouseRow: 1,
      transcriptRows: 4,
    });
    expect(cramped.inside).toBe(true);
    expect(cramped.row).toBe(0);
  });
});

describe("band-based mouse targets with a top-pinned input", () => {
  const topInputBands = [
    { band: "banner", rows: 3 },
    { band: "editor", rows: 2 },
    { band: "status", rows: 1 },
    { band: "typeahead", rows: 4 },
    { band: "transcript", rows: 12 },
  ] as const;

  it("leaves the transcript below the input/status/typeahead cluster", () => {
    const topInputTranscript = resolveClankieTranscriptMouseTargetFromBands({
      bands: topInputBands,
      terminalRows: 30,
      mouseCol: 8,
      mouseRow: 11,
    });
    expect(topInputTranscript.inside).toBe(true);
    expect(topInputTranscript.row).toBe(0);
  });

  it("maps status below a top-pinned input as selectable chrome", () => {
    const topInputStatus = resolveClankieChromeMouseTargetFromBands({
      bands: topInputBands,
      terminalRows: 30,
      mouseCol: 3,
      mouseRow: 6,
    });
    expect(topInputStatus?.band).toBe("status");
    expect(topInputStatus?.row).toBe(0);
  });

  it("keeps top-pinned editor rows outside chrome selection", () => {
    const topInputEditor = resolveClankieChromeMouseTargetFromBands({
      bands: topInputBands,
      terminalRows: 30,
      mouseCol: 3,
      mouseRow: 4,
    });
    expect(topInputEditor).toBeNull();
  });
});

describe("overlay frames and mouse targets", () => {
  const setupOverlayOptions = {
    anchor: "center",
    margin: { bottom: 3, left: 2, right: 2, top: 2 },
    maxHeight: "70%",
    minWidth: 48,
    width: "88%",
  } as const;

  it("uses the configured percentage width and respects margins when centered", () => {
    const overlayFrame = resolveClankieOverlayFrame({
      options: setupOverlayOptions,
      overlayRows: 10,
      terminalColumns: 100,
      terminalRows: 40,
    });
    expect(overlayFrame.width).toBe(88);
    expect(overlayFrame.row).toBe(14);
    expect(overlayFrame.col).toBe(6);
    expect(overlayFrame.rows).toBe(10);
  });

  it("maps overlay mouse targets to modal-local coordinates", () => {
    const overlayHit = resolveClankieOverlayMouseTarget({
      options: setupOverlayOptions,
      overlayRows: 10,
      terminalColumns: 100,
      terminalRows: 40,
      mouseCol: 7,
      mouseRow: 15,
    });
    expect(overlayHit?.row).toBe(0);
    expect(overlayHit?.col).toBe(0);
  });

  it("ignores cells outside the modal frame", () => {
    const overlayMiss = resolveClankieOverlayMouseTarget({
      options: setupOverlayOptions,
      overlayRows: 10,
      terminalColumns: 100,
      terminalRows: 40,
      mouseCol: 5,
      mouseRow: 15,
    });
    expect(overlayMiss).toBeNull();
  });

  it("caps overlay rows by maxHeight", () => {
    const clampedOverlay = resolveClankieOverlayFrame({
      options: setupOverlayOptions,
      overlayRows: 50,
      terminalColumns: 100,
      terminalRows: 40,
    });
    expect(clampedOverlay.rows).toBe(28);
  });
});
