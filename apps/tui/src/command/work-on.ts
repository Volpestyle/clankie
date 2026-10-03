import { sourceHerdrSocket } from "../session/herdr-report.ts";
import { resolveCaptainCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  HERDR_SOCKET_HEADER,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  StateOperatorAgentWorkSchema,
  type StateOperatorAgentWork,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

const WORK_USAGE = "Usage: clankie work-on TITLE [--repo REPO_ID --issue ISSUE_ID] | clear";
export interface WorkOnCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly captainCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
}
export function parseWorkOnArgs(args: readonly string[], herdrPaneId: string): StateOperatorAgentWork {
  if (args.length === 1 && args[0] === "clear") return { herdrPaneId, assignment: null };
  const [objective, ...flags] = args;
  if (!objective || flags.length % 2 !== 0) throw new Error(WORK_USAGE);
  let repoId: string | undefined;
  let itemId: string | undefined;
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] === "--repo" && repoId === undefined) repoId = flags[i + 1];
    else if (flags[i] === "--issue" && itemId === undefined) itemId = flags[i + 1];
    else throw new Error(WORK_USAGE);
  }
  if ((repoId === undefined) !== (itemId === undefined))
    throw new Error("--repo and --issue are supplied together");
  return StateOperatorAgentWorkSchema.parse({
    herdrPaneId,
    assignment: { objective, ...(repoId === undefined ? {} : { issue: { repoId, itemId } }) },
  });
}

export async function runWorkOnCommand(
  args: readonly string[],
  options: WorkOnCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const herdrPaneId = env.HERDR_PANE_ID?.trim();
  if (herdrPaneId === undefined || herdrPaneId.length === 0) {
    // Not an error worth a stack trace: outside Herdr there is no figure to move.
    throw new Error("HERDR_PANE_ID is unset; work-on is available from inside a Herdr pane.");
  }
  const work = parseWorkOnArgs(args, herdrPaneId);
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
      body: JSON.stringify({ op: "state_work", schemaVersion: 1, work }),
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`clankie service returned ${String(response.status)}`);
  const body = (await response.json()) as { readonly result?: { readonly outcome?: string } };
  outputJson(options.stdout ?? process.stdout, body.result ?? body);
  return body.result?.outcome === "unseated" ? 1 : 0;
}
