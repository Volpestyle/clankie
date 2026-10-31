import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  CONNECTOR_DETECTION_PATH,
  CONNECTOR_PROMPT_ANSWERS_PATH,
  CONNECTOR_SIGN_INS_PATH,
  CONNECTOR_SIGN_IN_APPROVE_PATH,
  CONNECTOR_SIGN_IN_DENY_PATH,
  ConnectorDetectionResponseSchema,
  ConnectorPromptAnswersResponseSchema,
  ConnectorSignInCodeSchema,
  ConnectorSignInDecisionResponseSchema,
  ConnectorSignInsResponseSchema,
  type ConnectorDetectionResponse,
  type ConnectorPromptAnswersResponse,
  type ConnectorSignInsResponse,
} from "@clankie/protocol/connector";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorLeadStatus,
} from "@clankie/protocol";
import { operatorRequest } from "../../bin/operator-request.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

// `clankie connector`: the Claude connector (ADR 0301). Shows the URL to add
// in Claude and the sign-ins waiting, and approves or denies one by its code.
// Connected connectors are devices: `clankie devices revoke ID` ends one.
// `clankie connector prompts` lists which apps may answer prompts in agent
// panes, and turns one on or off by its name or device id (ADR 0303).
// `clankie connector detect` turns Herdr session discovery on or off, and
// `clankie connector serve` turns the connector on or off per app (ADR 0312).
// `clankie connector lead` says who leads Clankie's lead threads, and hands
// them to the connected apps or back to Clankie (ADR 0304).

const CONNECTOR_USAGE =
  "Usage: clankie connector [status] [--json] | clankie connector approve CODE [--json] | clankie connector deny CODE [--json] | clankie connector prompts [on|off APP] [--json] | clankie connector detect [on|off herdr] [--json] | clankie connector serve [on|off APP] [--json] | clankie connector lead [clankie|apps] [--json]";
const TIMEOUT_MS = 10_000;

export interface ConnectorCliCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

type ClosedStatus =
  | "unavailable"
  | "unauthorized"
  | "not_found"
  | "malformed"
  | "interrupted"
  | "unknown_app"
  | "ambiguous_app"
  | "unknown_multiplexer";

class ConnectorCommandError extends Error {
  public readonly status: ClosedStatus | "already_decided";

  public constructor(status: ClosedStatus | "already_decided") {
    super(failureMessage(status));
    this.status = status;
  }
}

function failureMessage(status: ClosedStatus | "already_decided"): string {
  switch (status) {
    case "unavailable":
      return "Clankie isn't answering. Start the clankie service and retry.";
    case "unauthorized":
      return "Operator credential unavailable. Start the clankie service once, then retry.";
    case "not_found":
      return "No sign-in is waiting with that code. It may have expired; start again from Claude.";
    case "already_decided":
      return "That sign-in was already approved or denied.";
    case "malformed":
      return "Clankie returned an unexpected response. Update Clankie or retry.";
    case "interrupted":
      return "The request didn't finish in time. Retry.";
    case "unknown_app":
      return "No connected app has that name or id. `clankie connector prompts` and `clankie connector serve` list them.";
    case "ambiguous_app":
      return "More than one connected app has that name. Name it by its device id from `clankie connector prompts` or `clankie connector serve`.";
    case "unknown_multiplexer":
      return "That isn't a multiplexer Clankie detects. `clankie connector detect` lists them.";
  }
}

function parse(args: readonly string[]) {
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  if (positional.length === 0 || (positional.length === 1 && positional[0] === "status"))
    return { json, subcommand: "status" as const };
  if (positional[0] === "detect" && positional.length === 1) return { json, subcommand: "detect" as const };
  if (
    positional[0] === "detect" &&
    (positional[1] === "on" || positional[1] === "off") &&
    positional.length === 3
  )
    return {
      json,
      subcommand: "detect" as const,
      enabled: positional[1] === "on",
      multiplexer: positional[2]!,
    };
  if (positional[0] === "serve" && positional.length === 1) return { json, subcommand: "serve" as const };
  if (
    positional[0] === "serve" &&
    (positional[1] === "on" || positional[1] === "off") &&
    positional.length === 3
  )
    return { json, subcommand: "serve" as const, served: positional[1] === "on", app: positional[2]! };
  if (positional[0] === "prompts" && positional.length === 1) return { json, subcommand: "prompts" as const };
  if (
    positional[0] === "prompts" &&
    (positional[1] === "on" || positional[1] === "off") &&
    positional.length === 3
  )
    return { json, subcommand: "prompts" as const, allowed: positional[1] === "on", app: positional[2]! };
  if (positional[0] === "lead" && positional.length === 1) return { json, subcommand: "lead" as const };
  if (
    positional[0] === "lead" &&
    (positional[1] === "clankie" || positional[1] === "apps") &&
    positional.length === 2
  )
    return { json, subcommand: "lead" as const, lead: positional[1] };
  if ((positional[0] === "approve" || positional[0] === "deny") && positional.length === 2) {
    const code = ConnectorSignInCodeSchema.safeParse(positional[1]);
    if (!code.success)
      throw new Error("A sign-in code looks like ABCD-2345, as Claude's sign-in page shows it.");
    return { json, subcommand: positional[0], code: code.data };
  }
  throw new Error(CONNECTOR_USAGE);
}

function formatDetection(status: ConnectorDetectionResponse): string {
  const lines = status.multiplexers.map((entry) => {
    const label = entry.id === "herdr" ? "Herdr" : entry.id;
    return `${label}: ${entry.enabled ? "on" : "off"}`;
  });
  return [
    ...lines,
    "A multiplexer that is on discovers every session in it, including one that was just cleared or restarted.",
  ].join("\n");
}

function formatServed(status: ConnectorDetectionResponse): string {
  if (status.apps.length === 0) return "No apps are connected.";
  return [
    ...status.apps.map((app) => `${app.name}: ${app.served ? "on" : "off"}  (${app.deviceId})`),
    "An app that is on is served by the connector. One that is off is refused.",
  ].join("\n");
}

function formatPromptAnswers(status: ConnectorPromptAnswersResponse): string {
  if (status.apps.length === 0) return "No apps are connected.";
  return [
    ...status.apps.map((app) => `${app.name}: ${app.allowed ? "on" : "off"}  (${app.deviceId})`),
    "An app that is on may answer menus and permission prompts open in your agents' panes.",
  ].join("\n");
}

function formatLead(status: OperatorLeadStatus): string {
  const lines =
    status.lead === "clankie"
      ? ["Clankie leads: his own turns answer his workers, wakes and watches."]
      : [
          `The connected apps lead: Clankie's own turns are held for them (${String(status.held)} held). Your own messages still reach him.`,
          "Hand it back with `clankie connector lead clankie`.",
        ];
  if (status.error === "state_unreadable")
    lines.push("The saved setting couldn't be read, so the apps lead until you set it again.");
  return lines.join("\n");
}

function formatStatus(status: ConnectorSignInsResponse): string {
  const lines = [
    status.connectorUrl === undefined
      ? "Connector URL: turn on remote access first (`clankie remote-access on`), then add the URL it gives in Claude."
      : `Connector URL: ${status.connectorUrl}\nAdd it in Claude under Settings > Connectors > Add custom connector.`,
  ];
  if (status.signIns.length === 0) lines.push("No sign-ins are waiting.");
  else
    for (const signIn of status.signIns)
      lines.push(
        `Waiting: ${signIn.code}  ${signIn.clientName}, sending access to ${signIn.redirectHost}. Approve with \`clankie connector approve ${signIn.code}\`.`,
      );
  return lines.join("\n");
}

export async function runConnectorCommand(
  args: readonly string[],
  options: ConnectorCliCommandOptions,
): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(args);
  } catch (error) {
    stderr.write(`clankie: ${(error as Error).message}\n`);
    return 2;
  }
  const operatorCredential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const request = {
    controlPlaneUrl: commandHost({ ...options, env }),
    ...(operatorCredential?.token === undefined ? {} : { operatorToken: operatorCredential.token }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    signal: controller.signal,
  };
  try {
    if (parsed.subcommand === "lead") {
      const response = await operatorRequest(
        OPERATOR_CONVERSATION_DISPATCH_PATH,
        "POST",
        request,
        ConnectorCommandError,
        {
          jsonBody: {
            op: "lead",
            schemaVersion: 1,
            command: "lead" in parsed ? { action: "set", lead: parsed.lead } : { action: "status" },
          },
          contentType: "application/json",
        },
      );
      if (response.status === 401 || response.status === 403) throw new ConnectorCommandError("unauthorized");
      if (!response.ok) throw new ConnectorCommandError("unavailable");
      const result = OperatorConversationServiceResultSchema.safeParse(
        // allow-swallowed-rejection -- a body that is not JSON fails the parse below as malformed
        await response.json().catch(() => undefined),
      );
      if (!result.success || result.data.op !== "lead") throw new ConnectorCommandError("malformed");
      const status = result.data.result.status;
      if (parsed.json) outputJson(stdout, { ok: true, ...status });
      else stdout.write(`${formatLead(status)}\n`);
      return 0;
    }
    if (parsed.subcommand === "detect" || parsed.subcommand === "serve") {
      const read = async (response: Response) => {
        if (response.status === 401 || response.status === 403)
          throw new ConnectorCommandError("unauthorized");
        if (response.status === 404) throw new ConnectorCommandError("unknown_app");
        if (response.status === 400) throw new ConnectorCommandError("unknown_multiplexer");
        if (!response.ok) throw new ConnectorCommandError("unavailable");
        const status = ConnectorDetectionResponseSchema.safeParse(
          // allow-swallowed-rejection -- a body that is not JSON fails the parse below as malformed
          await response.json().catch(() => undefined),
        );
        if (!status.success) throw new ConnectorCommandError("malformed");
        return status.data;
      };
      let status = await read(
        await operatorRequest(CONNECTOR_DETECTION_PATH, "GET", request, ConnectorCommandError),
      );
      if (parsed.subcommand === "detect" && "multiplexer" in parsed) {
        if (parsed.multiplexer !== "herdr") throw new ConnectorCommandError("unknown_multiplexer");
        status = await read(
          await operatorRequest(CONNECTOR_DETECTION_PATH, "POST", request, ConnectorCommandError, {
            jsonBody: { multiplexer: "herdr", enabled: parsed.enabled },
            contentType: "application/json",
          }),
        );
      }
      if (parsed.subcommand === "serve" && "app" in parsed) {
        const named = status.apps.filter((app) => app.deviceId === parsed.app || app.name === parsed.app);
        if (named.length === 0) throw new ConnectorCommandError("unknown_app");
        if (named.length > 1) throw new ConnectorCommandError("ambiguous_app");
        status = await read(
          await operatorRequest(CONNECTOR_DETECTION_PATH, "POST", request, ConnectorCommandError, {
            jsonBody: { deviceId: named[0]!.deviceId, served: parsed.served },
            contentType: "application/json",
          }),
        );
      }
      if (parsed.json) outputJson(stdout, { ok: true, ...status });
      else stdout.write(`${(parsed.subcommand === "detect" ? formatDetection : formatServed)(status)}\n`);
      return 0;
    }
    if (parsed.subcommand === "prompts") {
      const read = async (response: Response) => {
        if (response.status === 401 || response.status === 403)
          throw new ConnectorCommandError("unauthorized");
        if (response.status === 404) throw new ConnectorCommandError("unknown_app");
        if (!response.ok) throw new ConnectorCommandError("unavailable");
        const status = ConnectorPromptAnswersResponseSchema.safeParse(
          // allow-swallowed-rejection -- a body that is not JSON fails the parse below as malformed
          await response.json().catch(() => undefined),
        );
        if (!status.success) throw new ConnectorCommandError("malformed");
        return status.data;
      };
      let status = await read(
        await operatorRequest(CONNECTOR_PROMPT_ANSWERS_PATH, "GET", request, ConnectorCommandError),
      );
      if ("app" in parsed) {
        const named = status.apps.filter((app) => app.deviceId === parsed.app || app.name === parsed.app);
        if (named.length === 0) throw new ConnectorCommandError("unknown_app");
        if (named.length > 1) throw new ConnectorCommandError("ambiguous_app");
        status = await read(
          await operatorRequest(CONNECTOR_PROMPT_ANSWERS_PATH, "POST", request, ConnectorCommandError, {
            jsonBody: { deviceId: named[0]!.deviceId, allowed: parsed.allowed },
            contentType: "application/json",
          }),
        );
      }
      if (parsed.json) outputJson(stdout, { ok: true, ...status });
      else stdout.write(`${formatPromptAnswers(status)}\n`);
      return 0;
    }
    if (parsed.subcommand === "status") {
      const response = await operatorRequest(CONNECTOR_SIGN_INS_PATH, "GET", request, ConnectorCommandError);
      if (response.status === 401 || response.status === 403) throw new ConnectorCommandError("unauthorized");
      if (!response.ok) throw new ConnectorCommandError("unavailable");
      const status = ConnectorSignInsResponseSchema.safeParse(await response.json().catch(() => undefined));
      if (!status.success) throw new ConnectorCommandError("malformed");
      if (parsed.json) outputJson(stdout, { ok: true, ...status.data });
      else stdout.write(`${formatStatus(status.data)}\n`);
      return 0;
    }
    const response = await operatorRequest(
      parsed.subcommand === "approve" ? CONNECTOR_SIGN_IN_APPROVE_PATH : CONNECTOR_SIGN_IN_DENY_PATH,
      "POST",
      request,
      ConnectorCommandError,
      { jsonBody: { code: parsed.code }, contentType: "application/json" },
    );
    if (response.status === 401 || response.status === 403) throw new ConnectorCommandError("unauthorized");
    if (response.status === 404) throw new ConnectorCommandError("not_found");
    if (response.status === 409) throw new ConnectorCommandError("already_decided");
    if (!response.ok) throw new ConnectorCommandError("unavailable");
    const decided = ConnectorSignInDecisionResponseSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    if (!decided.success) throw new ConnectorCommandError("malformed");
    if (parsed.json) outputJson(stdout, { ok: true, ...decided.data });
    else
      stdout.write(
        decided.data.decision === "approved"
          ? `Approved ${decided.data.code}. ${decided.data.clientName} can now list your agents, read their screens and message them.\nIt shows in \`clankie devices\`; revoke it there to disconnect.\n`
          : `Denied ${decided.data.code}. Nothing was connected.\n`,
      );
    return 0;
  } catch (error) {
    const status = error instanceof ConnectorCommandError ? error.status : "unavailable";
    const message = error instanceof ConnectorCommandError ? error.message : failureMessage("unavailable");
    if (parsed.json) outputJson(stdout, { ok: false, status, error: message });
    else stderr.write(`clankie: ${message}\n`);
    return 1;
  } finally {
    clearTimeout(timer);
  }
}
