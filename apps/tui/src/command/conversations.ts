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
  type OperatorConversationServiceClient,
  type UpsertOperatorChannel,
} from "@clankie/protocol";
import { commandHost, outputJson, type Writable } from "./io.ts";

const USAGE = [
  "Usage: clankie conversations list | show ID [--cursor CURSOR] [--limit N] | tail ID [--cursor CURSOR]",
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
  if (["questions", "answer", "cancel-question"].includes(args[0] ?? ""))
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
          throw new Error("That room is not in the swarm home; see clankie conversations rooms.");
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
      request: { type: "string" },
      incarnation: { type: "string" },
      revision: { type: "string" },
      option: { type: "string" },
      text: { type: "string" },
      stdin: { type: "boolean" },
    },
  });
  const [action, conversationId, requestId] = positionals;
  if (!conversationId || positionals.length > 3)
    throw new Error("Question action requires an exact conversation ID");
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("Owner operator credential required for preference questions");
  const client = createCaptainOperatorConversationClient(
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );
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
      if (values.option !== undefined || values.text !== undefined || values.stdin || values.request)
        throw new Error("Cancel takes a request, incarnation and revision only");
      result = await client.inputCancel!(target);
    } else {
      if (
        [values.option !== undefined, values.text !== undefined, values.stdin === true].filter(Boolean)
          .length !== 1 ||
        values.request
      )
        throw new Error("Answer needs exactly one of --option UUID, --text TEXT, or --stdin");
      const answer = ConversationQuestionAnswerSchema.parse(
        values.option !== undefined
          ? { kind: "choice", optionId: values.option }
          : { kind: "text", text: values.stdin ? await readStdin(options, "answer text") : values.text },
      );
      result = await client.inputAnswer!({ ...target, answer });
    }
  }
  outputJson(options.stdout ?? process.stdout, result);
  return result.status === "ready" || result.status === "resolved" ? 0 : 1;
}
