import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import type { SeatCommandOptions } from "./seat.ts";

/** Claude's project directory name for a working directory. */
function claudeProjectDirectory(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/gu, "-");
}

/** The config home a `claude` launch uses: the inherited CLAUDE_CONFIG_DIR, else ~/.claude. */
function claudeConfigHome(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(env.HOME ?? homedir(), ".claude");
}

function findTranscript(home: string, sessionId: string): { directory: string; path: string } | undefined {
  const projects = join(home, "projects");
  let entries: string[];
  try {
    entries = readdirSync(projects);
  } catch {
    return undefined;
  }
  const found = entries
    .map((directory) => ({ directory, path: join(projects, directory, `${sessionId}.jsonl`) }))
    .filter((candidate) => existsSync(candidate.path));
  if (found.length > 1)
    throw new Error(`Claude session ${sessionId} appears in more than one project under ${home}`);
  return found[0];
}

/** The session's own cwd, from its transcript records; Claude resumes a session only from its project. */
function transcriptCwd(path: string): string | undefined {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    const length = readSync(file, buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, length).toString("utf8").split("\n")) {
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
      } catch {
        // A partial final line or a non-record line.
      }
    }
    return undefined;
  } finally {
    closeSync(file);
  }
}

export interface ExplicitResume {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly cwd: string;
  /** A transcript copied from another config home into this launch's home. */
  readonly copy?: { readonly from: string; readonly to: string };
}

/**
 * `--resume SESSION_ID --conversation ID` (VUH-2045). The session must belong to
 * this launch's config home (or be copied in from `--from-config-dir`, never
 * overwriting), must not belong to another conversation or be retired, and the
 * conversation must have no live seat. Planning never copies; launch does.
 */
export async function planExplicitResume(
  input: {
    readonly sessionId: string;
    readonly conversationId: string;
    readonly fromConfigDir?: string;
    readonly dryRun: boolean;
  },
  options: SeatCommandOptions,
): Promise<ExplicitResume> {
  const env = options.env ?? process.env;
  const home = claudeConfigHome(env);
  let transcript = findTranscript(home, input.sessionId);
  let copy: ExplicitResume["copy"];
  if (transcript === undefined) {
    if (input.fromConfigDir === undefined)
      throw new Error(
        `Claude session ${input.sessionId} is not in ${home}. Pass --from-config-dir with the config home that holds it to copy it in.`,
      );
    const source = findTranscript(input.fromConfigDir, input.sessionId);
    if (source === undefined)
      throw new Error(`Claude session ${input.sessionId} is in neither ${home} nor ${input.fromConfigDir}.`);
    transcript = {
      directory: source.directory,
      path: join(home, "projects", source.directory, `${input.sessionId}.jsonl`),
    };
    copy = { from: source.path, to: transcript.path };
  }
  const cwd = transcriptCwd(copy?.from ?? transcript.path);
  if (cwd === undefined || claudeProjectDirectory(cwd) !== transcript.directory)
    throw new Error(
      `Claude session ${input.sessionId} has no working directory matching its project; it cannot be resumed here.`,
    );

  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("No operator credential is available; start Clankie first.");
  const url = new URL("/v1/captain/seat-context", commandHost({ ...options, env }));
  url.searchParams.set("conversationId", input.conversationId);
  url.searchParams.set("sessionId", input.sessionId);
  const response = await (options.fetchImpl ?? fetch)(url, {
    headers: { authorization: `Bearer ${credential.token}` },
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Seat conversation unavailable (${response.status})`);
  const context = (await response.json()) as {
    conversationId?: unknown;
    occupied?: unknown;
    session?: unknown;
  };
  if (context.conversationId !== input.conversationId) throw new Error("Invalid service seat context");
  if (context.session === "elsewhere")
    throw new Error(`Claude session ${input.sessionId} belongs to another conversation; resume it there.`);
  if (context.session === "retired")
    throw new Error(`Claude session ${input.sessionId} was retired from ${input.conversationId} by a reset.`);
  if (context.session !== "current" && context.session !== "unknown")
    throw new Error(
      "This service cannot check seat session ownership; update Clankie before resuming by ID.",
    );
  if (context.occupied === true)
    throw new Error(
      `${input.conversationId} already has a live seat. Close that seat's pane first, so one session drives it.`,
    );
  if (copy !== undefined && !input.dryRun) {
    mkdirSync(join(home, "projects", transcript.directory), { recursive: true, mode: 0o700 });
    // Never replace a transcript the target home already has.
    copyFileSync(copy.from, copy.to, constants.COPYFILE_EXCL);
  }
  return {
    sessionId: input.sessionId,
    conversationId: input.conversationId,
    cwd,
    ...(copy === undefined ? {} : { copy }),
  };
}
