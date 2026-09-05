import { sourceHerdrSocket } from "../session/herdr-report.ts";
/**
 * `clankie stance` — how an agent moves its own figure in the commons
 * ([ADR 0148](../../../../docs/adr/0148-an-agent-moves-its-own-figure.md)).
 *
 * This one is written for an agent to run, not for a person. An agent working
 * in a Herdr pane already has a shell; this gives it a body in the room the
 * operator is watching, so what it is doing arrives as something seen rather
 * than only as a status another process observed about it.
 *
 * It takes no seat argument on purpose. The pane comes from `HERDR_PANE_ID` in
 * the caller's own environment and the service resolves the seat from the live
 * census, so the only figure this can move is the caller's own.
 */
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  OPERATOR_AGENT_STANCE_MAX_MS,
  HERDR_SOCKET_HEADER,
  OPERATOR_AGENT_STANCE_NOTE_MAX,
  OperatorAgentPoseSchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  type StateOperatorAgentStance,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

const POSES = OperatorAgentPoseSchema.options;

const STANCE_USAGE = [
  `Usage: clankie stance <${POSES.join("|")}> [--note TEXT] [--for SECONDS]`,
  "",
  "Says what you are doing with your own figure in the commons. The seat comes",
  "from HERDR_PANE_ID, so this only ever moves the figure you are sitting in.",
].join("\n");

export interface StanceCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly captainCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}

/** Flags are parsed here rather than in the dispatcher so the usage error is one string. */
export function parseStanceArgs(args: readonly string[], herdrPaneId: string): StateOperatorAgentStance {
  const pose = OperatorAgentPoseSchema.safeParse(args[0]);
  if (!pose.success) throw new Error(STANCE_USAGE);
  let note: string | undefined;
  let ttlMs: number | undefined;
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(STANCE_USAGE);
    if (flag === "--note") {
      if (value.length > OPERATOR_AGENT_STANCE_NOTE_MAX) {
        throw new Error(`--note is at most ${String(OPERATOR_AGENT_STANCE_NOTE_MAX)} characters`);
      }
      note = value;
      continue;
    }
    if (flag === "--for") {
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--for takes a number of seconds");
      ttlMs = Math.min(Math.round(seconds * 1000), OPERATOR_AGENT_STANCE_MAX_MS);
      continue;
    }
    throw new Error(STANCE_USAGE);
  }
  return {
    herdrPaneId,
    pose: pose.data,
    ...(note === undefined ? {} : { note }),
    ...(ttlMs === undefined ? {} : { ttlMs }),
  };
}

export async function runStanceCommand(
  args: readonly string[],
  options: StanceCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const herdrPaneId = env.HERDR_PANE_ID?.trim();
  if (herdrPaneId === undefined || herdrPaneId.length === 0) {
    // Not an error worth a stack trace: outside Herdr there is no figure to move.
    throw new Error("HERDR_PANE_ID is unset; a stance only means something from inside a Herdr pane.");
  }
  const stance = parseStanceArgs(args, herdrPaneId);
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  const token = credential?.token;
  if (token === undefined) {
    throw new Error("No captain credential is available; start the clankie service once first.");
  }
  const socket = await sourceHerdrSocket({ env });
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, commandHost({ ...options, env })),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(socket ? { [HERDR_SOCKET_HEADER]: socket } : {}),
      },
      redirect: "error",
      body: JSON.stringify({ op: "state_stance", schemaVersion: 1, stance }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
  const body = (await response.json()) as { readonly result?: unknown };
  outputJson(options.stdout ?? process.stdout, body.result ?? body);
  return 0;
}
