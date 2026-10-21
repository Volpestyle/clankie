import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  LOCAL_COMPANION_TRUSTED_APPS_PATH,
  TrustedCompanionAppsResponseSchema,
} from "@clankie/protocol/local-companion";
import { commandHost } from "./io.ts";

const run = promisify(execFile);
const USAGE = "Usage: clankie companion trust APP_PATH [--label TEXT] | list | remove ID";

/**
 * Which apps on this Mac may take the same-Mac companion handoff (VUH-2604).
 * `trust` records the app's designated requirement: team and bundle id for a
 * Developer ID build, its exact code hash for an ad-hoc build.
 */
export async function runCompanionCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<unknown> {
  const env = options.env ?? process.env;
  let body: unknown;
  if (args.length === 1 && args[0] === "list") body = { op: "list" };
  else if (args.length === 2 && args[0] === "remove") body = { op: "remove", id: args[1] };
  else if (args[0] === "trust" && (args.length === 2 || (args.length === 4 && args[2] === "--label"))) {
    const path = args[1]!;
    // A strict check first: a broken or unsigned bundle is never trusted.
    await run("codesign", ["--verify", "--strict", path]).catch(() => {
      throw new Error(`${path} is not a validly signed app`);
    });
    const printed = await run("codesign", ["-d", "-r-", path]);
    const requirement = `${printed.stdout}\n${printed.stderr}`;
    const designated =
      /^# designated => (.+)$/mu.exec(requirement)?.[1] ?? /^designated => (.+)$/mu.exec(requirement)?.[1];
    const { stderr: details } = await run("codesign", ["-dv", "--verbose=2", path]);
    const field = (name: string) => new RegExp(`^${name}=(.+)$`, "mu").exec(details)?.[1]?.trim();
    const identifier = field("Identifier");
    const teamId = field("TeamIdentifier");
    if (!designated || !identifier) throw new Error(`${path} has no designated requirement`);
    body = {
      op: "add",
      app: {
        label: args[3] ?? identifier,
        requirement: designated.trim(),
        identifier,
        ...(teamId === undefined || teamId === "not set" ? {} : { teamId }),
      },
    };
  } else throw new Error(USAGE);
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw new Error("No operator credential is available");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(LOCAL_COMPANION_TRUSTED_APPS_PATH, commandHost({ ...options, env })),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(`Trusted companion apps request failed (${response.status}): ${JSON.stringify(result)}`);
  return TrustedCompanionAppsResponseSchema.parse(result);
}
