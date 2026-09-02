/**
 * `clankie prompt` — the words a lane's pi session starts from, readable
 * without one (VUH-1086). A seat launcher in another harness reads this once
 * at startup so it begins from the same identity, persona, reach, and address
 * the service lanes carry.
 *
 * Plain text on stdout, verbatim: the consumer is a system prompt, not a
 * parser. The section names are the service's own
 * (`CAPTAIN_PROMPT_SECTIONS`), repeated here because the TUI does not depend
 * on the service package; the route validates them again anyway.
 */
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { CaptainSessionLaneV2Schema, type CaptainSessionLaneV2 } from "@clankie/protocol";
import { commandHost, type Writable } from "./io.ts";

const PROMPT_SECTIONS = ["identity", "persona", "reach", "address", "model"] as const;
const LANES = CaptainSessionLaneV2Schema.options;
const LANE_READ_TIMEOUT_MS = 10_000;

const PROMPT_USAGE = [
  `Usage: clankie prompt [--lane <${LANES.join("|")}>] [--sections <${PROMPT_SECTIONS.join(",")}>]`,
  "",
  "Prints the system prompt that lane's session starts from. Default lane: operator.",
].join("\n");

export interface LaneReadCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}

/** Shared by `prompt` and `memory-card`: same bearer, same lane query, same verbatim stdout. */
export async function readLaneText(
  path: string,
  query: Readonly<Record<string, string>>,
  options: LaneReadCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const url = new URL(path, commandHost({ ...options, env }));
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const token = credential?.token;
  if (token === undefined) {
    throw new Error("No operator credential is available; `clankie status` reports this install's.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(LANE_READ_TIMEOUT_MS),
  });
  // The body may name a lane that is not this bearer's; the status is the whole report.
  if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
  (options.stdout ?? process.stdout).write(await response.text());
  return 0;
}

/** Flags are parsed here rather than in the dispatcher so the usage error is one string. */
export function parseLane(value: string, usage: string): CaptainSessionLaneV2 {
  const lane = CaptainSessionLaneV2Schema.safeParse(value);
  if (!lane.success) throw new Error(usage);
  return lane.data;
}

function parseSections(value: string): string {
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) throw new Error(PROMPT_USAGE);
  for (const name of names) {
    if (!PROMPT_SECTIONS.includes(name as (typeof PROMPT_SECTIONS)[number])) throw new Error(PROMPT_USAGE);
  }
  return names.join(",");
}

export async function runPromptCommand(
  args: readonly string[],
  options: LaneReadCommandOptions,
): Promise<number> {
  let lane: CaptainSessionLaneV2 = "operator";
  let sections: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(PROMPT_USAGE);
    if (flag === "--lane") {
      lane = parseLane(value, PROMPT_USAGE);
      continue;
    }
    if (flag === "--sections") {
      sections = parseSections(value);
      continue;
    }
    throw new Error(PROMPT_USAGE);
  }
  return await readLaneText(
    "/v1/captain/prompt",
    { lane, ...(sections === undefined ? {} : { sections }) },
    options,
  );
}
