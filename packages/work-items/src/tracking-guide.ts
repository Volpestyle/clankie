import { createHash } from "node:crypto";
import type { TrackerChoice } from "@clankie/protocol/project-tracking";

export const TRACKING_OPEN = "<!-- clankie:tracking -->";
export const TRACKING_CLOSE = "<!-- /clankie:tracking -->";

const PROVIDER_NAMES = { github: "GitHub issues", linear: "Linear" } as const;

/**
 * The whole block as a pure function of the choice: no clock, no model, no repo facts.
 * It names only the tracker the owner chose, because the same text lands in public and
 * private repos alike, and listing the project's other repos would publish private names.
 */
export function renderTrackingBlock(tracker: TrackerChoice): string {
  return [
    TRACKING_OPEN,
    "## Work tracking",
    "",
    "Clankie fills this block from the project's tracker setting. Change it with",
    "`clankie project tracking`, not here.",
    "",
    `- Tracker: ${PROVIDER_NAMES[tracker.provider]}`,
    `- Public work: ${tracker.publicBoard}`,
    `- Private work: ${tracker.privateBoard}`,
    TRACKING_CLOSE,
  ].join("\n");
}

/** Short, stable name for one block's text; proposals carry it so a re-run recognises them. */
export function trackingBlockHash(block: string): string {
  return createHash("sha256").update(block).digest("hex").slice(0, 16);
}

export type TrackingGuideRefusal = "malformed_markers" | "unclosed_code_fence";
type BlockLocation =
  | { readonly kind: "none" }
  | { readonly kind: "block"; readonly start: number; readonly end: number }
  | { readonly kind: "refused"; readonly reason: TrackingGuideRefusal };

interface GuideLine {
  readonly text: string;
  readonly start: number;
}

/** Lines outside fenced code, with inline code removed, so an example of a marker stays an example. */
function proseLines(text: string): { readonly lines: GuideLine[]; readonly open: boolean } {
  const lines: GuideLine[] = [];
  let fence: string | undefined;
  let start = 0;
  for (const line of text.split("\n")) {
    const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (fence !== undefined) {
      if (
        opener !== undefined &&
        opener[0] === fence[0] &&
        opener.length >= fence.length &&
        line.trim() === opener
      )
        fence = undefined;
    } else if (opener !== undefined) fence = opener;
    else lines.push({ text: line, start });
    start += line.length + 1;
  }
  return { lines, open: fence !== undefined };
}

const withoutInlineCode = (line: string) => line.replace(/(`+)(?:(?!\1).)*\1/gu, "");

/** Exactly one well-formed block, none, or a refusal. Anything ambiguous is never guessed at. */
export function locateTrackingBlock(text: string): BlockLocation {
  const { lines, open } = proseLines(text);
  const markers: { readonly closing: boolean; readonly start: number; readonly end: number }[] = [];
  for (const line of lines) {
    const prose = withoutInlineCode(line.text);
    if (!/<!--\s*\/?clankie:tracking\s*-->/u.test(prose)) continue;
    const exact = /^(\s*)<!--\s*(\/?)clankie:tracking\s*-->\s*$/u.exec(line.text);
    if (!exact) return { kind: "refused", reason: "malformed_markers" };
    const start = line.start + exact[1]!.length;
    markers.push({
      closing: exact[2] === "/",
      start,
      end: line.start + line.text.lastIndexOf("-->") + 3,
    });
  }
  if (open) return { kind: "refused", reason: "unclosed_code_fence" };
  if (markers.length === 0) return { kind: "none" };
  const [first, second] = markers;
  if (markers.length !== 2 || first!.closing || !second!.closing)
    return { kind: "refused", reason: "malformed_markers" };
  return { kind: "block", start: first!.start, end: second!.end };
}

const lineEnding = (text: string) => (/\r\n/u.test(text) ? "\r\n" : "\n");

/** The block as read, in LF, so a CRLF guide does not read as drift forever. */
export function readTrackingBlock(text: string): string | undefined {
  const location = locateTrackingBlock(text);
  return location.kind === "block"
    ? text.slice(location.start, location.end).replaceAll("\r\n", "\n")
    : undefined;
}

/**
 * The guide with the block in place. Every byte before the opening marker and after the
 * closing one survives; a guide without a block keeps all its text and gains one at the end.
 */
export function writeTrackingBlock(text: string, block: string): string | { refused: TrackingGuideRefusal } {
  const location = locateTrackingBlock(text);
  if (location.kind === "refused") return { refused: location.reason };
  const eol = lineEnding(text);
  const rendered = block.replaceAll("\n", eol);
  if (location.kind === "block") return text.slice(0, location.start) + rendered + text.slice(location.end);
  if (text.length === 0) return rendered + eol;
  const separator = text.endsWith(`${eol}${eol}`) ? "" : text.endsWith(eol) ? eol : `${eol}${eol}`;
  return text + separator + rendered + eol;
}

export const GUIDE_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
export type GuideFile = (typeof GUIDE_FILES)[number];

/** An `@FILE` import in prose. A link or a mention in passing does not pull the file in. */
export function guideIncludes(text: string, file: GuideFile): boolean {
  const pattern = new RegExp(`(?:^|\\s)@(?:\\./)?${file.replace(".", "\\.")}(?=$|[\\s.,;:)])`, "u");
  return proseLines(text).lines.some((line) => pattern.test(withoutInlineCode(line.text)));
}

export type GuideChoice =
  | { readonly kind: "file"; readonly file: GuideFile; readonly created?: true }
  | { readonly kind: "refused"; readonly reason: "duplicate_blocks" };

/**
 * Which file holds the block. One already there stays where the owner has it. Otherwise it
 * goes in the file the other includes, and in CLAUDE.md when neither (or both) include.
 */
export function chooseTrackingGuide(guides: Partial<Record<GuideFile, string>>): GuideChoice {
  const present = GUIDE_FILES.filter((file) => guides[file] !== undefined);
  const holding = present.filter((file) => locateTrackingBlock(guides[file]!).kind !== "none");
  if (holding.length > 1) return { kind: "refused", reason: "duplicate_blocks" };
  if (holding.length === 1) return { kind: "file", file: holding[0]! };
  if (present.length === 0) return { kind: "file", file: "CLAUDE.md", created: true };
  if (present.length === 1) return { kind: "file", file: present[0]! };
  const claudeIncludesAgents = guideIncludes(guides["CLAUDE.md"]!, "AGENTS.md");
  const agentsIncludesClaude = guideIncludes(guides["AGENTS.md"]!, "CLAUDE.md");
  return {
    kind: "file",
    file: claudeIncludesAgents && !agentsIncludesClaude ? "AGENTS.md" : "CLAUDE.md",
  };
}
