import { readReviewDiff, type ReviewDiff } from "./review-git.ts";
import { readReviewPatch, type ReviewPatch } from "./review-patch.ts";

/** Immutable source identity; patch object headers remain unverified claims. */
export type GuidedReviewIdentity =
  | { kind: "git"; gitDirectory: string; baseCommit: string; headCommit: string }
  | { kind: "patch"; sha256: string };
export type GuidedReviewSource =
  | { kind: "git"; repository: string; base: string; head: string }
  | { kind: "patch"; path: string };
export interface GuidedReviewAnchor {
  fileIndex: number;
  side: "old" | "new";
  line: number;
  endLine?: number;
}
export interface GuidedReviewFindingInput {
  body: string;
  severity: "info" | "warning" | "error" | "critical";
  anchor: GuidedReviewAnchor;
}
export interface GuidedReviewStep {
  title: string;
  body: string;
  fileIndex: number;
}
export interface CreateGuidedReviewInput {
  issueId: string;
  runId?: string;
  source: GuidedReviewSource;
  expectedSource: GuidedReviewIdentity;
  walkthrough: GuidedReviewStep[];
  findings: GuidedReviewFindingInput[];
}
export interface GuidedReviewCapture {
  readonly identity: Readonly<GuidedReviewIdentity>;
  readonly inspection: ReviewDiff | ReviewPatch;
}
export type GuidedFindingAction =
  | { action: "reply"; body: string }
  | { action: "resolve"; resolved: boolean };

const boundedText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const index = { type: "integer", minimum: 0, maximum: 199 };
const line = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
export const guidedReviewSourceSchema = {
  oneOf: [
    object({
      kind: { const: "git" },
      repository: boundedText(4096),
      base: boundedText(255),
      head: boundedText(255),
    }),
    object({ kind: { const: "patch" }, path: boundedText(4096) }),
  ],
};
export const guidedReviewIdentitySchema = {
  oneOf: [
    object({
      kind: { const: "git" },
      gitDirectory: boundedText(4096),
      baseCommit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
      headCommit: { type: "string", pattern: "^(?:[a-f0-9]{40}|[a-f0-9]{64})$" },
    }),
    object({ kind: { const: "patch" }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }),
  ],
};
export const guidedReviewAnchorSchema = object(
  { fileIndex: index, side: { enum: ["old", "new"] }, line, endLine: line },
  ["fileIndex", "side", "line"],
);
export const guidedReviewFindingSchema = object({
  body: boundedText(16000),
  severity: { enum: ["info", "warning", "error", "critical"] },
  anchor: guidedReviewAnchorSchema,
});
export const guidedReviewStepSchema = object({
  title: boundedText(240),
  body: boundedText(16000),
  fileIndex: index,
});
export const guidedReviewCreateProperties = {
  issueId: boundedText(255),
  runId: boundedText(255),
  source: guidedReviewSourceSchema,
  expectedSource: guidedReviewIdentitySchema,
  walkthrough: { type: "array", minItems: 1, maxItems: 200, items: guidedReviewStepSchema },
  findings: { type: "array", maxItems: 200, items: guidedReviewFindingSchema },
};
export const guidedReviewCreateSchema = object(guidedReviewCreateProperties, [
  "issueId",
  "source",
  "expectedSource",
  "walkthrough",
  "findings",
]);
export const guidedFindingActionSchema = {
  oneOf: [
    object({ action: { const: "reply" }, body: boundedText(16000) }),
    object({ action: { const: "resolve" }, resolved: { type: "boolean" } }),
  ],
};

/** Validate source-relative references against the stored snapshot, never the current checkout. */
export function validateGuidedReviewContent(
  inspection: ReviewDiff | ReviewPatch,
  walkthrough: readonly GuidedReviewStep[],
  findings: readonly GuidedReviewFindingInput[],
): void {
  if (!inspection.complete) throw new Error("A guided review requires a complete inspection");
  if (
    !Array.isArray(walkthrough) ||
    walkthrough.length < 1 ||
    walkthrough.length > 200 ||
    !Array.isArray(findings) ||
    findings.length > 200
  )
    throw new Error("Invalid guided review content count");
  const text = (value: string, max: number) => {
    if (typeof value !== "string" || !value.trim() || value.length > max)
      throw new Error("Invalid guided review text");
  };
  const fileAt = (fileIndex: number) => {
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0 || fileIndex >= inspection.files.length)
      throw new Error("Guided review file index is outside the inspection");
    return inspection.files[fileIndex]!;
  };
  for (const step of walkthrough) {
    text(step.title, 240);
    text(step.body, 16000);
    fileAt(step.fileIndex);
  }
  for (const finding of findings) {
    text(finding.body, 16000);
    if (!["info", "warning", "error", "critical"].includes(finding.severity))
      throw new Error("Invalid finding severity");
    const anchor = finding.anchor;
    const file = fileAt(anchor.fileIndex);
    const end = anchor.endLine ?? anchor.line;
    if (
      !["old", "new"].includes(anchor.side) ||
      !Number.isSafeInteger(anchor.line) ||
      anchor.line < 1 ||
      !Number.isSafeInteger(end) ||
      end < anchor.line ||
      end - anchor.line >= 200 ||
      file.binary ||
      !file.hunks?.length
    )
      throw new Error("Invalid guided finding anchor");
    const lines = new Set(
      file.hunks.flatMap((hunk) =>
        hunk.lines.map((entry) => (anchor.side === "old" ? entry.oldLine : entry.newLine)),
      ),
    );
    for (let current = anchor.line; current <= end; current++)
      if (!lines.has(current)) throw new Error("Guided finding anchor is outside inspected hunk lines");
  }
}

/** Re-read once at creation and require the caller's previously inspected exact identity. */
export async function captureGuidedReview(input: CreateGuidedReviewInput): Promise<GuidedReviewCapture> {
  const inspection =
    input.source.kind === "git" ? await readReviewDiff(input.source) : await readReviewPatch(input.source);
  const identity: GuidedReviewIdentity =
    input.source.kind === "git"
      ? {
          kind: "git",
          gitDirectory: (inspection as ReviewDiff).gitDirectory,
          baseCommit: (inspection as ReviewDiff).base.commit,
          headCommit: (inspection as ReviewDiff).head.commit,
        }
      : { kind: "patch", sha256: (inspection as ReviewPatch).patch.sha256 };
  const expected = input.expectedSource;
  if (
    identity.kind !== expected.kind ||
    (identity.kind === "git"
      ? expected.kind !== "git" ||
        identity.gitDirectory !== expected.gitDirectory ||
        identity.baseCommit !== expected.baseCommit ||
        identity.headCommit !== expected.headCommit
      : expected.kind !== "patch" || identity.sha256 !== expected.sha256)
  )
    throw new Error("Guided review source changed since inspection");
  validateGuidedReviewContent(inspection, input.walkthrough, input.findings);
  return { identity: Object.freeze(identity), inspection };
}
