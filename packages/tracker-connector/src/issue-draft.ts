import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import { TrackerIssueDraftSchema, type TrackerIssueDraft } from "@clankie/protocol";

export type IssueDraftValidationCode =
  | "ceremony_disabled"
  | "schema_invalid"
  | "product_impact_required"
  | "product_impact_summary_too_long"
  | "heading_missing"
  | "section_placement"
  | "body_required"
  | "prose_before_heading";

export interface IssueDraftDiagnostic {
  readonly code: IssueDraftValidationCode;
  readonly message: string;
  readonly path?: readonly string[];
}

export interface IssueDraftValidationResult {
  readonly ok: boolean;
  readonly draft?: TrackerIssueDraft;
  readonly diagnostics: readonly IssueDraftDiagnostic[];
}

export interface ValidateIssueDraftInput {
  /** Unknown payload validated against TrackerIssueDraftSchema. */
  readonly draft: unknown;
  /** Effective captain ceremony projection (from compileDoctrine + projectCaptainCeremony). */
  readonly projection: CaptainCeremonyProjection;
  /**
   * Fully rendered issue body used to enforce heading + sectionPlacement.
   * Required (non-empty) when the ceremony requires product impact.
   */
  readonly bodyMarkdown?: string;
}

/**
 * Count sentences with terminator split (., !, ?).
 * HTML line breaks (`<br>`, `<br/>`) are normalized to separators so they cannot
 * compress multiple sentences into one.
 */
export function countSummarySentences(summary: string): number {
  const normalized = summary
    .replace(/<\s*br\s*\/?\s*>/giu, "\n")
    .replace(/<\/\s*p\s*>/giu, "\n")
    .replace(/\s+/gu, " ")
    .trim();
  if (normalized.length === 0) return 0;
  const parts = normalized
    .split(/(?<=[.!?])(?:\s+|$)/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? 1 : parts.length;
}

function headingPattern(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$|^\\*\\*${escaped}:?\\*\\*\\s*$`, "imu");
}

function firstMarkdownSectionTitle(body: string): string | undefined {
  return markdownSectionTitles(body)[0];
}

function markdownSectionTitles(body: string): string[] {
  const titles: string[] = [];
  for (const line of body.split(/\r?\n/u)) {
    const atx = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (atx?.[1]) {
      titles.push(atx[1].trim());
      continue;
    }
    const bold = line.match(/^\*\*(.+?):?\*\*\s*$/u);
    if (bold?.[1]) titles.push(bold[1].trim());
  }
  return titles;
}

/** True when non-whitespace prose appears before the first markdown heading line. */
export function hasProseBeforeFirstHeading(body: string): boolean {
  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/^#{1,6}\s+\S/u.test(trimmed)) return false;
    if (/^\*\*.+?:?\*\*\s*$/u.test(trimmed)) return false;
    return true;
  }
  return false;
}

/**
 * Pure deterministic issue-draft validator for the effective ceremony projection.
 * Must run before any connector write. No I/O, no provider nouns.
 */
export function validateIssueDraft(input: ValidateIssueDraftInput): IssueDraftValidationResult {
  const diagnostics: IssueDraftDiagnostic[] = [];
  const { projection } = input;

  if (!projection.issueDraft.enabled) {
    return {
      ok: true,
      diagnostics: [
        {
          code: "ceremony_disabled",
          message: "Issue-draft ceremony is disabled for this profile; structural draft checks are skipped.",
        },
      ],
    };
  }

  const parsed = TrackerIssueDraftSchema.safeParse(input.draft);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        code: "schema_invalid",
        message: issue.message,
        path: issue.path.map(String),
      });
    }
    return { ok: false, diagnostics };
  }

  const draft = parsed.data;
  const rules = projection.issueDraft;

  if (rules.requireProductImpact) {
    const summary = draft.productImpact.summary.trim();
    if (summary.length === 0) {
      diagnostics.push({
        code: "product_impact_required",
        message: "Product impact summary is required by the effective ceremony.",
        path: ["productImpact", "summary"],
      });
    }
  }

  const sentences = countSummarySentences(draft.productImpact.summary);
  if (sentences > rules.maxSummarySentences) {
    diagnostics.push({
      code: "product_impact_summary_too_long",
      message: `Product impact summary has ${String(sentences)} sentences; ceremony allows at most ${String(rules.maxSummarySentences)}.`,
      path: ["productImpact", "summary"],
    });
  }

  const bodyRaw = input.bodyMarkdown;
  const body = bodyRaw?.trim();
  if (rules.requireProductImpact && (body === undefined || body.length === 0)) {
    diagnostics.push({
      code: "body_required",
      message: "Rendered bodyMarkdown is required when the ceremony requires product impact.",
      path: ["bodyMarkdown"],
    });
    return { ok: false, draft, diagnostics };
  }

  if (body !== undefined && body.length > 0) {
    if (hasProseBeforeFirstHeading(body)) {
      diagnostics.push({
        code: "prose_before_heading",
        message: "Rendered body must not include prose or content before the first required heading.",
        path: ["bodyMarkdown"],
      });
    }

    const headingRe = headingPattern(rules.heading);
    if (!headingRe.test(body)) {
      diagnostics.push({
        code: "heading_missing",
        message: `Rendered body must include the ceremony product-impact heading "${rules.heading}".`,
        path: ["bodyMarkdown"],
      });
    } else if (rules.sectionPlacement === "first") {
      const first = firstMarkdownSectionTitle(body);
      if (first !== undefined && first.toLowerCase() !== rules.heading.toLowerCase()) {
        diagnostics.push({
          code: "section_placement",
          message: `Ceremony requires product-impact section first; found leading section "${first}".`,
          path: ["bodyMarkdown"],
        });
      }
    } else if (rules.sectionPlacement === "after_summary") {
      const titles = markdownSectionTitles(body).map((title) => title.toLowerCase());
      const summaryIndex = titles.indexOf("summary");
      const productImpactIndex = titles.indexOf(rules.heading.toLowerCase());
      if (summaryIndex < 0 || productImpactIndex !== summaryIndex + 1) {
        diagnostics.push({
          code: "section_placement",
          message: `Ceremony requires product-impact section immediately after Summary.`,
          path: ["bodyMarkdown"],
        });
      }
    } else if (rules.sectionPlacement === "last") {
      const titles = markdownSectionTitles(body);
      const lastHeading = titles.at(-1);
      if (lastHeading !== undefined && lastHeading.toLowerCase() !== rules.heading.toLowerCase()) {
        diagnostics.push({
          code: "section_placement",
          message: `Ceremony requires product-impact section last; found trailing section "${lastHeading}".`,
          path: ["bodyMarkdown"],
        });
      }
    }
  }

  return {
    ok: diagnostics.length === 0,
    draft,
    diagnostics,
  };
}
