export type ClankieSgrMouseKind = "press" | "drag" | "release" | "wheel";

export type ClankieSgrMouseEvent = {
  readonly kind: ClankieSgrMouseKind;
  readonly button: number;
  readonly col: number;
  readonly row: number;
  readonly release: boolean;
  readonly wheelDirection?: "down" | "up" | undefined;
};

// oxlint-disable-next-line no-control-regex -- intentionally matches the SGR mouse escape sequence
const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/u;
const MOTION_FLAG = 32;
const WHEEL_FLAG = 64;

export function parseClankieSgrMouse(data: string): ClankieSgrMouseEvent | undefined {
  const match = SGR_MOUSE_PATTERN.exec(data);
  if (match === null) return undefined;
  const button = Number.parseInt(match[1] ?? "", 10);
  const col = Number.parseInt(match[2] ?? "", 10);
  const row = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isSafeInteger(button) || !Number.isSafeInteger(col) || !Number.isSafeInteger(row))
    return undefined;
  const release = match[4] === "m";
  if ((button & WHEEL_FLAG) === WHEEL_FLAG) {
    const wheelButton = button & 3;
    // Wheel notches arrive as press (`M`) reports; a release (`m`) carries no scroll.
    const wheelDirection = release
      ? undefined
      : wheelButton === 0
        ? "up"
        : wheelButton === 1
          ? "down"
          : undefined;
    return { button, col, kind: "wheel", release, row, wheelDirection };
  }
  const kind: ClankieSgrMouseKind = release
    ? "release"
    : (button & MOTION_FLAG) === MOTION_FLAG
      ? "drag"
      : "press";
  return { button, col, kind, release, row };
}

export function isClankieLeftMouseButton(event: ClankieSgrMouseEvent): boolean {
  return (event.button & 3) === 0;
}
