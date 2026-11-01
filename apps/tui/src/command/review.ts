import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_REVIEWS_PATH,
  OPERATOR_REVIEW_LANDING_PATH,
  OPERATOR_REVIEW_WAIVERS_PATH,
  ReviewCandidateSchema,
  ReviewLandingSchema,
} from "@clankie/protocol/reviews";
import { realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { readLink, seatRoute } from "../../../../integrations/claude-plugin/worker/bin/link.mjs";
import {
  createReviewTools,
  readCandidatePatch,
} from "../../../../integrations/claude-plugin/worker/bin/review-tools.mjs";
import { commandHost } from "./io.ts";
import { seatIdentity } from "./seat-identity.ts";

export const REVIEW_USAGE =
  "Usage: clankie review list [--project ID] | show ID [--patch] | status [--directory DIR] [--base REF] | waive --reason TEXT [--directory DIR] [--base REF] | submit --checkout DIR --summary TEXT [--issue KEY] [--evidence URL]... [--base REF]";

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
  if (args[0] === "submit") return submitFromPane(args.slice(1), options);
  const env = options.env ?? process.env;
  const request = async (path: string, init: RequestInit = {}) => {
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential) throw new Error("Reviews need the operator credential. Run clankie doctor.");
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
      if (env.CLANKIE_INTEGRATE) {
        // The parent service reads its live review store for the source project.
        // The sandbox gets only that verdict, never owner credentials or HOME.
        const record = JSON.parse(env.CLANKIE_INTEGRATE_REVIEW ?? "null");
        const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
        const resolvedBase = execFileSync("git", ["rev-parse", base], {
          cwd: directory,
          encoding: "utf8",
        }).trim();
        const landing = ReviewLandingSchema.parse(record?.landing);
        if (record.head !== head || record.base !== resolvedBase || landing.patchId !== patchId)
          throw new Error("Integrate review does not cover this exact base, HEAD and patch; landing held.");
        return { ok: landing.landable, body: landing };
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

/**
 * An author's submit from its own pane, for a seat whose catalog lacks
 * submit_for_review (a harness without the review tools, or a bridge that
 * predates them; VUH-2662). The pane's fleet link proves the author exactly as
 * the review tools do; the operator credential plays no part.
 */
async function submitFromPane(
  args: readonly string[],
  options: ReviewCommandOptions,
): Promise<{ ok: boolean; body: unknown }> {
  const env = options.env ?? process.env;
  const values = new Map<string, string>();
  const evidence: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]!;
    const value = args[index + 1];
    if (value === undefined || !["--checkout", "--summary", "--issue", "--evidence", "--base"].includes(flag))
      throw new Error(REVIEW_USAGE);
    if (flag === "--evidence") evidence.push(value);
    else if (values.has(flag)) throw new Error(REVIEW_USAGE);
    else values.set(flag, value);
  }
  const seat = seatIdentity(env);
  const link = readLink(seat.socket, env);
  const pane = seat.pane;
  if (!link || !pane)
    throw new Error(
      "Run clankie review submit in your own fleet pane: its link proves you are the author, as submit_for_review does.",
    );
  const tools = createReviewTools({
    request: (route, suffix = "", init) =>
      (options.fetchImpl ?? fetch)(`${seatRoute(link, pane, route).href}${suffix}`, {
        ...init,
        headers: {
          ...(link.authentication === "local-process"
            ? { "x-clankie-pane": pane }
            : { authorization: `Bearer ${link.token ?? ""}` }),
          "content-type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }),
  });
  const result = (await tools.submit({
    checkout: values.get("--checkout"),
    summary: values.get("--summary"),
    ...(values.has("--issue") ? { issue: values.get("--issue") } : {}),
    ...(values.has("--base") ? { base: values.get("--base") } : {}),
    evidence,
  })) as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? "";
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* plain refusal text */
  }
  return { ok: result.isError !== true, body };
}
