import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The standing review gate's seat tools (ADR 0287). The author's bridge reads
// the exact patch from its own checkout; the service hashes the bytes it
// stores and routes the candidate to the project's reviewer, and the verdict
// back, with no lead relay and no peer channel.

const PATCH_MAX_BYTES = 4 * 1024 * 1024;
const INLINE_PATCH_MAX_BYTES = 64 * 1024;

export const REVIEW_TOOLS = [
  {
    name: "submit_for_review",
    description:
      "Submit your committed change as a landing candidate to your project's standing reviewer. Sends the exact `git diff --binary` of merge-base(origin/main)..HEAD from your checkout; the service hashes it and the verdict binds to that hash. Landing waits for APPROVE of exactly this patch. After CHANGES, fix, commit and call this again with the same issue. Uncommitted changes are not part of the candidate.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "What changed and why, and how you proved it.",
        },
        issue: { type: "string", maxLength: 64, description: "The tracker issue, such as VUH-2616." },
        evidence: {
          type: "array",
          maxItems: 20,
          items: { type: "string", maxLength: 2048 },
          description: "Links the reviewer should check: evidence, logs, runs.",
        },
        base: {
          type: "string",
          maxLength: 200,
          description: "The ref this change lands on; defaults to origin/main.",
        },
      },
      required: ["summary"],
      additionalProperties: false,
    },
  },
  {
    name: "review_candidate",
    description:
      "Read a review candidate you authored or must review: its record and its exact patch, saved to a local file. The patch is the bytes the service hashed.",
    inputSchema: {
      type: "object",
      properties: { candidateId: { type: "string", format: "uuid" } },
      required: ["candidateId"],
      additionalProperties: false,
    },
  },
  {
    name: "review_verdict",
    description:
      "As your project's standing reviewer, record APPROVE or CHANGES for one candidate, bound to its patchId. Review adversarially: CHANGES lists each concrete required change. The verdict reaches the author and their lead; landing waits for APPROVE of that exact patch.",
    inputSchema: {
      type: "object",
      properties: {
        candidateId: { type: "string", format: "uuid" },
        patchId: { type: "string", description: "The candidate's patchId, from its review request." },
        verdict: { type: "string", enum: ["approve", "changes"] },
        findings: {
          type: "array",
          maxItems: 50,
          items: { type: "string", maxLength: 4000 },
          description: "Each required change (CHANGES), or notes (APPROVE).",
        },
        summary: { type: "string", maxLength: 4000 },
      },
      required: ["candidateId", "patchId", "verdict"],
      additionalProperties: false,
    },
  },
];

function git(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, input, maxBuffer: PATCH_MAX_BYTES + 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.toString().trim() || result.status}`);
  return result.stdout;
}

/** The exact candidate this checkout would land: its patch bytes and verbatim patch-id. */
export function readCandidatePatch(cwd, baseRef = "origin/main") {
  const head = git(cwd, ["rev-parse", "HEAD"]).toString().trim();
  const base = git(cwd, ["merge-base", "HEAD", baseRef]).toString().trim();
  const patch = git(cwd, ["diff", "--binary", base, head]);
  if (!patch.length) throw new Error(`HEAD has no committed change on top of ${baseRef}.`);
  if (patch.length > PATCH_MAX_BYTES)
    throw new Error(`The patch is ${patch.length} bytes; review candidates hold at most ${PATCH_MAX_BYTES}.`);
  const patchId = git(cwd, ["patch-id", "--verbatim"], patch).toString().split(" ")[0];
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"]).toString().trim() !== "";
  return { base, head, patch, patchId, dirty };
}

const text = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  isError,
});

/**
 * Handlers for the review tools. `request(route, suffix, init)` reaches this
 * pane's seat routes with its native proof, exactly as peer messages do.
 */
export function createReviewTools({ request, cwd = () => process.cwd(), patchDirectory }) {
  const call = async (route, suffix, init) => {
    const response = await request(route, suffix, init);
    const body = await response.text();
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      value = { error: `HTTP ${response.status}`, detail: body.slice(0, 500) };
    }
    return { ok: response.ok, value };
  };
  return {
    async submit(args) {
      let candidate;
      try {
        candidate = readCandidatePatch(cwd(), args?.base ?? "origin/main");
      } catch (error) {
        return text(`Nothing was submitted: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      const { ok, value } = await call("review-candidates", "", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          base: candidate.base,
          head: candidate.head,
          patchId: candidate.patchId,
          patch: candidate.patch.toString("base64"),
          summary: args?.summary,
          ...(args?.issue ? { issue: args.issue } : {}),
          evidence: Array.isArray(args?.evidence) ? args.evidence : [],
        }),
      });
      if (!ok) return text(value, true);
      return text({
        ...value,
        ...(candidate.dirty
          ? { note: "Your checkout has uncommitted changes; they are not part of this candidate." }
          : {}),
      });
    },
    async read(args) {
      const id = String(args?.candidateId ?? "");
      if (!/^[0-9a-f-]{36}$/iu.test(id)) return text("Use the candidate's UUID.", true);
      const { ok, value } = await call("review-candidates", `/${encodeURIComponent(id)}`);
      if (!ok) return text(value, true);
      const bytes = Buffer.from(value.patch, "base64");
      const directory = patchDirectory ?? join(homedir(), ".clankie", "review-patches");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${id}.patch`);
      writeFileSync(path, bytes, { mode: 0o600 });
      return text({
        candidate: value.candidate,
        patchFile: path,
        ...(bytes.length <= INLINE_PATCH_MAX_BYTES ? { patch: bytes.toString("utf8") } : {}),
      });
    },
    async verdict(args) {
      const { ok, value } = await call("review-verdicts", "", {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          candidateId: args?.candidateId,
          patchId: args?.patchId,
          verdict: args?.verdict,
          findings: Array.isArray(args?.findings) ? args.findings : [],
          ...(args?.summary ? { summary: args.summary } : {}),
        }),
      });
      return text(value, !ok);
    },
  };
}
