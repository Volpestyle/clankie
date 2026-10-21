import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_REVIEWS_PATH,
  OPERATOR_REVIEW_LANDING_PATH,
  OPERATOR_REVIEW_WAIVERS_PATH,
  ReviewCandidateSchema,
  ReviewLandingSchema,
} from "@clankie/protocol/reviews";
import { realpath } from "node:fs/promises";
import { readCandidatePatch } from "../../../../integrations/claude-plugin/worker/bin/review-tools.mjs";
import { commandHost } from "./io.ts";

export const REVIEW_USAGE =
  "Usage: clankie review list [--project ID] | show ID [--patch] | status [--directory DIR] [--base REF] | waive --reason TEXT [--directory DIR] [--base REF]";

export interface ReviewCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly cwd?: string;
}

function flags(args: readonly string[], allowed: readonly string[], booleans: readonly string[] = []) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]!;
    if (booleans.includes(flag)) {
      values.set(flag, "true");
      continue;
    }
    const value = args[index + 1];
    if (!allowed.includes(flag) || value === undefined || values.has(flag)) throw new Error(REVIEW_USAGE);
    values.set(flag, value);
    index += 1;
  }
  return values;
}

/**
 * The owner's side of the standing review gate (ADR 0287). Authors submit and
 * reviewers decide from their seats' own tools; this reads candidates, answers
 * the landing gate's question for a checkout, and records an owner waiver.
 */
export async function runReviewCommand(
  args: readonly string[],
  options: ReviewCommandOptions = {},
): Promise<{ ok: boolean; body: unknown }> {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Reviews need the operator credential. Run clankie doctor.");
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost({ ...options, env })), {
      ...init,
      headers: {
        authorization: `Bearer ${credential.token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, body };
  };
  const [action, ...rest] = args;
  if (action === "list") {
    const values = flags(rest, ["--project"]);
    const project = values.get("--project");
    const result = await request(
      `${OPERATOR_REVIEWS_PATH}${project === undefined ? "" : `?project=${encodeURIComponent(project)}`}`,
    );
    return { ok: result.status === 200, body: result.body };
  }
  if (action === "show") {
    const [id, ...more] = rest;
    if (!id) throw new Error(REVIEW_USAGE);
    const patch = flags(more, [], ["--patch"]).has("--patch");
    const result = await request(
      `${OPERATOR_REVIEWS_PATH}/${encodeURIComponent(id)}${patch ? "?patch=true" : ""}`,
    );
    if (result.status === 200 && typeof result.body === "object" && result.body !== null) {
      const body = result.body as { candidate: unknown; patch?: string };
      return {
        ok: true,
        body: {
          candidate: ReviewCandidateSchema.parse(body.candidate),
          ...(body.patch === undefined ? {} : { patch: Buffer.from(body.patch, "base64").toString("utf8") }),
        },
      };
    }
    return { ok: false, body: result.body };
  }
  if (action === "status" || action === "waive") {
    const values = flags(rest, ["--directory", "--base", ...(action === "waive" ? ["--reason"] : [])]);
    const directory = await realpath(values.get("--directory") ?? options.cwd ?? process.cwd());
    const base = values.get("--base") ?? "origin/main";
    if (action === "status") {
      let patchId = "empty";
      try {
        patchId = readCandidatePatch(directory, base).patchId;
      } catch (error) {
        if (!(error instanceof Error && error.message.startsWith("HEAD has no committed change")))
          throw error;
      }
      const result = await request(
        `${OPERATOR_REVIEW_LANDING_PATH}?${new URLSearchParams({ directory, patchId }).toString()}`,
      );
      // A service from before the review gate has no such route (ADR 0287).
      if (result.status === 404) return { ok: false, body: { error: "reviews_unsupported" } };
      if (result.status !== 200) return { ok: false, body: result.body };
      const landing = ReviewLandingSchema.parse(result.body);
      return { ok: landing.landable, body: landing };
    }
    const reason = values.get("--reason");
    if (!reason?.trim())
      throw new Error("A waiver needs --reason: who waived it and why stay on the record.");
    const candidate = readCandidatePatch(directory, base);
    const result = await request(OPERATOR_REVIEW_WAIVERS_PATH, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        directory,
        base: candidate.base,
        head: candidate.head,
        patchId: candidate.patchId,
        patch: candidate.patch.toString("base64"),
        reason,
      }),
    });
    return { ok: result.status === 200, body: result.body };
  }
  throw new Error(REVIEW_USAGE);
}
