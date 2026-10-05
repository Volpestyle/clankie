import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import {
  ACTIVITY_SHARES_PATH,
  ActivitySharingRequestSchema,
  type ActivitySharingRequest,
} from "@clankie/protocol/activity-sharing";
import type { FaceShellCommand } from "../shell/shell.ts";

/** Local owner control. Viewer credentials are separate, read-only and short-lived. */
export async function runShareCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    /** The existing encrypted paired-device route for a hosted connection. */
    request?: (path: string, body: ActivitySharingRequest) => Promise<unknown>;
  } = {},
): Promise<{ ok: boolean; body: unknown }> {
  let input: unknown;
  if (args.length === 0 || (args.length === 1 && args[0] === "list")) input = { action: "list" };
  else if (args[0] === "request" && args.length === 2) input = JSON.parse(args[1]!);
  else throw new Error("Usage: clankie share [list | request JSON]");
  const request = ActivitySharingRequestSchema.parse(input);
  if (options.request) return { ok: true, body: await options.request(ACTIVITY_SHARES_PATH, request) };
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error("Sharing needs the operator credential. Run clankie doctor.");
  const response = await (options.fetchImpl ?? fetch)(
    `${commandHost({ ...options, env })}${ACTIVITY_SHARES_PATH}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(10_000),
    },
  );
  return { ok: response.ok, body: await response.json() };
}

/** CLI and both consoles send the same request and preserve its receipt. */
export function shareConsoleCommand(
  run: (args: readonly string[]) => Promise<{ ok: boolean; body: unknown }> = runShareCommand,
): FaceShellCommand {
  return {
    name: "share",
    aliases: [],
    description: "Control Activity shares",
    argumentHint: "[list | request JSON]",
    takesArgument: true,
    async run(argument, shell) {
      try {
        const input = argument.trim();
        const result = await run(
          input.startsWith("request ") ? ["request", input.slice(8)] : input.length === 0 ? [] : [input],
        );
        shell.insertCommandResult(
          "/share",
          JSON.stringify(result.body, null, 2),
          result.ok ? "success" : "error",
        );
      } catch (error) {
        shell.insertCommandResult("/share", error instanceof Error ? error.message : String(error), "error");
      }
    },
  };
}
