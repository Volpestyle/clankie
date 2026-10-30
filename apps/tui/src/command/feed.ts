import { parseArgs } from "node:util";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  FEED_LIST_LIMIT_MAX,
  FeedListRequestSchema,
  type FeedItem,
  type FeedPage,
  type OperatorConversationServiceClient,
} from "@clankie/protocol";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import { commandHost, outputJson, type Writable } from "./io.ts";

export const FEED_USAGE =
  "Usage: clankie feed [--project ID] [--cursor CURSOR] [--limit N] [--json]   (owner checks and updates, newest first)";

export interface FeedCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly stdout?: Writable;
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
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      project: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "string" },
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
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential) throw new Error("The feed needs the owner operator credential. Run clankie doctor.");
  // The operator credential is the owner on this machine, so it is also the owner transport.
  const owner = createCaptainRouteClient({
    host: commandHost({ ...options, env }),
    captainToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const page = await createCaptainOperatorConversationClient(owner, owner).feedList!(request.data);
  const stdout = options.stdout ?? process.stdout;
  if (values.json) outputJson(stdout, page);
  else stdout.write(`${formatFeedPage(page)}\n`);
  return page.outcome === "ready" ? 0 : 1;
}

/** `/feed [PROJECT]` in the console: the same page as text. */
export function feedConsoleCommand(client: OperatorConversationServiceClient) {
  return async (argument: string): Promise<string> => {
    const [projectId, ...extra] = argument.trim().split(/\s+/u).filter(Boolean);
    const request = FeedListRequestSchema.safeParse(projectId ? { projectId } : {});
    if (extra.length || !request.success) throw new Error("Usage: /feed [PROJECT_ID]");
    if (!client.feedList) throw new Error("The feed is unavailable");
    return formatFeedPage(await client.feedList(request.data));
  };
}

export function formatFeedPage(page: FeedPage): string {
  if (page.outcome !== "ready") return page.message;
  const lines = page.items.map(formatFeedItem);
  for (const missing of page.unreadable ?? [])
    lines.push(`Not included: ${missing.projectId ?? missing.repoId}: ${missing.message}`);
  if (page.nextCursor) lines.push(`More: clankie feed --cursor ${page.nextCursor}`);
  return lines.length ? lines.join("\n\n") : "Nothing in the feed";
}

function formatFeedItem(item: FeedItem): string {
  const project = item.projectId ? ` · ${item.projectId}` : "";
  if (item.kind === "check") {
    const { question, revision } = item.check;
    return [
      `Check${project} · ${item.at}`,
      question.prompt,
      ...question.options.map((option) => `  - ${option.label} (${option.optionId})`),
      question.recommendation ? `Recommended: ${question.recommendation}` : "",
      question.waitingOn ? `Waiting on it: ${question.waitingOn}` : "",
      question.issue ? `Issue: ${question.issue.key} — ${question.issue.url}` : "",
      `Answer: clankie conversations answer ${question.conversationId} ${question.requestId} --incarnation ${question.incarnationId} --revision ${revision} (--option UUID | --text TEXT)`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (item.kind === "update") {
    const { update } = item;
    const heading = update.ownerUpdate
      ? `${update.title ?? "Update"} (${update.ownerUpdate.state})`
      : `Project update${update.projectUpdate?.health ? ` (${update.projectUpdate.health})` : ""}`;
    return [
      `${heading}${project} · ${item.at}`,
      update.bodyTruncated ? `${update.body}…` : update.body,
      update.issue ? `Issue: ${update.issue.key} — ${update.issue.url}` : "",
      ...(update.links ?? []).map((link) => `${link.label}: ${link.url}`),
      ...(update.media ?? []).map((media) => `${media.alt ?? media.mimeType ?? "Media"}: ${media.url}`),
      update.ownerUpdate ? `Dismiss: clankie conversations dismiss-update ${update.ownerUpdate.id}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [`Drop${project} · ${item.at}`, item.drop.title, item.drop.body].filter(Boolean).join("\n");
}
