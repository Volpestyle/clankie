import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  createDefaultCredentialStore,
} from "@clankie/credential-broker";
import { hostedOrigin } from "@clankie/protocol/hosted-pairing";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import { gatewayEnableWithAccount } from "./gateway.ts";
import { outputJson, type Writable } from "./io.ts";

/** Who this terminal talks to. Clankie always runs on the owner's own machine. */
export const THIS_MAC_CONNECTION = { mode: "local", label: "This Mac" } as const;

/**
 * `clankie login` and `clankie remote-access on`: sign in to the Clankie account
 * and open this Mac's remote-access doorway, so the phone reaches it through the
 * gateway.
 */
export async function loginThisMac(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  stdout: Writable = process.stdout,
) {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      email: { type: "string" },
      url: { type: "string", default: "https://api.clankie.bot" },
      "code-stdin": { type: "boolean" },
    },
  });
  if (positionals.length > 0)
    throw new Error("Usage: clankie login [--email EMAIL] [--url ORIGIN] [--code-stdin]");
  if (!process.stdin.isTTY && (values.email === undefined || !values["code-stdin"]))
    throw new Error("Headless sign-in requires --email EMAIL --code-stdin; enter the emailed code on stdin");
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: process.stdin.isTTY === true,
  });
  const pipedCode = process.stdin.isTTY ? undefined : input[Symbol.asyncIterator]().next();
  try {
    const email = values.email ?? (await input.question("Clankie account email: "));
    const gatewayUrl = hostedOrigin(values.url!);
    const challenge = await beginClankieAccountLogin({ gatewayUrl, email });
    const code =
      pipedCode === undefined
        ? await input.question("Code from your email: ")
        : (process.stderr.write("Enter the emailed code on stdin.\n"),
          (await pipedCode).value as string | undefined);
    if (!code) throw new Error("No email code supplied");
    const credential = await completeClankieAccountLogin({ challenge, code });
    const enabled = await gatewayEnableWithAccount(
      { gatewayUrl, credential },
      {
        env,
        settings: new SettingsStore(defaultSettingsPath(env)),
        credentials: createDefaultCredentialStore({ env }),
      },
    );
    outputJson(stdout, {
      ok: true,
      mode: "remote-access",
      hostId: enabled.hostId,
      message: "Signed this Mac in for remote access. Restart the captain to open the doorway.",
      restart: enabled.restart,
    });
  } finally {
    input.close();
  }
}

/** `clankie logout`: there is no separate client sign-in to end; remote access has its own off switch. */
export function logoutMessage() {
  return {
    ok: true,
    mode: "local",
    message: "To take this Mac off remote access, run `clankie remote-access off`.",
  };
}
