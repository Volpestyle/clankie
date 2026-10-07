import { OperatorConversationServiceRequestSchema } from "@clankie/protocol";
import { runAccountsCommand } from "./accounts.ts";
import { runShareCommand } from "./share.ts";
import { gatewayEnableWithAccount } from "./gateway.ts";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  beginClankieAccountLogin,
  completeClankieAccountLogin,
  createDefaultCredentialStore,
} from "@clankie/credential-broker";
import { SettingsStore, defaultSettingsPath } from "@clankie/settings";
import {
  accountHasHostedClankie,
  createHostedTransport,
  disconnectHosted,
  hostedOrigin,
  loadHostedSession,
  pairHostedAccount,
} from "../hosted-session.ts";
import { outputJson, type Writable } from "./io.ts";

export const NO_HOSTED_CLANKIE_MESSAGE =
  "This account has no hosted Clankie. Run `clankie login` to sign this Mac in for remote access to your own Clankie, or add a hosted Clankie from your account page.";

/** Why the hosted lookup failed, in the owner's words rather than "no hosted Clankie". */
function hostedLookupFailedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|unauthorized)\b/u.test(message)
    ? "The hosted service didn't accept this sign-in, so it couldn't look up your hosted Clankie. Try `clankie login` again; if it keeps happening, contact support."
    : `Couldn't reach your hosted Clankie's account service (${message}). Try again in a minute.`;
}

/** The fleet answers a bare `not_found` for an account with no hosted body. */
function explainNoHostedClankie(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  return message === "Hosted account: not_found" ||
    message === "Hosted Clankie: not_found" ||
    message === "No hosted machine on this account"
    ? new Error(NO_HOSTED_CLANKIE_MESSAGE)
    : error;
}

/** Where a freshly signed-in account goes: a hosted Clankie, or this Mac's own doorway. */
export async function routeSignedInAccount(input: {
  readonly target: "auto" | "this-mac" | undefined;
  readonly gatewayUrl: string;
  readonly credential: Parameters<typeof gatewayEnableWithAccount>[0]["credential"];
  readonly env: NodeJS.ProcessEnv;
  readonly store: ReturnType<typeof createDefaultCredentialStore>;
  readonly settings: SettingsStore;
  readonly fetchImpl?: typeof fetch;
}): Promise<{ readonly kind: "hosted" } | { readonly kind: "this-mac"; readonly output: unknown }> {
  // The tenant lookup is a convenience for `clankie login`. Whatever it says
  // (not_found, a 401 for this client's token, an outage), it must never lock a
  // self-hosted Mac out of signing in, so any failure reads as "no hosted
  // Clankie" there. Asking for the hosted Clankie by name is different: only a
  // real "no hosted Clankie" answer may say so, and a failed lookup says why.
  let lookupError: unknown;
  const hasHosted =
    input.target === "this-mac"
      ? false
      : await accountHasHostedClankie(input.gatewayUrl, input.credential, input.fetchImpl).catch(
          (error: unknown) => {
            lookupError = error;
            return false;
          },
        );
  if (hasHosted) return { kind: "hosted" };
  if (input.target === undefined) {
    const explained = lookupError === undefined ? undefined : explainNoHostedClankie(lookupError);
    if (
      explained === undefined ||
      (explained instanceof Error && explained.message === NO_HOSTED_CLANKIE_MESSAGE)
    )
      throw new Error(NO_HOSTED_CLANKIE_MESSAGE);
    throw new Error(hostedLookupFailedMessage(lookupError));
  }
  const enabled = await gatewayEnableWithAccount(
    { gatewayUrl: input.gatewayUrl, credential: input.credential },
    { env: input.env, settings: input.settings, credentials: input.store },
  );
  return {
    kind: "this-mac",
    output: {
      ok: true,
      mode: "remote-access",
      hostId: enabled.hostId,
      message: "Signed this Mac in for remote access. Restart the captain to open the doorway.",
      restart: enabled.restart,
    },
  };
}

/**
 * `clankie login` is the one account sign-in (`target: "auto"`): an account with
 * a hosted Clankie connects this terminal to it, any other signs this Mac in
 * for remote access (which also re-signs a signed-out Mac). `remote-access on`
 * is the same sign-in pinned to this Mac (`"this-mac"`). `connect hosted` asks
 * for a hosted body, so an account without one is an error, not a doorway.
 */
export async function connectHostedCli(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  stdout: Writable = process.stdout,
  options: { readonly target?: "auto" | "this-mac" } = {},
) {
  const { positionals, values } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      email: { type: "string" },
      url: { type: "string", default: "https://api.clankie.bot" },
      machine: { type: "string" },
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
    const route = await routeSignedInAccount({
      target: options.target,
      gatewayUrl,
      credential,
      env,
      store,
      settings,
    });
    if (route.kind === "this-mac") {
      outputJson(stdout, route.output);
      return;
    }
    const session = await pairHostedAccount({
      gatewayUrl,
      credential,
      store,
      settings,
      onStatus: (status) => {
        process.stderr.write(`${status}\n`);
      },
      selectMachine: async (machines) => {
        if (values.machine) {
          const chosen = machines.find((item) => item.id === values.machine);
          if (!chosen) throw new Error("No such machine on this account");
          return chosen;
        }
        if (machines.length === 1) return machines[0]!;
        if (!process.stdin.isTTY) throw new Error("Multiple machines; use --machine ID");
        machines.forEach((item, index) =>
          process.stderr.write(`${index + 1}. ${item.name} (${item.state})\n`),
        );
        const chosen = machines[Number(await input.question("Machine: ")) - 1];
        if (!chosen) throw new Error("No machine selected");
        return chosen;
      },
    }).catch((error: unknown) => {
      throw explainNoHostedClankie(error);
    });
    outputJson(stdout, {
      ok: true,
      mode: "hosted",
      hostId: session.encryption.hostId,
      deviceId: session.deviceId,
      machine: session.machine,
    });
  } finally {
    input.close();
  }
}
export async function disconnectHostedCli(env: NodeJS.ProcessEnv = process.env) {
  const settings = new SettingsStore(defaultSettingsPath(env));
  if ((await settings.load()).client?.mode !== "hosted") {
    return {
      ok: true,
      mode: "local",
      message:
        "This terminal is not connected to a hosted Clankie, so there is nothing to sign out of. To take this Mac off remote access, run `clankie remote-access off`.",
    };
  }
  await disconnectHosted(settings, createDefaultCredentialStore({ env }));
  return {
    ok: true,
    mode: "local",
    message:
      "Disconnected this Mac. Hosted work continues. Revoke the device from your account to remove its access.",
  };
}
export const HOSTED_LOCAL_ONLY = new Set([
  "checkouts",
  "simulator",
  "integrate",
  "harness",
  "update",
  "restart",
  "reset",
  "deprovision",
  "remote-access",
  "start",
  "stop",
  "down",
  "autostart",
  "awake",
  "herdr",
  "hire-receipt",
  "discord",
  "voice",
  "gateway",
  "operator-credential",
  "seat",
  "claude",
  "codex",
  "opencode",
  "grok",
  "seat-sync",
  "seat-hook",
  "mcp",
  "telemetry",
  "workdir",
  "stance",
  "work-on",
  "file",
  "doctor",
  "pair",
]);
export async function hostedCommand(
  args: readonly string[],
  transport: ReturnType<typeof createHostedTransport>,
): Promise<unknown> {
  const [command, action, value] = args;
  if (command === "share") return (await runShareCommand(args.slice(1), { request: transport.request })).body;
  if (command === "status" || command === "health") {
    const health = await transport.request("/health");
    return { mode: "hosted", label: transport.label, status: transport.status(), health };
  }
  if (command === "fleet" || command === "terminal") {
    if (!action || action === "list" || action === "status")
      return transport.request("/operator/v1/dispatch", {
        schemaVersion: 1,
        op: command === "fleet" ? "fleet" : "terminal_catalog",
      });
    const ops: Record<string, string> =
      command === "fleet"
        ? { spawn: "spawn_seat", move: "move_seat", close: "close_seat" }
        : { tail: "terminal_tail", control: "terminal_control", input: "terminal_input" };
    if (!ops[action] || !args.includes("--json-stdin"))
      throw new Error(
        `Use ${command} ${Object.keys(ops).join("|")} --json-stdin with its protocol request body`,
      );
    const fields = JSON.parse(await readHostedStdin());
    const request = OperatorConversationServiceRequestSchema.parse({
      ...fields,
      op: ops[action],
      schemaVersion: 1,
    });
    return transport.request("/operator/v1/dispatch", request);
  }
  if (command === "keys") {
    if (!action || action === "status" || action === "list") return transport.request("/v1/model-keys");
    if (action === "set" && value && args.includes("--key-stdin"))
      return transport.request("/v1/model-keys/set", {
        providerId: value,
        apiKey: (await readHostedStdin()).trim(),
      });
    if ((action === "remove" || action === "validate") && value)
      return transport.request(`/v1/model-keys/${action}`, { providerId: value });
    throw new Error("Use keys set PROVIDER --key-stdin, keys remove PROVIDER or keys validate PROVIDER");
  }
  if (command === "model") {
    if (action === undefined || action === "status") return transport.request("/v1/model-keys");
    if (action === "set" && value) return transport.request("/v1/model-keys/select", { model: value });
  }
  if (command === "persona") {
    if (action === "images") {
      if (value === undefined || value === "status") return transport.request("/v1/operator/persona");
      if (value === "clear" || (value === "set" && args[3]?.trim())) {
        const result = await transport.request("/v1/operator/persona", {
          imagesDir: value === "clear" ? "" : args[3],
        });
        return {
          result,
          restart: "Restart Clankie to apply persona images. Folder paths refer to the hosted machine.",
        };
      }
      throw new Error("Use persona images status|set <folder>|clear");
    }
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

export async function hostedWhoami(env: NodeJS.ProcessEnv) {
  const client = (await new SettingsStore(defaultSettingsPath(env)).load()).client;
  if (client?.mode !== "hosted") return { mode: "local", label: "This Mac" };
  try {
    const store = createDefaultCredentialStore({ env }),
      session = await loadHostedSession(store);
    const transport = await hostedTransportFor(env);
    await transport.request("/health").catch(() => undefined);
    return {
      mode: "hosted",
      label: `Hosted · ${session.machine?.name ?? client.hostId}`,
      machine: session.machine ?? { id: client.hostId },
      deviceId: session.deviceId,
      status: transport.status(),
    };
  } catch (error) {
    return {
      mode: "hosted",
      label: `Hosted · ${client.hostId}`,
      status: error instanceof Error ? error.message : "Sign-in required",
    };
  }
}

async function readHostedStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("Provide the request on stdin");
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error("Hosted input too large");
  }
  return text;
}
