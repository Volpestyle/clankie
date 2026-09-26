import {
  WORK_EVIDENCE_KINDS,
  WORK_ITEM_STATUSES,
  type WorkCriterion,
  type WorkEvidence,
  type WorkItemStatus,
} from "@clankie/protocol/work-items";

/**
 * The Markdown every backend shares (ADR 0191): criteria are a checklist under
 * `## Acceptance Criteria`, evidence a captioned link list under `## Evidence`.
 * Edits touch only those sections and the owner/depends lines, so an issue body
 * an owner wrote by hand keeps its other sections and their order.
 */

const CRITERIA_HEADING = "## Acceptance Criteria";
const EVIDENCE_HEADING = "## Evidence";
const CRITERION = /^\s*[-*]\s+\[( |x|X)\]\s+(.+?)\s*$/u;
const EVIDENCE = /^\s*[-*]\s+(?:(image|video|log|link):\s+)?!?\[([^\]]*)\]\(([^)\s]+)\)\s*$/u;
const OWNER = /^\*\*Owner:\*\*\s+(.+?)\s*$/u;
const DEPENDS = /^\*\*Depends on:\*\*\s+(.+?)\s*$/u;

export interface ParsedBody {
  readonly summary: string;
  readonly criteria: WorkCriterion[];
  readonly evidence: WorkEvidence[];
  readonly owner?: string;
  readonly dependsOn: string[];
}

interface Section {
  /** The heading line, or undefined for text before the first heading. */
  readonly heading: string | undefined;
  readonly lines: string[];
}

function sections(body: string): Section[] {
  const result: Section[] = [{ heading: undefined, lines: [] }];
  let fence = false;
  for (const line of body.replace(/\r\n?/gu, "\n").split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) fence = !fence;
    if (!fence && /^##\s+\S/u.test(line)) result.push({ heading: line.trim(), lines: [] });
    else result.at(-1)!.lines.push(line);
  }
  return result;
}

function outsideFences(lines: readonly string[]): string[] {
  let fence = false;
  return lines.filter((line) => {
    if (/^\s*(```|~~~)/u.test(line)) {
      fence = !fence;
      return false;
    }
    return !fence;
  });
}

const isCriteria = (heading: string | undefined) =>
  heading !== undefined && /^##\s+acceptance criteria\s*$/iu.test(heading);
const isEvidence = (heading: string | undefined) =>
  heading !== undefined && /^##\s+evidence\s*$/iu.test(heading);

export function inferEvidenceKind(url: string): WorkEvidence["kind"] {
  const path = url.split(/[?#]/u)[0]!.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|avif)$/u.test(path)) return "image";
  if (/\.(mp4|mov|webm|m4v)$/u.test(path)) return "video";
  if (/\.(log|txt|jsonl?|out)$/u.test(path)) return "log";
  return "link";
}

export function parseBody(body: string): ParsedBody {
  const criteria: WorkCriterion[] = [];
  const evidence: WorkEvidence[] = [];
  const summary: string[] = [];
  let owner: string | undefined;
  let dependsOn: string[] = [];
  for (const section of sections(body)) {
    if (isCriteria(section.heading)) {
      for (const line of outsideFences(section.lines)) {
        const match = CRITERION.exec(line);
        if (match) criteria.push({ text: match[2]!, done: match[1] !== " " });
      }
    } else if (isEvidence(section.heading)) {
      for (const line of outsideFences(section.lines)) {
        const match = EVIDENCE.exec(line);
        if (!match) continue;
        const url = match[3]!;
        const kind = (match[1] as WorkEvidence["kind"] | undefined) ?? inferEvidenceKind(url);
        evidence.push({ kind, url, caption: match[2]!.trim() || url });
      }
    } else {
      if (section.heading !== undefined) summary.push(section.heading);
      for (const line of section.lines) {
        const ownerMatch = section.heading === undefined ? OWNER.exec(line) : null;
        const dependsMatch = section.heading === undefined ? DEPENDS.exec(line) : null;
        if (ownerMatch) owner = ownerMatch[1]!;
        else if (dependsMatch)
          dependsOn = dependsMatch[1]!
            .split(/[,\s]+/u)
            .map((id) => id.trim())
            .filter((id) => id.length > 0);
        else summary.push(line);
      }
    }
  }
  return {
    summary: summary.join("\n").trim(),
    criteria,
    evidence,
    ...(owner === undefined ? {} : { owner }),
    dependsOn,
  };
}

export function renderCriteria(criteria: readonly WorkCriterion[]): string[] {
  return criteria.map((criterion) => `- [${criterion.done ? "x" : " "}] ${criterion.text}`);
}

export function renderEvidence(evidence: readonly WorkEvidence[]): string[] {
  return evidence.map((entry) => `- ${entry.kind}: [${entry.caption.replace(/[[\]]/gu, "")}](${entry.url})`);
}

export interface BodyPatch {
  readonly criteria?: readonly WorkCriterion[];
  readonly evidence?: readonly WorkEvidence[];
  readonly owner?: string | null;
  readonly dependsOn?: readonly string[];
}

/**
 * Rewrites only what the patch names. Existing criteria and evidence sections
 * are replaced where they stand; missing ones are appended. Everything else,
 * including sections the owner added, is left byte-for-byte where it was.
 */
export function patchBody(body: string, patch: BodyPatch): string {
  const parts = sections(body);
  const replaceSection = (
    test: (heading: string | undefined) => boolean,
    heading: string,
    content: readonly string[],
  ) => {
    const index = parts.findIndex((part) => test(part.heading));
    const lines = ["", ...content, ""];
    if (index >= 0) parts[index] = { heading: parts[index]!.heading, lines };
    else parts.push({ heading, lines });
  };
  if (patch.criteria !== undefined)
    replaceSection(isCriteria, CRITERIA_HEADING, renderCriteria(patch.criteria));
  if (patch.evidence !== undefined)
    replaceSection(isEvidence, EVIDENCE_HEADING, renderEvidence(patch.evidence));
  if (patch.owner !== undefined || patch.dependsOn !== undefined) {
    const lead = parts[0]!;
    let lines = lead.lines;
    if (patch.owner !== undefined) {
      lines = lines.filter((line) => !OWNER.test(line));
      if (patch.owner !== null) lines = [`**Owner:** ${patch.owner}`, ...lines];
    }
    if (patch.dependsOn !== undefined) {
      const ownerLines = lines.filter((line) => OWNER.test(line));
      const rest = lines.filter((line) => !OWNER.test(line) && !DEPENDS.test(line));
      lines = [
        ...ownerLines,
        ...(patch.dependsOn.length === 0 ? [] : [`**Depends on:** ${patch.dependsOn.join(", ")}`]),
        ...rest,
      ];
    }
    // Each header line is its own paragraph, so Markdown never runs the owner
    // into the summary ("**Owner:** proof Created by ...").
    const headers = lines.filter((line) => OWNER.test(line) || DEPENDS.test(line));
    const body = lines.filter((line) => !OWNER.test(line) && !DEPENDS.test(line));
    while (body[0]?.trim() === "") body.shift();
    lines = [...headers.flatMap((line) => [line, ""]), ...body];
    parts[0] = { heading: undefined, lines };
  }
  const text = parts
    .map((part) => (part.heading === undefined ? part.lines : [part.heading, ...part.lines]).join("\n"))
    .join("\n");
  return `${text.replace(/\n{3,}/gu, "\n\n").trim()}\n`;
}

export function isWorkItemStatus(value: string): value is WorkItemStatus {
  return (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

export function isEvidenceKind(value: string): value is WorkEvidence["kind"] {
  return (WORK_EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** `W-` plus six lowercase base32 characters: collision-free enough for parallel hires. */
export function newWorkItemId(random: () => number = Math.random): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let id = "W-";
  for (let i = 0; i < 6; i += 1) id += alphabet[Math.floor(random() * alphabet.length)];
  return id;
}

export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/gu, "")
    .trim()
    .replace(/[\s_-]+/gu, "-")
    .slice(0, 60)
    .replace(/-+$/u, "");
  return slug.length === 0 ? "item" : slug;
}
