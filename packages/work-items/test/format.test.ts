import { describe, expect, it } from "vitest";
import { inferEvidenceKind, newWorkItemId, parseBody, patchBody, slugify } from "../src/format.ts";

const OWNER_WRITTEN = `Fix the login redirect loop.

## Background

The callback drops the state cookie.

## Acceptance Criteria

* [X] Reproduced with a test
- [ ] Fixed without widening the cookie scope

## Context

- linked from the support thread
`;

describe("the shared work-item Markdown", () => {
  it("reads criteria in either list marker and case, and keeps other sections in the summary", () => {
    const parsed = parseBody(OWNER_WRITTEN);
    expect(parsed.criteria).toEqual([
      { text: "Reproduced with a test", done: true },
      { text: "Fixed without widening the cookie scope", done: false },
    ]);
    expect(parsed.summary).toContain("## Background");
    expect(parsed.summary).toContain("## Context");
    expect(parsed.summary).not.toContain("Acceptance Criteria");
  });

  it("edits only the sections it is asked to, where they stand", () => {
    const next = patchBody(OWNER_WRITTEN, {
      criteria: [
        { text: "Reproduced with a test", done: true },
        { text: "Fixed without widening the cookie scope", done: true },
      ],
      evidence: [{ kind: "log", url: "https://ci.example/run/7", caption: "CI run with the new test green" }],
    });
    const order = ["## Background", "## Acceptance Criteria", "## Context", "## Evidence"].map((heading) =>
      next.indexOf(heading),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(next).toContain("- [x] Fixed without widening the cookie scope");
    expect(next).toContain("- log: [CI run with the new test green](https://ci.example/run/7)");
    expect(next).toContain("linked from the support thread");
  });

  it("round-trips owner, dependencies and evidence kinds", () => {
    const body = patchBody("Summary.", {
      owner: "codex-2",
      dependsOn: ["W-abc123", "W-def456"],
      evidence: [{ kind: "image", url: "https://x/a.png", caption: "Board on iPhone (sample data)" }],
    });
    expect(parseBody(body)).toMatchObject({
      owner: "codex-2",
      dependsOn: ["W-abc123", "W-def456"],
      summary: "Summary.",
      evidence: [{ kind: "image", url: "https://x/a.png", caption: "Board on iPhone (sample data)" }],
    });
    expect(parseBody(patchBody(body, { owner: null })).owner).toBeUndefined();
    // Header lines are their own paragraphs, so rendered Markdown keeps them apart.
    expect(patchBody("Created by the proof.", { owner: "proof" })).toBe(
      "**Owner:** proof\n\nCreated by the proof.\n",
    );
  });

  it("ignores checklist-looking lines inside code fences", () => {
    const body = "## Acceptance Criteria\n\n- [ ] real\n\n```\n## Evidence\n- [x] not a criterion\n```\n";
    expect(parseBody(body).criteria).toEqual([{ text: "real", done: false }]);
    expect(parseBody(body).evidence).toEqual([]);
  });

  it("infers evidence kinds, makes readable slugs and unambiguous ids", () => {
    expect(inferEvidenceKind("https://x/y.mp4?sig=1")).toBe("video");
    expect(inferEvidenceKind("logs/check.log")).toBe("log");
    expect(inferEvidenceKind("https://linear.app/x")).toBe("link");
    expect(slugify("Fix: the Login redirect (again)!")).toBe("fix-the-login-redirect-again");
    expect(newWorkItemId(() => 0)).toBe("W-aaaaaa");
    expect(newWorkItemId()).toMatch(/^W-[a-z2-9]{6}$/u);
  });
});
