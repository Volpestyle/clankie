import { randomBytes } from "node:crypto";
import { text } from "node:stream/consumers";
import { parseArgs } from "node:util";
import {
  resolveCaptainCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  FEED_CHECK_ONE_SOURCE,
  FEED_DROP_EMPTY,
  FEED_LIST_LIMIT_MAX,
  FeedCheckRequestSchema,
  FeedDropRequestSchema,
  FeedListRequestSchema,
  OPERATOR_CONVERSATION_ATTACHMENTS_MAX,
  feedCheckHasOneSource,
  feedDropHasContent,
  type FeedCheckResult,
  type FeedDropResult,
  type FeedItem,
  type FeedListRequest,
  type FeedMedia,
  type FeedPage,
  type FeedView,
  type OperatorConversationServiceClient,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";
import { attachmentFile } from "./send.ts";

export const FEED_USAGE = [
  "Usage: clankie feed [--project ID] [--details] [--cursor CURSOR] [--limit N] [--json]   (what you need to steer, grouped by project, newest first; --details adds ids and commands)",
  "       clankie feed drop --project ID [--title TEXT] [--body TEXT | --stdin] [--file PATH]... [--key KEY] [--json]   (file a drop as a private issue file and wake the project's lead)",
  "       clankie feed check [--project ID | --conversation ID] [--longer] [--evidence clankie://evidence/sha256/HASH] [--waiting-on TEXT] [--key KEY] [--json] LINE   (ask the owner to check one thing: at most 140 characters, about a ten-second look)",
].join("\n");

export interface FeedCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly captainCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
  readonly stdin?: Parameters<typeof text>[0];
}

/**
 * The operator credential is the owner on this machine, so it is also the owner
 * transport. Uploads and the conversation list ride the captain's, as `clankie
 * send --attach` does, when `withCaptain` asks for it.
 */
async function ownerClient(options: FeedCommandOptions, what: string, withCaptain = false) {
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error(`${what} needs the owner operator credential. Run clankie doctor.`);
  const route = (token: string) =>
    createCaptainRouteClient({
      host: commandHost({ ...options, env }),
      captainToken: token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  const owner = route(credential.token);
  if (!withCaptain) return createCaptainOperatorConversationClient(owner, owner);
  const captain = await resolveCaptainCredential({
    env,
    ...(options.captainCredentialStore === undefined ? {} : { store: options.captainCredentialStore }),
  });
  if (captain === undefined)
    throw new Error("Uploading files needs the captain credential; start the clankie service once first.");
  return createCaptainOperatorConversationClient(route(captain.token), owner);
}

/**
 * `clankie feed`: one page of the owner's feed. Checks are answered with
 * `conversations answer`, owner updates dismissed with `conversations
 * dismiss-update`; the feed itself changes nothing.
 */
export async function runFeedCommand(
  args: readonly string[],
  options: FeedCommandOptions = {},
): Promise<number> {
  if (args[0] === "drop") return runFeedDropCommand(args.slice(1), options);
  if (args[0] === "check") return runFeedCheckCommand(args.slice(1), options);
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      project: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
      details: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const limit = values.limit === undefined ? undefined : Number(values.limit);
  if (positionals.length > 0 || (limit !== undefined && !Number.isInteger(limit)))
    throw new Error(FEED_USAGE);
  const request = FeedListRequestSchema.safeParse({
    ...(values.project === undefined ? {} : { projectId: values.project }),
    ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
  if (!request.success) throw new Error(`${FEED_USAGE}\n--limit takes 1 to ${FEED_LIST_LIMIT_MAX}`);
  const page = await (await ownerClient(options, "The feed")).feedList!(request.data);
  const stdout = options.stdout ?? process.stdout;
  if (values.json) outputJson(stdout, page);
  else stdout.write(`${formatFeedPage(page, request.data, { details: values.details === true })}\n`);
  return page.outcome === "ready" ? 0 : 1;
}

/**
 * `clankie feed drop`: the owner throws a note, idea or screenshot at a project.
 * Files are uploaded as owner attachments to the main conversation first; the
 * drop names them, and the host copies them into the evidence store. The key
 * makes a retry safe: it is printed so an uncertain answer can be retried.
 */
async function runFeedDropCommand(args: readonly string[], options: FeedCommandOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      project: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
      stdin: { type: "boolean" },
      file: { type: "string", multiple: true },
      key: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length > 0 || (values.stdin === true && values.body !== undefined))
    throw new Error(FEED_USAGE);
  const paths = values.file ?? [];
  if (paths.length > OPERATOR_CONVERSATION_ATTACHMENTS_MAX)
    throw new Error(`At most ${String(OPERATOR_CONVERSATION_ATTACHMENTS_MAX)} files per drop.`);
  const body = values.stdin === true ? await text(options.stdin ?? process.stdin) : values.body;
  const key = values.key ?? randomBytes(18).toString("base64url");
  const draft = FeedDropRequestSchema.safeParse({
    projectId: values.project,
    idempotencyKey: key,
    ...(values.title === undefined ? {} : { title: values.title }),
    ...(body === undefined ? {} : { body }),
  });
  if (!draft.success) throw new Error(`${FEED_USAGE}\n${draft.error.issues[0]?.message ?? ""}`);
  if (!feedDropHasContent(draft.data) && paths.length === 0) throw new Error(FEED_DROP_EMPTY);
  // Read and check every file before anything is uploaded or filed.
  const files = await Promise.all(paths.map((path) => attachmentFile(path)));
  const client = await ownerClient(options, "A drop", files.length > 0);
  const attachments: { conversationId: string; artifactId: string }[] = [];
  if (files.length > 0) {
    const main = (await client.list()).find(
      (conversation) => conversation.scope.kind === "global" && conversation.isDefault,
    );
    if (main === undefined) throw new Error("This Clankie has no main conversation to upload to.");
    for (const file of files) {
      if (client.uploadAttachment === undefined) throw new Error("This Clankie build cannot upload files");
      const uploaded = await client.uploadAttachment({ conversationId: main.conversationId, ...file });
      if (uploaded.status !== "committed")
        throw new Error(
          `Could not upload ${file.filename}: ${uploaded.status === "refused" ? uploaded.message : "upload incomplete"}`,
        );
      attachments.push({ conversationId: main.conversationId, artifactId: uploaded.file.artifactId });
    }
  }
  let result: FeedDropResult;
  try {
    result = await client.feedDrop!({ ...draft.data, ...(attachments.length ? { attachments } : {}) });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nThe drop may or may not be filed. Retry with --key ${key}: it never files twice.`,
    );
  }
  const stdout = options.stdout ?? process.stdout;
  // An unavailable drop may already be written: keep the key so a retry finds it.
  const retry = result.outcome === "unavailable" ? key : undefined;
  if (values.json) outputJson(stdout, retry === undefined ? result : { ...result, idempotencyKey: retry });
  else
    stdout.write(
      `${formatFeedDrop(result)}${retry === undefined ? "" : `\nRetry with --key ${retry}: it never files twice.`}\n`,
    );
  return result.outcome === "filed" ? 0 : 1;
}

/**
 * `clankie feed check`: an agent asks the owner to look at one thing. The line is
 * what the owner reads, so it says exactly what to look at; the host refuses one
 * over 140 characters. The key makes a retry safe and is printed for that.
 */
async function runFeedCheckCommand(args: readonly string[], options: FeedCommandOptions): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      project: { type: "string" },
      conversation: { type: "string" },
      longer: { type: "boolean" },
      evidence: { type: "string" },
      "waiting-on": { type: "string" },
      key: { type: "string" },
      json: { type: "boolean" },
    },
  });
  if (positionals.length !== 1) throw new Error(FEED_USAGE);
  const key = values.key ?? randomBytes(18).toString("base64url");
  const draft = FeedCheckRequestSchema.refine(feedCheckHasOneSource, FEED_CHECK_ONE_SOURCE).safeParse({
    idempotencyKey: key,
    check: positionals[0],
    ...(values.longer ? { longer: true } : {}),
    ...(values.project === undefined ? {} : { projectId: values.project }),
    ...(values.conversation === undefined ? {} : { conversationId: values.conversation }),
    ...(values.evidence === undefined ? {} : { evidence: values.evidence }),
    ...(values["waiting-on"] === undefined ? {} : { waitingOn: values["waiting-on"] }),
  });
  if (!draft.success) throw new Error(`${FEED_USAGE}\n${draft.error.issues[0]?.message ?? ""}`);
  const client = await ownerClient(options, "Asking the owner for a check");
  let result: FeedCheckResult;
  try {
    result = await client.feedCheck!(draft.data);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\nThe check may or may not be asked. Retry with --key ${key}: it never asks twice.`,
    );
  }
  const stdout = options.stdout ?? process.stdout;
  // An unavailable check may already be asked: keep the key so a retry finds it.
  const retry = result.outcome === "unavailable" ? key : undefined;
  if (values.json) outputJson(stdout, retry === undefined ? result : { ...result, idempotencyKey: retry });
  else
    stdout.write(
      `${formatFeedCheck(result)}${retry === undefined ? "" : `\nRetry with --key ${retry}: it never asks twice.`}\n`,
    );
  return result.outcome === "raised" ? 0 : 1;
}

export function formatFeedCheck(result: FeedCheckResult): string {
  if (result.outcome !== "raised") return result.message;
  const { question } = result.item.check;
  const state =
    question.status === "pending"
      ? "The owner sees it in the feed; the answer wakes"
      : "The owner already answered it in";
  return [
    `${result.duplicate ? "Already asked" : "Asked"}: ${result.item.check.line ?? question.prompt}${result.item.check.longer ? " (takes longer)" : ""}`,
    `${state} conversation ${question.conversationId}.`,
    `Request: ${question.requestId}`,
  ].join("\n");
}

export function formatFeedDrop(result: FeedDropResult): string {
  if (result.outcome !== "filed") return result.message;
  const item = result.item;
  const title = item.drop.title;
  const wake =
    result.wake === "woken"
      ? `Woke its lead${result.leadConversationId ? ` (${result.leadConversationId})` : ""} to refine it.`
      : result.wake === "uncertain"
        ? "An earlier try may already have woken its lead, so it was not woken again."
        : "No lead could be woken; the file waits for the next agent that reads the project's work.";
  return [
    `${result.duplicate ? "Already filed" : "Filed"}: ${title}${item.projectId ? ` · ${item.projectId}` : ""}`,
    `File: ${result.file}`,
    wake,
  ].join("\n");
}

/** `/feed [PROJECT] [--details]` in the console: the same page as text. */
export function feedConsoleCommand(client: OperatorConversationServiceClient) {
  return async (argument: string): Promise<string> => {
    const words = argument.trim().split(/\s+/u).filter(Boolean);
    const details = words.includes("--details");
    const [projectId, ...extra] = words.filter((word) => word !== "--details");
    const request = FeedListRequestSchema.safeParse(projectId ? { projectId } : {});
    if (extra.length || !request.success) throw new Error("Usage: /feed [PROJECT_ID] [--details]");
    if (!client.feedList) throw new Error("The feed is unavailable");
    return formatFeedPage(await client.feedList(request.data), request.data, { details });
  };
}

/**
 * `/drop [--key KEY] PROJECT TEXT` in the console: a text drop into a project.
 * Each call makes its own key unless one is given; files go through
 * `clankie feed drop --file`. A lost or unavailable answer names the key, since
 * the drop may already be written and a retry with it never files twice.
 */
export function feedDropConsoleCommand(client: OperatorConversationServiceClient) {
  return async (argument: string): Promise<string> => {
    const match = /^\s*(?:--key\s+([\w-]{16,128})\s+)?(\S+)\s+([\s\S]*\S)\s*$/u.exec(argument);
    if (!match || match[2] === "--key") throw new Error("Usage: /drop [--key KEY] PROJECT_ID TEXT");
    if (!client.feedDrop) throw new Error("Drops are unavailable");
    const key = match[1] ?? randomBytes(18).toString("base64url");
    const [projectId, body] = [match[2]!, match[3]!];
    const retry = `Retry with /drop --key ${key} ${projectId} ${body}: it never files twice.`;
    let result: FeedDropResult;
    try {
      result = await client.feedDrop({ projectId, idempotencyKey: key, body });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\nThe drop may or may not be filed. ${retry}`,
      );
    }
    return result.outcome === "unavailable" ? `${formatFeedDrop(result)}\n${retry}` : formatFeedDrop(result);
  };
}

/** How a page reads: plain words for people, or with every id and command (`--details`). */
export interface FeedPageFormat {
  readonly details?: boolean;
  readonly now?: number;
}

/**
 * One page for people (#187): grouped by project, each item its picture first,
 * then one plain line. `--details` adds the ids and the exact answer and dismiss
 * commands. The continuation repeats the filter, since the cursor only marks a
 * place in the page.
 */
export function formatFeedPage(
  page: FeedPage,
  request: FeedListRequest = {},
  format: FeedPageFormat = {},
): string {
  if (page.outcome !== "ready") return page.message;
  const groups = new Map<string, string[]>();
  for (const item of page.items) {
    const name = item.view?.project ?? item.projectId ?? "Not in a project";
    const group = groups.get(name) ?? [];
    group.push(formatFeedItem(item, format));
    groups.set(name, group);
  }
  // A project's group sits where its newest item is; items outside any project come last.
  const outside = groups.get("Not in a project");
  groups.delete("Not in a project");
  if (outside) groups.set("Not in a project", outside);
  const blocks = [...groups].map(([name, items]) => [name, ...items].join("\n\n"));
  const lines: string[] = [];
  for (const missing of page.unreadable ?? [])
    lines.push(
      `Couldn't read ${missing.projectId ?? "a project"}'s updates just now.${format.details ? ` ${missing.repoId}: ${missing.message}` : ""}`,
    );
  const flags = `${request.projectId === undefined ? "" : ` --project ${request.projectId}`}${
    request.limit === undefined ? "" : ` --limit ${request.limit}`
  }`;
  if (page.nextCursor)
    lines.push(`More: clankie feed${flags}${format.details ? " --details" : ""} --cursor ${page.nextCursor}`);
  if (blocks.length && !format.details)
    lines.push(
      `Answer, dismiss or give a verdict in the Clankie app. Ids and commands: clankie feed${flags} --details`,
    );
  if (!blocks.length && !lines.length) return "Nothing in the feed";
  return [...blocks, lines.join("\n")].filter(Boolean).join("\n\n");
}

const indent = (lines: readonly string[]) => lines.filter(Boolean).map((line) => `  ${line}`);

function when(at: string, now: number): string {
  const ago = Math.max(0, now - Date.parse(at));
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} h ago`;
  if (ago < 7 * 86_400_000) return `${Math.floor(ago / 86_400_000)} d ago`;
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function mediaLine(media: FeedMedia): string {
  const clip = media.mimeType?.startsWith("video/") ?? /\.(?:mp4|mov|webm|m4v)$/iu.test(media.url);
  return `${clip ? "Clip" : "Picture"}: ${media.alt ? `${media.alt} ` : ""}${media.url}`;
}

/** The view an older host left out, built from the payload. */
function viewOf(item: FeedItem): FeedView {
  if (item.view) return item.view;
  const caption =
    item.kind === "check"
      ? (item.check.line ?? item.check.question.prompt)
      : item.kind === "proof"
        ? item.proof.line
        : item.kind === "drop"
          ? item.drop.title
          : (item.update.title ?? item.update.body.split("\n")[0] ?? "Update");
  const media =
    item.kind === "check"
      ? item.check.media
      : item.kind === "proof"
        ? item.proof.media
        : item.kind === "drop"
          ? item.drop.media
          : item.update.media;
  return { caption: caption.slice(0, 160) || "Update", ...(media?.[0] ? { visual: media[0] } : {}) };
}

function formatFeedItem(item: FeedItem, format: FeedPageFormat): string {
  const view = viewOf(item);
  const now = format.now ?? Date.now();
  const media =
    item.kind === "check"
      ? item.check.media
      : item.kind === "proof"
        ? item.proof.media
        : item.kind === "drop"
          ? item.drop.media
          : item.update.media;
  const rest = (media ?? []).filter((entry) => entry.url !== view.visual?.url);
  const picture = [
    view.visual ? mediaLine(view.visual) : "",
    ...(format.details ? rest.map(mediaLine) : rest.length ? [`and ${rest.length} more to look at`] : []),
  ];
  let heading: string;
  const body: string[] = [];
  const commands: string[] = [];
  if (item.kind === "check") {
    const { question, revision, longer } = item.check;
    heading = `Check${longer ? ", takes longer than a quick look" : ""}`;
    body.push(
      `Answers: ${question.options.map((option) => option.label).join(", ")}${
        question.recommendation ? ` (Clankie suggests ${question.recommendation})` : ""
      }`,
    );
    for (const option of question.options) commands.push(`Option ${option.label}: ${option.optionId}`);
    commands.push(
      `Answer: clankie conversations answer ${question.conversationId} ${question.requestId} --incarnation ${question.incarnationId} --revision ${revision} (--option UUID | --text TEXT)`,
    );
  } else if (item.kind === "proof") {
    heading = "Finished, check it";
    body.push(item.proof.title !== view.caption ? item.proof.title : "");
    body.push("Answer on your paired phone: It works, or Send it back with a note");
  } else if (item.kind === "drop") {
    const { drop } = item;
    const from =
      drop.source?.kind === "machine"
        ? ", from this machine"
        : drop.source?.name
          ? `, from ${drop.source.name}`
          : "";
    const status = drop.status && drop.status !== "todo" ? `, ${drop.status.replace(/_/gu, " ")}` : "";
    heading = `Your drop${from}${status}`;
    const text = drop.bodyTruncated ? `${drop.body}…` : drop.body;
    if (text.trim() && text.trim() !== view.caption) body.push(text.trim());
  } else {
    const { update } = item;
    heading = update.ownerUpdate
      ? `News${update.ownerUpdate.state === "unread" ? ", new" : ""}`
      : "Project update";
    // A project update's caption is its first line; the rest reads below, its pictures already listed.
    const text = (update.bodyTruncated ? `${update.body}…` : update.body)
      .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/gu, "")
      .replace(/\*\*|__/gu, "")
      .replace(/\n{3,}/gu, "\n\n")
      .trim();
    const shown = update.projectUpdate ? text.replace(/^[^\n]*\n?/u, "").trim() : text;
    if (shown && shown !== view.caption) body.push(shown);
    for (const link of update.links ?? []) body.push(`${link.label}: ${link.url}`);
    if (update.ownerUpdate)
      commands.push(`Dismiss: clankie conversations dismiss-update ${update.ownerUpdate.id}`);
  }
  const lines = [`${heading} · ${when(item.at, now)}`, ...picture, view.caption, ...body];
  if (format.details)
    lines.push(
      "Details:",
      ...[
        `Feed item: ${item.id}`,
        `At: ${item.at}`,
        ...(view.details ?? []).map((d) => `${d.label}: ${d.value}`),
        ...commands,
      ].map((line) => `  ${line}`),
    );
  return indent(lines.flatMap((line) => line.split("\n"))).join("\n");
}
