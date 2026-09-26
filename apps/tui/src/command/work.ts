import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

const WORK_USAGE = [
  "Usage: clankie work [status|discover] | repos | init [--backend default|markdown|github|linear] [--directory D]",
  "  [--github-repo OWNER/NAME] [--linear-team KEY] [--linear-project NAME] [--note TEXT]",
  "  | list [--status S,S] [--owner O] | show ID | create TITLE [--summary S] [--owner O] [--criterion C]... [--status S]",
  "  | update ID [--status S] [--owner O | --no-owner] [--title T] [--check N]... [--uncheck N]... [--add-criterion C]...",
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
  const status = one(parsed, "--status");
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
        ...(one(parsed, "--note") === undefined ? {} : { note: one(parsed, "--note") }),
      };
    case "list":
      return {
        action: "list",
        repo,
        ...(status === undefined ? {} : { status: status.split(",").map((value) => value.trim()) }),
        ...(one(parsed, "--owner") === undefined ? {} : { owner: one(parsed, "--owner") }),
      };
    case "show":
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      return { action: "show", repo, id: rest[0] };
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
      };
    case "update":
    case "close": {
      if (rest[0] === undefined) throw new Error(WORK_USAGE);
      const closing = verb === "close";
      return {
        action: "update",
        repo,
        id: rest[0],
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
  const response = await (options.fetchImpl ?? fetch)(`${commandHost({ env })}/v1/work`, {
    method: "POST",
    body: JSON.stringify(request),
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` }))) as unknown;
  return { ok: response.ok, body };
}
