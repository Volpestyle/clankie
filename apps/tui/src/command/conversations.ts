import {
  ProjectProposalLocatorSchema,
  ProjectProposalTargetSchema,
  ProjectProposalTweakSchema,
} from "@clankie/protocol/projects";
import { ClankieApiClient } from "@clankie/api-client";
import { parseArgs } from "node:util";
import {
  resolveOperatorCredential,
  resolveCaptainCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import {
  UpsertOperatorChannelSchema,
  ConversationQuestionTargetSchema,
  ConversationQuestionAnswerSchema,
  OperatorConversationServiceRequestSchema,
  OperatorAutonomyCommandSchema,
  operatorAutonomyCommandRequiresOwner,
  type OperatorAutonomyCommand,
  type OperatorConversationServiceClient,
  type UpsertOperatorChannel,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";
import { runRemoteLeadCommand } from "./remote-leads.ts";

const USAGE = [
  "       clankie conversations lead prepare FLEET | launch --json-stdin | revoke DELEGATION_ID",
  "Usage: clankie conversations list | show ID [--cursor CURSOR] [--limit N] | tail ID [--cursor CURSOR]",
  "       clankie conversations pending ID [list|remove|send-now|edit] [MESSAGE_ID --version N] [--text TEXT]",
  "       clankie conversations stop-task ID",
  "       clankie conversations goal ID [status|accept|pause|resume|clear]",
  "       clankie conversations goal ID set [--tokens N] <objective>",
  "       clankie conversations project-proposal ID --request UUID --incarnation UUID",
  "       clankie conversations confirm-project ID --request UUID --incarnation UUID --revision N --proposal UUID --artifact SHA --projects-revision SHA",
  "       clankie conversations accept-project ID --request UUID --incarnation UUID --revision N --proposal UUID --artifact SHA --projects-revision SHA",
  "       clankie conversations tweak-project ID --request UUID --incarnation UUID --revision N --proposal UUID --artifact SHA --projects-revision SHA --field FIELD --value-stdin",
  "       clankie conversations questions [ID] [--request UUID] [--status pending|submitted|cancelled]",
  "       clankie conversations answer ID REQUEST_UUID --incarnation UUID --revision N (--option UUID | --text TEXT | --stdin | --worker-stdin)",
  "       clankie conversations cancel-question ID REQUEST_UUID --incarnation UUID --revision N",
  "       clankie conversations updates [ID] [--state unread|read|dismissed|all]",
  "       clankie conversations read-update UUID | dismiss-update UUID",
  "       clankie conversations channels | rooms",
  "       clankie conversations head OWNER HEAD|none",
  "       clankie conversations channel [CHANNEL_ID] [--title TITLE] [--member PERSONA_ID]...",
  "                                     [--discord provision [--room ROOM_ID] | --discord off | --webhook-stdin]",
  "       clankie conversations channel --json-stdin",
].join("\n");

const CHANNEL_ACTIONS = new Set(["channels", "rooms", "channel"]);

/** The same discovery, replay, and live tail used by the visual conversation picker. */
export async function runConversationsCommand(
  args: readonly string[],
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly host?: string;
    readonly fetchImpl?: typeof fetch;
    readonly captainCredentialStore?: CredentialStore;
    readonly operatorCredentialStore?: CredentialStore;
    readonly stdout?: Writable;
    readonly signal?: AbortSignal;
    readonly stdin?: AsyncIterable<unknown> & { readonly isTTY?: boolean };
  },
): Promise<number> {
  if (args[0] === "lead") return runRemoteLeadCommand(args.slice(1), options);
  if (["pending", "stop-task"].includes(args[0] ?? "")) return runNativeMessageAction(args, options);
  if (["updates", "read-update", "dismiss-update"].includes(args[0] ?? ""))
    return runOwnerUpdateAction(args, options);
  if (args[0] === "goal") return runGoalAction(args.slice(1), options);
  if (args[0] === "auto") return runAutoAction(args.slice(1), options);
  if (
    [
      "questions",
      "answer",
      "cancel-question",
      "project-proposal",
      "confirm-project",
      "accept-project",
      "tweak-project",
    ].includes(args[0] ?? "")
  )
    return runQuestionAction(args, options);
  if (args[0] === "head") {
    if (args.length !== 3 || !args[1] || !args[2]) throw new Error(USAGE);
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (credential === undefined)
      throw new Error("Operator credential required to designate a conversation head");
    const client = new ClankieApiClient({
      baseUrl: commandHost({ ...options, env }),
      operatorToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    const result = await client.setConversationHead({
      conversationId: args[1],
      headConversationId: args[2] === "none" ? null : args[2],
    });
    outputJson(options.stdout ?? process.stdout, result);
    return 0;
  }
  if (CHANNEL_ACTIONS.has(args[0] ?? "")) return runChannelAction(args, options);
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { cursor: { type: "string" }, limit: { type: "string", default: "100" } },
  });
  const [action = "list", selector] = positionals;
  const limit = Number(values.limit);
  if (
    !["list", "show", "tail"].includes(action) ||
    positionals.length > 2 ||
    (action === "list" ? selector !== undefined || values.cursor !== undefined : selector === undefined) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error(USAGE);
  const client = await serviceClient(options);
  const stdout = options.stdout ?? process.stdout;
  const conversations = await client.list();
  if (action === "list") {
    outputJson(stdout, conversations);
    return 0;
  }
  const exact = conversations.find((item) => item.conversationId === selector);
  const matches =
    exact === undefined
      ? conversations.filter(
          (item) =>
            item.title === selector ||
            (item.scope.kind === "room" &&
              item.roomHandoff === undefined &&
              (item.scope.targetId === selector || item.scope.targetId.split(":").at(-1) === selector)),
        )
      : [exact];
  if (matches.length !== 1) throw new Error("Choose one conversation ID from clankie conversations list.");
  const conversation = matches[0]!;
  const request = {
    schemaVersion: 1 as const,
    conversationId: conversation.conversationId,
    surfaceClientId: "clankie-cli",
    limit,
    ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
  };
  if (action === "show") {
    outputJson(stdout, { conversation, ...(await client.replay(request)) });
  } else {
    for await (const event of client.tail(request, options.signal)) outputJson(stdout, event);
  }
  return 0;
}

type ConversationsCommandOptions = Parameters<typeof runConversationsCommand>[1];

async function runGoalAction(args: readonly string[], options: ConversationsCommandOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { tokens: { type: "string" } },
  });
  const [conversationId, action = "status", ...objective] = positionals;
  if (
    !conversationId ||
    !["status", "set", "accept", "pause", "resume", "clear"].includes(action) ||
    (action !== "set" && (objective.length > 0 || values.tokens !== undefined))
  )
    throw new Error(USAGE);
  const tokenBudget = values.tokens === undefined ? undefined : Number(values.tokens);
  if (tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0))
    throw new Error("--tokens must be a positive integer.");
  const command = OperatorAutonomyCommandSchema.parse(
    action === "set"
      ? {
          action: "set_goal",
          objective: objective.join(" "),
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        }
      : action === "accept"
        ? { action: "accept_goal" }
        : action === "pause" || action === "resume"
          ? { action: "set_goal_status", status: action === "pause" ? "paused" : "active" }
          : action === "clear"
            ? { action: "clear_goal" }
            : { action: "status" },
  );
  const client = await autonomyClient(
    command,
    options,
    "Owner operator credential required to start, accept, or resume a goal.",
  );
  outputJson(options.stdout ?? process.stdout, await client.autonomy(conversationId, command));
  return 0;
}

/** Turning unprompted work on needs the owner credential; reading it or turning it off does not. */
async function autonomyClient(
  command: OperatorAutonomyCommand,
  options: ConversationsCommandOptions,
  ownerRequired: string,
): Promise<OperatorConversationServiceClient> {
  if (!operatorAutonomyCommandRequiresOwner(command)) return await serviceClient(options);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) throw new Error(ownerRequired);
  const owner = createCaptainRouteClient({
    host: commandHost({ ...options, env }),
    captainToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return createCaptainOperatorConversationClient(owner, owner);
}

const AUTO_USAGE = "Usage: clankie auto [status|on|off]";

/**
 * The master switch for unprompted work (ADR 0264): projects on Auto, goal runs
 * and self-wakes all stop while it is off. It is the global autonomy runner
 * switch, so any conversation can carry it; the default global chat does.
 */
async function runAutoAction(args: readonly string[], options: ConversationsCommandOptions): Promise<number> {
  const action = args[0] ?? "status";
  if (args.length > 1 || !["status", "on", "off"].includes(action)) throw new Error(AUTO_USAGE);
  const command = OperatorAutonomyCommandSchema.parse(
    action === "status" ? { action: "status" } : { action: "set_enabled", enabled: action === "on" },
  );
  const client = await autonomyClient(
    command,
    options,
    "Owner operator credential required to turn Auto on.",
  );
  const status = await client.autonomy("global-default", command);
  outputJson(options.stdout ?? process.stdout, {
    auto: status.enabled ? "on" : "off",
    ...(status.error === undefined ? {} : { error: status.error }),
  });
  return 0;
}

async function serviceClient(
  options: ConversationsCommandOptions,
): Promise<OperatorConversationServiceClient> {
  const env = options.env ?? process.env;
  const credential = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (credential === undefined)
    throw new Error("No captain credential is available; start the clankie service once first.");
  return createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
}

async function readStdin(options: ConversationsCommandOptions, what: string): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  if (options.stdin === undefined && process.stdin.isTTY) throw new Error(`Pipe ${what} on stdin.`);
  let text = "";
  for await (const chunk of stdin) {
    text += Buffer.isBuffer(chunk)
      ? chunk.toString("utf8")
      : typeof chunk === "string"
        ? chunk
        : new TextDecoder().decode(chunk as Uint8Array);
    if (text.length > 64_000) throw new Error(`${what} is too long`);
  }
  return text.trim();
}

/**
 * Agent channels and their Discord projection (ADR 0146), on the same
 * operator dispatch the app uses. A roster arrives whole, so an update that
 * names no title or members keeps the channel's current ones.
 */
async function runChannelAction(
  args: readonly string[],
  options: ConversationsCommandOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      title: { type: "string" },
      member: { type: "string", multiple: true },
      discord: { type: "string" },
      room: { type: "string" },
      "webhook-stdin": { type: "boolean", default: false },
      "json-stdin": { type: "boolean", default: false },
    },
  });
  const [action, channelId, ...extra] = positionals;
  const stdout = options.stdout ?? process.stdout;
  const flagged =
    values.title !== undefined ||
    values.member !== undefined ||
    values.discord !== undefined ||
    values.room !== undefined ||
    values["webhook-stdin"] ||
    values["json-stdin"];
  if (action !== "channel" && (channelId !== undefined || flagged)) throw new Error(USAGE);
  if (extra.length > 0) throw new Error(USAGE);
  const client = await serviceClient(options);
  if (action === "channels") {
    if (client.channels === undefined) throw new Error("This Clankie service does not serve channels.");
    outputJson(stdout, await client.channels());
    return 0;
  }
  if (action === "rooms") {
    if (client.discordRooms === undefined)
      throw new Error("This Clankie service does not list Discord rooms.");
    outputJson(stdout, await client.discordRooms());
    return 0;
  }
  if (client.channel === undefined) throw new Error("This Clankie service does not serve channels.");
  let request: UpsertOperatorChannel;
  if (values["json-stdin"]) {
    if (channelId !== undefined || flagged !== values["json-stdin"]) throw new Error(USAGE);
    request = UpsertOperatorChannelSchema.parse(JSON.parse(await readStdin(options, "the channel request")));
  } else {
    const projections = [values.discord !== undefined, values["webhook-stdin"]].filter(Boolean).length;
    if (projections > 1) throw new Error("Choose one of --discord or --webhook-stdin.");
    if (values.room !== undefined && values.discord !== "provision")
      throw new Error("--room picks where --discord provision puts the room.");
    if (values.discord !== undefined && values.discord !== "provision" && values.discord !== "off")
      throw new Error("--discord takes provision or off.");
    const existing =
      channelId === undefined
        ? undefined
        : (await client.channels?.())?.find((item) => item.channelId === channelId);
    if (channelId !== undefined && existing === undefined)
      throw new Error("No channel has that id; see clankie conversations channels.");
    const title = values.title ?? existing?.title;
    if (title === undefined) throw new Error("A new channel needs --title.");
    const members =
      values.member ??
      [...(existing?.members ?? [])].sort((a, b) => a.position - b.position).map((m) => m.personaId);
    let discord: UpsertOperatorChannel["discord"];
    if (values["webhook-stdin"]) {
      discord = { kind: "webhook", webhookUrl: await readStdin(options, "the webhook URL") };
    } else if (values.discord === "off") {
      discord = { kind: "off" };
    } else if (values.discord === "provision") {
      let room: { kind: "channel" | "forum"; channelId: string } | undefined;
      if (values.room !== undefined) {
        const found = (await client.discordRooms?.())?.find((item) => item.channelId === values.room);
        if (found === undefined)
          throw new Error("That room is not in the managed server; see clankie conversations rooms.");
        room = { kind: found.kind, channelId: found.channelId };
      }
      discord = { kind: "provision", ...(room === undefined ? {} : { room }) };
    }
    request = UpsertOperatorChannelSchema.parse({
      schemaVersion: 1,
      ...(channelId === undefined ? {} : { channelId }),
      title,
      members,
      ...(discord === undefined ? {} : { discord }),
    });
  }
  outputJson(stdout, await client.channel(request));
  return 0;
}

async function runQuestionAction(
  args: readonly string[],
  options: ConversationsCommandOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      field: { type: "string" },
      "value-stdin": { type: "boolean" },
      proposal: { type: "string" },
      artifact: { type: "string" },
      "projects-revision": { type: "string" },
      request: { type: "string" },
      incarnation: { type: "string" },
      revision: { type: "string" },
      option: { type: "string" },
      text: { type: "string" },
      stdin: { type: "boolean" },
      "worker-stdin": { type: "boolean" },
      status: { type: "string" },
    },
  });
  const [action, conversationId, requestId] = positionals;
  if ((!conversationId && action !== "questions") || positionals.length > 3)
    throw new Error("Question action requires an exact conversation ID");
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Owner operator credential required for asks");
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  if (action === "questions" && (!conversationId || values.status !== undefined)) {
    if (requestId || Object.keys(values).some((k) => k !== "status"))
      throw new Error("Usage: conversations questions [ID] [--status pending|submitted|cancelled]");
    const request = OperatorConversationServiceRequestSchema.parse({
      op: "input_list",
      schemaVersion: 1,
      ...(conversationId === undefined ? {} : { conversationId }),
      ...(values.status === undefined ? {} : { status: values.status }),
    });
    if (request.op !== "input_list") throw new Error("Unexpected question list request");
    outputJson(
      options.stdout ?? process.stdout,
      await client.inputList!({
        ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        ...(request.status === undefined ? {} : { status: request.status }),
      }),
    );
    return 0;
  }
  if (!conversationId) throw new Error("Question action requires an exact conversation ID");
  if (values.status !== undefined) throw new Error("--status requires questions");
  if (["project-proposal", "confirm-project", "accept-project", "tweak-project"].includes(action ?? "")) {
    if (positionals.length !== 2 || values.option || values.text || values.stdin || values["worker-stdin"])
      throw new Error("Project confirmation accepts an exact proposal target only");
    const locator = ProjectProposalLocatorSchema.parse({
      conversationId,
      requestId: values.request,
      incarnationId: values.incarnation,
    });
    if (
      action === "project-proposal" &&
      (values.revision || values.proposal || values.artifact || values["projects-revision"])
    )
      throw new Error("Proposal read accepts request and incarnation only");
    if (
      action === "tweak-project"
        ? !values.field || !values["value-stdin"]
        : values.field || values["value-stdin"]
    )
      throw new Error("Tweak requires --field FIELD --value-stdin; other actions accept no change");
    const result =
      action === "project-proposal"
        ? await client.projectProposalGet!(locator)
        : action === "tweak-project"
          ? await client.projectProposalTweak!(
              ProjectProposalTweakSchema.parse({
                ...locator,
                expectedRevision: values.revision === undefined ? undefined : Number(values.revision),
                proposalId: values.proposal,
                artifactSha256: values.artifact,
                expectedProjectsRevision: values["projects-revision"],
                change: {
                  field: values.field,
                  value: JSON.parse(await readStdin(options, "field value JSON")),
                },
              }),
            )
          : await client.projectProposalConfirm!(
              ProjectProposalTargetSchema.parse({
                ...locator,
                expectedRevision: values.revision === undefined ? undefined : Number(values.revision),
                proposalId: values.proposal,
                artifactSha256: values.artifact,
                expectedProjectsRevision: values["projects-revision"],
              }),
            );
    outputJson(options.stdout ?? process.stdout, result);
    return result.status === "pending" || result.status === "created" ? 0 : 1;
  }
  if (
    values.proposal ||
    values.artifact ||
    values["projects-revision"] ||
    values.field ||
    values["value-stdin"]
  )
    throw new Error("Project target flags require a project action");
  let result;
  if (action === "questions") {
    if (requestId || Object.keys(values).some((k) => k !== "request"))
      throw new Error("Usage: conversations questions ID [--request UUID]");
    result = await client.inputGet!(conversationId, values.request);
  } else {
    const target = ConversationQuestionTargetSchema.parse({
      conversationId,
      requestId,
      incarnationId: values.incarnation,
      expectedRevision: values.revision === undefined ? undefined : Number(values.revision),
    });
    if (action === "cancel-question") {
      if (
        values.option !== undefined ||
        values.text !== undefined ||
        values.stdin ||
        values["worker-stdin"] ||
        values.request
      )
        throw new Error("Cancel takes a request, incarnation and revision only");
      result = await client.inputCancel!(target);
    } else {
      if (
        [
          values.option !== undefined,
          values.text !== undefined,
          values.stdin === true,
          values["worker-stdin"] === true,
        ].filter(Boolean).length !== 1 ||
        values.request
      )
        throw new Error("Answer needs exactly one of --option UUID, --text TEXT, --stdin, or --worker-stdin");
      const answer = ConversationQuestionAnswerSchema.parse(
        values["worker-stdin"]
          ? { kind: "worker", answers: JSON.parse(await readStdin(options, "worker answer map JSON")) }
          : values.option !== undefined
            ? { kind: "choice", optionId: values.option }
            : { kind: "text", text: values.stdin ? await readStdin(options, "answer text") : values.text },
      );
      result = await client.inputAnswer!({ ...target, answer });
    }
  }
  outputJson(options.stdout ?? process.stdout, result);
  return result.status === "ready" || result.status === "resolved" ? 0 : 1;
}

async function runOwnerUpdateAction(
  args: readonly string[],
  options: ConversationsCommandOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { state: { type: "string" } },
  });
  const [action, selector] = positionals;
  if (positionals.length > 2 || (action !== "updates" && (!selector || values.state)))
    throw new Error(
      "Usage: conversations updates [ID] [--state unread|read|dismissed|all] | read-update UUID | dismiss-update UUID",
    );
  const request = OperatorConversationServiceRequestSchema.parse(
    action === "updates"
      ? {
          schemaVersion: 1,
          op: "owner_update_list",
          ...(selector ? { conversationId: selector } : {}),
          ...(values.state ? { state: values.state } : {}),
        }
      : {
          schemaVersion: 1,
          op: action === "read-update" ? "owner_update_read" : "owner_update_dismiss",
          id: selector,
        },
  );
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Owner operator credential required for updates");
  const ownerFetcher = createCaptainRouteClient({
    host: commandHost({ ...options, env }),
    captainToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const client = createCaptainOperatorConversationClient(ownerFetcher, ownerFetcher);
  if (request.op === "owner_update_list") {
    outputJson(
      options.stdout ?? process.stdout,
      await client.ownerUpdateList!({
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.state ? { state: request.state } : {}),
      }),
    );
    return 0;
  }
  if (request.op !== "owner_update_read" && request.op !== "owner_update_dismiss")
    throw new Error("Unexpected update request");
  const result =
    request.op === "owner_update_read"
      ? await client.ownerUpdateRead!(request.id)
      : await client.ownerUpdateDismiss!(request.id);
  outputJson(options.stdout ?? process.stdout, result);
  return result.status === "ready" || result.status === "resolved" ? 0 : 1;
}

async function runNativeMessageAction(
  args: readonly string[],
  options: ConversationsCommandOptions,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: { version: { type: "string" }, text: { type: "string" } },
  });
  const [operation, conversationId, action = "list", messageId] = positionals;
  if (!conversationId) throw new Error(USAGE);
  const request =
    operation === "stop-task"
      ? OperatorConversationServiceRequestSchema.parse({ op: "stop_task", schemaVersion: 1, conversationId })
      : OperatorConversationServiceRequestSchema.parse({
          op: "pending_messages",
          schemaVersion: 1,
          conversationId,
          command:
            action === "list"
              ? { action }
              : {
                  action: action === "send-now" ? "send_now" : action,
                  messageId,
                  expectedVersion: Number(values.version),
                  ...(values.text === undefined ? {} : { text: values.text }),
                },
        });
  if (positionals.length > (operation === "stop-task" ? 2 : action === "list" ? 3 : 4))
    throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Operator credential required to control native messages or tasks");
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
  const result =
    request.op === "stop_task"
      ? await client.stopTask!(conversationId)
      : request.op === "pending_messages"
        ? await client.pendingMessages!(conversationId, request.command)
        : undefined;
  outputJson(options.stdout ?? process.stdout, result);
  return 0;
}
