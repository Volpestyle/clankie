import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The landing gate's review phase (ADR 0287). Asks the service whether this
 * checkout's exact patch may land: its project names no reviewer, or the
 * reviewer approved (or the owner or lead waived) exactly this patch-id.
 *
 * Returns `{ state: "landable" | "held" | "skipped" | "unavailable", ... }`.
 * Without a reachable service the gate holds only when the owner's settings
 * name a reviewer for some project; CI has neither and skips.
 */
export function landingReview(root, base) {
  const cli = spawnSync(
    process.execPath,
    [join(root, "apps/tui/bin/clankie.ts"), "review", "status", "--directory", root, "--base", base],
    { cwd: root, encoding: "utf8", timeout: 60_000, env: process.env },
  );
  let landing;
  try {
    landing = JSON.parse(cli.stdout);
  } catch {
    landing = undefined;
  }
  if (landing?.schemaVersion === 1 && typeof landing.landable === "boolean")
    return landing.landable
      ? { state: landing.required ? "landable" : "skipped", landing }
      : { state: "held", landing };
  const detail = [cli.stdout, cli.stderr, cli.error?.message, `exit ${cli.status}`]
    .filter(Boolean)
    .join("\n")
    .trim()
    .slice(-500);
  // A service from before the review gate cannot hold a reviewer setting.
  if (/reviews_unavailable|reviews_unsupported/u.test(detail))
    return { state: "skipped", reason: "the service predates the review gate", detail };
  if (process.env.CI) return { state: "skipped", reason: "CI has no Clankie service", detail };
  if (!ownerNamesAReviewer()) return { state: "skipped", reason: "no project names a reviewer", detail };
  return { state: "unavailable", reason: "review status is unavailable", detail };
}

function ownerNamesAReviewer() {
  const path =
    process.env.CLANKIE_SETTINGS_FILE ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "clankie", "settings.json");
  try {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    return (settings?.projects?.projects ?? []).some((project) => project?.review !== undefined);
  } catch {
    return false;
  }
}

/** One line telling the author what to do next. */
export function landingReviewMessage(review) {
  if (review.state === "landable")
    return `[landing] review: ${review.landing.status} for patch ${review.landing.patchId} (candidate ${review.landing.candidate?.id})`;
  if (review.state === "skipped") return `[landing] review: not required (${review.reason ?? "no reviewer"})`;
  if (review.state === "held")
    return review.landing.status === "changes"
      ? `[landing] review: CHANGES on patch ${review.landing.patchId}; make the required changes, commit and submit_for_review again`
      : review.landing.status === "not_submitted"
        ? `[landing] review: project ${review.landing.projectId} requires review; checks are green, so submit_for_review, then run pnpm check:landing --revalidate after APPROVE`
        : `[landing] review: ${review.landing.status} for patch ${review.landing.patchId} (candidate ${review.landing.candidate?.id}); run pnpm check:landing --revalidate after APPROVE`;
  return `[landing] review: ${review.reason}; landing held. ${review.detail ?? ""}`.trim();
}
