import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The landing gate's review phase (ADR 0287). Asks the service whether this
 * checkout's exact patch may land: its project names no reviewer, or the
 * reviewer approved (or the owner or lead waived) exactly this patch-id.
 *
 * Returns `{ state: "landable" | "held" | "skipped" | "unavailable", checkout, ... }`;
 * `checkout` is the root the author names to submit_for_review (VUH-2662).
 * An unavailable verdict holds locally and in integrate. Only external CI
 * with no owner settings may skip an unavailable service.
 */
export function landingReview(root, base) {
  return { ...reviewState(root, base), checkout: root };
}

function reviewState(root, base) {
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
  if (!process.env.CLANKIE_INTEGRATE && process.env.CI && !ownerSettingsPresent())
    return { state: "skipped", reason: "external CI has no owner settings", detail };
  return { state: "unavailable", reason: "review status is unavailable", detail };
}

function ownerSettingsPresent() {
  const path =
    process.env.CLANKIE_SETTINGS_FILE ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "clankie", "settings.json");
  try {
    readFileSync(path, "utf8");
    return true;
  } catch (error) {
    // An unreadable settings file is not evidence that this is external CI.
    return error.code !== "ENOENT";
  }
}

/** One line telling the author what to do next. */
export function landingReviewMessage(review) {
  const candidate = review.landing?.candidate ? ` (candidate ${review.landing.candidate.id})` : "";
  if (review.state === "landable")
    return `[landing] review: ${review.landing.status} for patch ${review.landing.patchId}${candidate}`;
  if (review.state === "skipped") return `[landing] review: not required (${review.reason ?? "no reviewer"})`;
  if (review.state === "held")
    return review.landing.status === "changes"
      ? `[landing] review: CHANGES on patch ${review.landing.patchId}; make the required changes, commit and submit_for_review again`
      : review.landing.status === "not_submitted"
        ? `[landing] review: project ${review.landing.projectId} requires review; checks are green, so submit_for_review with checkout ${JSON.stringify(review.checkout)} (no such tool in your catalog? from this pane run: clankie review submit --checkout ${JSON.stringify(review.checkout)} --issue KEY --summary TEXT), then run pnpm check:landing --revalidate after APPROVE`
        : `[landing] review: ${review.landing.status} for patch ${review.landing.patchId}${candidate}; run pnpm check:landing --revalidate after APPROVE`;
  return `[landing] review: ${review.reason}; landing held. ${review.detail ?? ""}`.trim();
}
