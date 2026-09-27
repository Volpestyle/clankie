import { runAccountsCommand } from "./accounts.ts";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  createDefaultCredentialStore,
} from "@clankie/credential-broker";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import {
  createHostedTransport,
  disconnectHosted,
  hostedOrigin,
  loadHostedSession,
  pairHostedAccount,
} from "../hosted-session.ts";
import { outputJson, type Writable } from "./io.ts";

export async function connectHostedCli(
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
  if (positionals.length !== 1 || positionals[0] !== "hosted")
    throw new Error("Usage: clankie connect hosted [--email EMAIL] [--url ORIGIN] [--code-stdin]");
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
    const store = createDefaultCredentialStore({ env }),
      settings = new SettingsStore(defaultSettingsPath(env));
    const session = await pairHostedAccount({ gatewayUrl, credential, store, settings });
    outputJson(stdout, {
      ok: true,
      mode: "hosted",
      hostId: session.encryption.hostId,
      deviceId: session.deviceId,
    });
  } finally {
    input.close();
  }
}
export async function disconnectHostedCli(env: NodeJS.ProcessEnv = process.env) {
  await disconnectHosted(new SettingsStore(defaultSettingsPath(env)), createDefaultCredentialStore({ env }));
  return {
    ok: true,
    mode: "local",
    message:
      "Disconnected this Mac. Hosted work continues. Revoke the device from your account to remove its access.",
  };
}
export const HOSTED_LOCAL_ONLY = new Set([
  "restart",
  "down",
  "autostart",
  "herdr",
  "discord",
  "voice",
  "gateway",
  "operator-credential",
  "seat",
  "seat-sync",
  "mcp",
  "telemetry",
  "workdir",
  "stance",
  "file",
  "doctor",
  "pair",
]);
export async function hostedCommand(
  args: readonly string[],
  transport: ReturnType<typeof createHostedTransport>,
): Promise<unknown> {
  const [command, action, value] = args;
  if (command === "status" || command === "health")
    return { mode: "hosted", health: await transport.request("/health") };
  if (command === "model") {
    if (action === undefined || action === "status") return transport.request("/v1/model-keys");
    if (action === "set" && value) return transport.request("/v1/model-keys/select", { model: value });
  }
  if (command === "persona") {
    if (action === undefined || action === "status") return transport.request("/v1/operator/persona");
    if (action === "set") {
      const patch: Record<string, string> = {};
      for (let i = 2; i < args.length; i += 2) {
        const key = (
          {
            "--display-name": "displayName",
            "--character-notes": "characterNotes",
            "--chattiness": "chattiness",
            "--reply-policy": "replyPolicy",
          } as Record<string, string>
        )[args[i]!];
        if (!key || args[i + 1] === undefined) throw new Error("Unsupported hosted persona field");
        patch[key] = args[i + 1]!;
      }
      return transport.request("/v1/operator/persona", patch);
    }
  }
  if (command === "accounts")
    return runAccountsCommand(args.slice(1), {
      request: async (path, body) => (await transport.request(path, body)) as Record<string, unknown>,
    });
  if (HOSTED_LOCAL_ONLY.has(command ?? ""))
    throw new Error(
      `${command} is managed by the hosted service. This command does not operate on this Mac in hosted mode.`,
    );
  throw new Error(`Unsupported hosted command: ${args.join(" ")}`);
}
export async function hostedTransportFor(env: NodeJS.ProcessEnv) {
  const store = createDefaultCredentialStore({ env });
  const session = await loadHostedSession(store);
  const client = (await new SettingsStore(defaultSettingsPath(env)).load()).client;
  if (
    client?.mode !== "hosted" ||
    client.hostId !== session.encryption.hostId ||
    client.gatewayUrl !== session.gatewayUrl
  )
    throw new Error("Hosted connection identity mismatch; clankie connect hosted");
  return createHostedTransport(session, store);
}
