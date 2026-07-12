import type { CaptainCeremonyProjection } from "@clankie/doctrine";
import { TrackerIssueDraftSchema, type TrackerIssueDraft } from "@clankie/protocol";

export type IssueDraftValidationCode =
  | "ceremony_disabled"
  | "schema_invalid"
  | "product_impact_required"
  | "product_impact_summary_too_long"
  | "heading_missing"
  | "section_placement";

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
   * Optional fully rendered issue body used to enforce heading + sectionPlacement.
   * Connectors that only hold structured fields may omit this; heading/placement
   * checks then pass without body layout evidence.
   */
  readonly bodyMarkdown?: string;
}

/** Count sentences with a simple terminator split (., !, ?). Empty → 0. */
export function countSummarySentences(summary: string): number {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return 0;
  const parts = trimmed
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length === 0 ? 1 : parts.length;
}

function headingPattern(heading: string): RegExp {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^#{1,6}\\s+${escaped}\\s*$|^\\*\\*${escaped}:?\\*\\*\\s*$`, "imu");
}

function firstMarkdownSectionTitle(body: string): string | undefined {
  for (const line of body.split(/\r?\n/u)) {
    const atx = line.match(/^#{1,6}\s+(.+?)\s*$/u);
    if (atx?.[1]) return atx[1].trim();
    const bold = line.match(/^\*\*(.+?):?\*\*\s*$/u);
    if (bold?.[1]) return bold[1].trim();
  }
  return undefined;
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

  const body = input.bodyMarkdown?.trim();
  if (body !== undefined && body.length > 0) {
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
    } else if (rules.sectionPlacement === "last") {
      const lines = body.split(/\r?\n/u);
      let lastHeading: string | undefined;
      for (const line of lines) {
        const atx = line.match(/^#{1,6}\s+(.+?)\s*$/u);
        if (atx?.[1]) lastHeading = atx[1].trim();
        const bold = line.match(/^\*\*(.+?):?\*\*\s*$/u);
        if (bold?.[1]) lastHeading = bold[1].trim();
      }
      if (lastHeading !== undefined && lastHeading.toLowerCase() !== rules.heading.toLowerCase()) {
        diagnostics.push({
          code: "section_placement",
          message: `Ceremony requires product-impact section last; found trailing section "${lastHeading}".`,
          path: ["bodyMarkdown"],
        });
      }
    }
    // after_summary: presence of heading is sufficient (checked above).
  }

  return {
    ok: diagnostics.length === 0,
    draft,
    diagnostics,
  };
}
