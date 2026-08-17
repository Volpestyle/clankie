/**
 * Laying out a frame renders every transcript block, not just the visible ones,
 * so a block that rebuilds its lines on each call makes the cost of a keystroke
 * grow with the length of the session. Blocks whose content is fixed memoize
 * here and hand back the same array every frame, which is also the signal the
 * viewport uses to skip re-decorating them.
 */
export class ClankieRenderCache {
  private width = -1;
  private lines: string[] | undefined;

  /** Drop the memo so the next render rebuilds; call whenever content changes. */
  clear(): void {
    this.lines = undefined;
  }

  get(width: number, build: () => string[]): string[] {
    if (this.lines !== undefined && this.width === width) return this.lines;
    const lines = build();
    this.width = width;
    this.lines = lines;
    return lines;
  }
}
