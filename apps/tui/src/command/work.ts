import { randomUUID } from "node:crypto";
import {
  WorkItemWriteRequestSchema,
  WorkItemWriteReceiptRequestSchema,
  WorkItemWriteReceiptSchema,
} from "@clankie/protocol/work-item-write";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { WorkItemPrioritySchema } from "@clankie/protocol/work-items";
import { commandHost } from "./io.ts";

const WORK_USAGE = [
  "Usage: clankie work [status|discover] | repos | init [--backend default|markdown|github|linear] [--directory D]",
  "  [--github-repo OWNER/NAME] [--linear-team KEY] [--linear-project NAME] [--linear-label LABEL] [--release-source tags|milestones|both] [--release-lane NAME] [--note TEXT]",
  "  | project | list [--status S,S] [--owner O] [--label L] | show ID | activity ID | create TITLE [--summary S] [--owner O] [--criterion C]... [--status S] [--priority 0..4|none|urgent|high|medium|low]",
  "  | update ID [--status S] [--priority P] [--owner O | --no-owner] [--title T] [--check N]... [--uncheck N]... [--add-criterion C]...",
  "  | write ID --owner O|--no-owner|--add-label L|--remove-label L|--add-blocker ID [--request-id UUID] | receipt ID --request-id UUID",
  "  | close ID [--canceled] | attach ID --url URL --caption TEXT [--kind image|video|log|link]",
  "  Every command takes --repo PATH (default: the git repo containing the current directory).",
].join("\n");

const execFileAsync = promisify(execFile);

function inferKind(url: string): "image" | "video" | "log" | "link" {
  const path = url.split(/[?#]/u)[0]!.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|heic|avif)$/u.test(path)) return "image";
  if (/\.(mp4|mov|webm|m4v)$/u.test(path)) return "video";
  if (/\.(log|txt|jsonl?|out)$/u.test(path)) return "log";
  return "link";
}

interface Parsed {
  readonly positional: string[];
  readonly flags: Map<string, string[]>;
}

const BOOLEAN_FLAGS = new Set(["--no-owner", "--canceled"]);

export function parseWorkArgs(args: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      if (BOOLEAN_FLAGS.has(arg)) {
        flags.set(arg, ["true"]);
        continue;
      }
      const value = args[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value\n${WORK_USAGE}`);
      flags.set(arg, [...(flags.get(arg) ?? []), value]);
      i += 1;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const one = (parsed: Parsed, flag: string) => parsed.flags.get(flag)?.at(-1);
const many = (parsed: Parsed, flag: string) => parsed.flags.get(flag) ?? [];
const numbers = (parsed: Parsed, flag: string) =>
  many(parsed, flag).flatMap((value) =>
    value.split(",").map((part) => {
      const number = Number(part.trim());
      if (!Number.isInteger(number) || number < 1)
        throw new Error(`${flag} takes criterion numbers (1-based)`);
      return number;
    }),
  );

/** Builds the service request for `clankie work ...`; the repo is resolved by the caller. */
export function workRequest(args: readonly string[], repo: string): Record<string, unknown> {
  const parsed = parseWorkArgs(args);
  const [verb = "status", ...rest] = parsed.positional;
  if (parsed.flags.has("--linear-label") && verb !== "init")
    throw new Error("--linear-label only applies to init");
  const status = one(parsed, "--status");
  const rawPriority = one(parsed, "--priority");
  const priority =
    rawPriority === undefined
      ? undefined
      : WorkItemPrioritySchema.parse(
          /^\d+$/u.test(rawPriority)
            ? Number(rawPriority)
            : ["none", "urgent", "high", "medium", "low"].indexOf(rawPriority.toLowerCase()),
        );
  switch (verb) {
    case "status":
    case "discover":
      return { action: "discover", repo };
    case "repos":
      return { action: "repos" };
    case "init":
      return {
        action: "init",
        repo,
        ...(one(parsed, "--backend") === undefined ? {} : { backend: one(parsed, "--backend") }),
        ...(one(parsed, "--directory") === undefined ? {} : { directory: one(parsed, "--directory") }),
        ...(one(parsed, "--github-repo") === undefined ? {} : { githubRepo: one(parsed, "--github-repo") }),
        ...(one(parsed, "--linear-team") === undefined ? {} : { linearTeam: one(parsed, "--linear-team") }),
        ...(one(parsed, "--linear-project") === undefined
          ? {}
          : { linearProject: one(parsed, "--linear-project") }),
        ...(one(parsed, "--linear-label") === undefined
          ? {}
          : { linearLabel: one(parsed, "--linear-label") }),
        ...(one(parsed, "--release-source") === undefined
          ? {}
          : { releaseSource: one(parsed, "--release-source") }),
        ...(one(parsed, "--release-lane") === undefined
          ? {}
          : { releaseLane: one(parsed, "--release-lane") }),
        ...(one(parsed, "--note") === undefined ? {} : { note: one(parsed, "--note") }),
      };
    case "project":
      return { action: "project", repo };
    case "list":
      return {
        action: "list",
        repo,
        ...(status === undefined ? {} : { status: status.split(",").map((value) => value.trim()) }),
        ...(one(parsed, "--owner") === undefined ? {} : { owner: one(parsed, "--owner") }),
        ...(one(parsed, "--label") === undefined ? {} : { label: one(parsed, "--label") }),
      };
    case "show":
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      return { action: "show", repo, id: rest[0] };
    case "activity":
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      return { action: "activity", repo, id: rest[0] };
    case "create":
      if (rest.length === 0) throw new Error(WORK_USAGE);
      return {
        action: "create",
        repo,
        title: rest.join(" "),
        ...(one(parsed, "--summary") === undefined ? {} : { summary: one(parsed, "--summary") }),
        ...(one(parsed, "--owner") === undefined ? {} : { owner: one(parsed, "--owner") }),
        ...(many(parsed, "--criterion").length === 0 ? {} : { criteria: many(parsed, "--criterion") }),
        ...(status === undefined ? {} : { status }),
        ...(priority === undefined ? {} : { priority }),
      };
    case "update":
    case "close": {
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      const closing = verb === "close";
      return {
        action: "update",
        repo,
        id: rest[0],
        ...(priority === undefined ? {} : { priority }),
        ...(closing
          ? { status: one(parsed, "--canceled") === "true" ? "canceled" : "done" }
          : status === undefined
            ? {}
            : { status }),
        ...(one(parsed, "--no-owner") === "true"
          ? { owner: null }
          : one(parsed, "--owner") === undefined
            ? {}
            : { owner: one(parsed, "--owner") }),
        ...(one(parsed, "--title") === undefined ? {} : { title: one(parsed, "--title") }),
        ...(numbers(parsed, "--check").length === 0 ? {} : { check: numbers(parsed, "--check") }),
        ...(numbers(parsed, "--uncheck").length === 0 ? {} : { uncheck: numbers(parsed, "--uncheck") }),
        ...(many(parsed, "--add-criterion").length === 0
          ? {}
          : { addCriteria: many(parsed, "--add-criterion") }),
      };
    }
    case "write": {
      if (rest.length !== 1) throw new Error(WORK_USAGE);
      const commands = [
        ...(one(parsed, "--owner") === undefined
          ? []
          : [{ action: "assign", owner: one(parsed, "--owner") }]),
        ...(one(parsed, "--no-owner") === "true" ? [{ action: "assign", owner: null }] : []),
        ...(one(parsed, "--add-label") === undefined
          ? []
          : [{ action: "add_label", label: one(parsed, "--add-label") }]),
        ...(one(parsed, "--remove-label") === undefined
          ? []
          : [{ action: "remove_label", label: one(parsed, "--remove-label") }]),
        ...(one(parsed, "--add-blocker") === undefined
          ? []
          : [{ action: "add_dependency", id: one(parsed, "--add-blocker") }]),
      ];
      if (commands.length !== 1) throw new Error("Choose exactly one work-item write operation.");
      const allowed = new Set([
        "--owner",
        "--no-owner",
        "--add-label",
        "--remove-label",
        "--add-blocker",
        "--request-id",
        "--free-agent",
        "--work-handoff",
      ]);
      for (const [flag, values] of parsed.flags)
        if (!allowed.has(flag) || values.length !== 1) throw new Error(WORK_USAGE);
      return {
        action: "write",
        request: {
          repoId: repo,
          itemId: rest[0],
          requestId: one(parsed, "--request-id") ?? randomUUID(),
          command: commands[0],
          ...(one(parsed, "--free-agent") === undefined
            ? {}
            : { freeAgent: JSON.parse(one(parsed, "--free-agent")!) }),
          ...(one(parsed, "--work-handoff") === undefined
            ? {}
            : { workHandoff: JSON.parse(one(parsed, "--work-handoff")!) }),
        },
      };
    }
    case "receipt": {
      if (rest.length !== 1 || !one(parsed, "--request-id")) throw new Error(WORK_USAGE);
      return {
        action: "write_receipt",
        request: { repoId: repo, itemId: rest[0], requestId: one(parsed, "--request-id") },
      };
    }
    case "attach": {
      const url = one(parsed, "--url");
      const caption = one(parsed, "--caption");
      if (rest[0] === undefined || url === undefined || caption === undefined) throw new Error(WORK_USAGE);
      return {
        action: "attach",
        repo,
        id: rest[0],
        evidence: { kind: one(parsed, "--kind") ?? inferKind(url), url, caption },
      };
    }
    default:
      throw new Error(WORK_USAGE);
  }
}

async function repoRoot(explicit: string | undefined, cwd: string): Promise<string> {
  if (explicit !== undefined && !explicit.startsWith("/")) return explicit; // a registered repo id
  const start = resolve(cwd, explicit ?? ".");
  try {
    return (
      await execFileAsync("git", ["rev-parse", "--show-toplevel"], { cwd: start, timeout: 10_000 })
    ).stdout.trim();
  } catch {
    return start;
  }
}

/**
 * `clankie work`: the one tracking contract every agent on this machine uses
 * (ADR 0191). JSON out; the service decides where items live.
 */
export async function runWorkCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly fetchImpl?: typeof fetch;
    readonly cwd?: string;
  } = {},
): Promise<{ readonly ok: boolean; readonly body: unknown }> {
  const env = options.env ?? process.env;
  const parsed = parseWorkArgs(args);
  const repo = await repoRoot(one(parsed, "--repo"), options.cwd ?? process.cwd());
  const withoutRepo = args.filter((arg, index) => arg !== "--repo" && args[index - 1] !== "--repo");
  const request = workRequest(withoutRepo, repo);
  const credential = await resolveOperatorCredential({ env });
  if (!credential) throw new Error("Work tracking needs the operator credential. Run clankie doctor.");
  const fetcher = options.fetchImpl ?? fetch;
  const endpoint = `${commandHost({ env })}/v1/work`;
  const headers = { authorization: `Bearer ${credential.token}`, "content-type": "application/json" };
  const writing = request.action === "write";
  const journaled = writing || request.action === "write_receipt";
  const input = journaled
    ? (request.request as { repoId: string; itemId: string; requestId: string })
    : undefined;
  if (input && repo.startsWith("/")) {
    const response = await fetcher(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "repos" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error("Cannot read registered work repositories.");
    const inventory = (await response.json()) as { repos?: { id: string; root?: string }[] };
    const registered = inventory.repos?.find((entry) => entry.root === repo);
    if (!registered)
      return {
        ok: false,
        body: {
          requestId: input.requestId,
          outcome: "refused",
          message: "Register this repository with clankie work status before writing.",
        },
      };
    input.repoId = registered.id;
  }
  if (input)
    request.request = writing
      ? WorkItemWriteRequestSchema.parse(input)
      : WorkItemWriteReceiptRequestSchema.parse(input);
  try {
    const response = await fetcher(endpoint, {
      method: "POST",
      body: JSON.stringify(request),
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await response.json()) as unknown;
    if (writing && input) {
      const parsedReceipt = WorkItemWriteReceiptSchema.safeParse(body);
      if (parsedReceipt.success)
        return { ok: parsedReceipt.data.outcome === "applied", body: parsedReceipt.data };
      return {
        ok: false,
        body: {
          requestId: input.requestId,
          outcome: response.status >= 400 && response.status < 500 ? "refused" : "uncertain",
          message:
            response.status >= 400 && response.status < 500
              ? "The owner-authorized work-item write was refused."
              : "The response was lost. Read this receipt and the tracker; never resend this request.",
        },
      };
    }
    return { ok: response.ok, body };
  } catch (error) {
    if (!writing || !input) throw error;
    return {
      ok: false,
      body: {
        requestId: input.requestId,
        outcome: "uncertain",
        message: "The write may have happened. Read this receipt and the tracker; never resend this request.",
      },
    };
  }
}
