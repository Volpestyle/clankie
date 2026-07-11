import type { OverlayOptions } from "@earendil-works/pi-tui";

export type ClankieFaceRowsOptions = {
  readonly reservedRows: number;
  readonly terminalRows: number;
};

export type ClankieTranscriptRowsOptions = ClankieFaceRowsOptions & {
  readonly minRows: number;
};

export type ClankieCommandRowsOptions = ClankieFaceRowsOptions & {
  readonly maxRows: number;
};

export function resolveClankieTranscriptRows(options: ClankieTranscriptRowsOptions): number {
  const remainingRows = options.terminalRows - options.reservedRows;
  return remainingRows >= options.minRows ? remainingRows : Math.max(1, remainingRows);
}

export function resolveClankieCommandRows(options: ClankieCommandRowsOptions): number {
  return clampNumber(options.terminalRows - options.reservedRows, 0, options.maxRows);
}

export type ClankieTranscriptMouseTargetOptions = {
  readonly bannerRows: number;
  readonly transcriptRows: number;
  readonly belowRows: number;
  readonly terminalRows: number;
  readonly mouseRow: number;
  readonly mouseCol: number;
};

export type ClankieTranscriptMouseTarget = {
  readonly row: number;
  readonly col: number;
  readonly inside: boolean;
};

// Map an absolute 1-based terminal cell to a transcript row/col for the default
// bottom-input stack. Returns a clamped row plus whether the cell actually fell
// inside the transcript band.
export function resolveClankieTranscriptMouseTarget(
  options: ClankieTranscriptMouseTargetOptions,
): ClankieTranscriptMouseTarget {
  return resolveClankieTranscriptMouseTargetFromBands({
    bands: [
      { band: "banner", rows: options.bannerRows },
      { band: "transcript", rows: options.transcriptRows },
      { band: "status", rows: options.belowRows },
    ],
    mouseCol: options.mouseCol,
    mouseRow: options.mouseRow,
    terminalRows: options.terminalRows,
  });
}

export type ClankieTranscriptMouseTargetFromBandsOptions = {
  readonly bands: readonly ClankieFaceBandRows[];
  readonly terminalRows: number;
  readonly mouseRow: number;
  readonly mouseCol: number;
};

export function resolveClankieTranscriptMouseTargetFromBands(
  options: ClankieTranscriptMouseTargetFromBandsOptions,
): ClankieTranscriptMouseTarget {
  const transcript = bandBounds(options.bands, "transcript");
  const rawRow = screenFlatRow(options) - transcript.start;
  const lastRow = Math.max(0, transcript.rows - 1);
  return {
    col: Math.max(0, options.mouseCol - 1),
    inside: transcript.rows > 0 && rawRow >= 0 && rawRow < transcript.rows,
    row: clampNumber(rawRow, 0, lastRow),
  };
}

export type ClankieChromeBand = "banner" | "modal" | "status" | "typeahead";
export type ClankieFaceBand = ClankieChromeBand | "transcript" | "editor";
export type ClankieFaceBandRows = {
  readonly band: ClankieFaceBand;
  readonly rows: number;
};

export type ClankieChromeMouseTargetOptions = {
  readonly bannerRows: number;
  readonly transcriptRows: number;
  readonly statusRows: number;
  readonly typeaheadRows: number;
  readonly editorRows: number;
  readonly terminalRows: number;
  readonly mouseRow: number;
  readonly mouseCol: number;
};

export type ClankieChromeMouseTarget = {
  readonly band: ClankieChromeBand;
  readonly row: number;
  readonly col: number;
};

// Map an absolute 1-based terminal cell to a selectable chrome band in the
// default bottom-input stack. Returns null when the cell falls in the transcript
// band (which owns its own selection), in the editor, or outside the frame.
export function resolveClankieChromeMouseTarget(
  options: ClankieChromeMouseTargetOptions,
): ClankieChromeMouseTarget | null {
  return resolveClankieChromeMouseTargetFromBands({
    bands: [
      { band: "banner", rows: options.bannerRows },
      { band: "transcript", rows: options.transcriptRows },
      { band: "status", rows: options.statusRows },
      { band: "typeahead", rows: options.typeaheadRows },
      { band: "editor", rows: options.editorRows },
    ],
    mouseCol: options.mouseCol,
    mouseRow: options.mouseRow,
    terminalRows: options.terminalRows,
  });
}

export type ClankieChromeMouseTargetFromBandsOptions = {
  readonly bands: readonly ClankieFaceBandRows[];
  readonly terminalRows: number;
  readonly mouseRow: number;
  readonly mouseCol: number;
};

export function resolveClankieChromeMouseTargetFromBands(
  options: ClankieChromeMouseTargetFromBandsOptions,
): ClankieChromeMouseTarget | null {
  const flat = screenFlatRow(options);
  const col = Math.max(0, options.mouseCol - 1);
  let start = 0;
  for (const entry of options.bands) {
    const rows = Math.max(0, entry.rows);
    const end = start + rows;
    if (flat >= start && flat < end) {
      if (
        entry.band === "banner" ||
        entry.band === "modal" ||
        entry.band === "status" ||
        entry.band === "typeahead"
      ) {
        return { band: entry.band, col, row: flat - start };
      }
      return null;
    }
    start = end;
  }
  return null;
}

export type ClankieOverlayFrameOptions = {
  readonly options?: OverlayOptions;
  readonly overlayRows: number;
  readonly terminalColumns: number;
  readonly terminalRows: number;
};

export type ClankieOverlayFrame = {
  readonly col: number;
  readonly row: number;
  readonly rows: number;
  readonly width: number;
};

export type ClankieOverlayMouseTargetOptions = ClankieOverlayFrameOptions & {
  readonly mouseCol: number;
  readonly mouseRow: number;
};

export type ClankieOverlayMouseTarget = {
  readonly col: number;
  readonly row: number;
};

export function resolveClankieOverlayFrame(options: ClankieOverlayFrameOptions): ClankieOverlayFrame {
  const opt = options.options ?? {};
  const margin =
    typeof opt.margin === "number"
      ? { top: opt.margin, right: opt.margin, bottom: opt.margin, left: opt.margin }
      : (opt.margin ?? {});
  const marginTop = Math.max(0, margin.top ?? 0);
  const marginRight = Math.max(0, margin.right ?? 0);
  const marginBottom = Math.max(0, margin.bottom ?? 0);
  const marginLeft = Math.max(0, margin.left ?? 0);
  const availableWidth = Math.max(1, options.terminalColumns - marginLeft - marginRight);
  const availableRows = Math.max(1, options.terminalRows - marginTop - marginBottom);
  let width = parseSizeValue(opt.width, options.terminalColumns) ?? Math.min(80, availableWidth);
  if (opt.minWidth !== undefined) width = Math.max(width, opt.minWidth);
  width = clampNumber(width, 1, availableWidth);
  let maxRows = parseSizeValue(opt.maxHeight, options.terminalRows);
  if (maxRows !== undefined) maxRows = clampNumber(maxRows, 1, availableRows);
  const overlayRows = Math.max(0, options.overlayRows);
  const rows = maxRows === undefined ? overlayRows : Math.min(overlayRows, maxRows);
  let row = resolveOverlayRow(opt, rows, availableRows, marginTop);
  let col = resolveOverlayCol(opt, width, availableWidth, marginLeft);
  row += opt.offsetY ?? 0;
  col += opt.offsetX ?? 0;
  row = Math.max(marginTop, Math.min(row, options.terminalRows - marginBottom - rows));
  col = Math.max(marginLeft, Math.min(col, options.terminalColumns - marginRight - width));
  return { col, row, rows, width };
}

export function resolveClankieOverlayMouseTarget(
  options: ClankieOverlayMouseTargetOptions,
): ClankieOverlayMouseTarget | null {
  const frame = resolveClankieOverlayFrame(options);
  if (frame.rows <= 0) return null;
  const row = options.mouseRow - 1 - frame.row;
  const col = options.mouseCol - 1 - frame.col;
  if (row < 0 || row >= frame.rows || col < 0 || col >= frame.width) return null;
  return { col, row };
}

function screenFlatRow(options: {
  readonly bands: readonly ClankieFaceBandRows[];
  readonly terminalRows: number;
  readonly mouseRow: number;
}): number {
  const totalRows = options.bands.reduce((sum, entry) => sum + Math.max(0, entry.rows), 0);
  const viewportTop = Math.max(0, totalRows - options.terminalRows);
  return options.mouseRow - 1 + viewportTop;
}

function bandBounds(
  bands: readonly ClankieFaceBandRows[],
  target: ClankieFaceBand,
): { readonly start: number; readonly rows: number } {
  let start = 0;
  for (const entry of bands) {
    const rows = Math.max(0, entry.rows);
    if (entry.band === target) return { rows, start };
    start += rows;
  }
  return { rows: 0, start };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSizeValue(
  value: OverlayOptions["width"] | OverlayOptions["maxHeight"],
  referenceSize: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)%$/u.exec(value);
  return match === null ? undefined : Math.floor((referenceSize * Number.parseFloat(match[1] ?? "0")) / 100);
}

function resolveOverlayRow(
  options: OverlayOptions,
  rows: number,
  availableRows: number,
  marginTop: number,
): number {
  if (options.row !== undefined) {
    if (typeof options.row === "number") return options.row;
    const match = /^(\d+(?:\.\d+)?)%$/u.exec(options.row);
    if (match !== null) {
      const maxRow = Math.max(0, availableRows - rows);
      return marginTop + Math.floor(maxRow * (Number.parseFloat(match[1] ?? "0") / 100));
    }
    return resolveAnchorRow("center", rows, availableRows, marginTop);
  }
  return resolveAnchorRow(options.anchor ?? "center", rows, availableRows, marginTop);
}

function resolveOverlayCol(
  options: OverlayOptions,
  width: number,
  availableWidth: number,
  marginLeft: number,
): number {
  if (options.col !== undefined) {
    if (typeof options.col === "number") return options.col;
    const match = /^(\d+(?:\.\d+)?)%$/u.exec(options.col);
    if (match !== null) {
      const maxCol = Math.max(0, availableWidth - width);
      return marginLeft + Math.floor(maxCol * (Number.parseFloat(match[1] ?? "0") / 100));
    }
    return resolveAnchorCol("center", width, availableWidth, marginLeft);
  }
  return resolveAnchorCol(options.anchor ?? "center", width, availableWidth, marginLeft);
}

function resolveAnchorRow(
  anchor: NonNullable<OverlayOptions["anchor"]>,
  rows: number,
  availableRows: number,
  marginTop: number,
): number {
  switch (anchor) {
    case "top-left":
    case "top-center":
    case "top-right":
      return marginTop;
    case "bottom-left":
    case "bottom-center":
    case "bottom-right":
      return marginTop + availableRows - rows;
    case "left-center":
    case "center":
    case "right-center":
      return marginTop + Math.floor((availableRows - rows) / 2);
  }
}

function resolveAnchorCol(
  anchor: NonNullable<OverlayOptions["anchor"]>,
  width: number,
  availableWidth: number,
  marginLeft: number,
): number {
  switch (anchor) {
    case "top-left":
    case "left-center":
    case "bottom-left":
      return marginLeft;
    case "top-right":
    case "right-center":
    case "bottom-right":
      return marginLeft + availableWidth - width;
    case "top-center":
    case "center":
    case "bottom-center":
      return marginLeft + Math.floor((availableWidth - width) / 2);
  }
}
