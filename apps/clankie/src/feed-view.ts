import {
  FEED_CAPTION_MAX,
  FEED_DETAILS_MAX,
  type FeedDetail,
  type FeedItem,
  type FeedMedia,
  type FeedView,
} from "@clankie/protocol";

/**
 * The words a person shouldn't have to read on the first line (#187): internal
 * ids, panes, hashes and evidence links. Each match leaves the caption and is
 * kept in the item's details.
 */
const JARGON = [
  // Request, conversation, session and receipt ids.
  /\b(?:conv-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
  /\b(?:cmsg|cse|session|term|lsrq|trig)_[A-Za-z0-9_-]{4,}/gu,
  // Herdr panes and desktop terminals.
  /\bherdr(?:-core)?:[\w.:/-]+/gu,
  /\b[\w-]+:t[0-9a-f]*[0-9][0-9a-f]*\b/gu,
  // Evidence and tracker links: the visual itself, or the item's own record.
  /\bclankie(?:-work)?:\/\/\S+/gu,
  // Hashes and commit shas: hex runs with a digit and a letter.
  /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/giu,
];

/** One line in plain words, and what was taken out of it. */
function plainCaption(text: string): { caption: string; removed: string[] } {
  const removed: string[] = [];
  const first = text.split(/\r?\n/u).find((part) => part.trim() !== "") ?? "";
  let line = first;
  for (const pattern of JARGON)
    // A word that only pointed at the removed one ("in herdr-core:t3") goes with it.
    line = line.replace(
      new RegExp(`(?:\\b(?:in|on|at|for|to|from|of|via)\\s+)?(${pattern.source})`, pattern.flags),
      (_, match: string) => {
        if (!removed.includes(match)) removed.push(match);
        return " ";
      },
    );
  removed.sort((a, b) => first.indexOf(a) - first.indexOf(b));
  line = line
    // Markdown that only marks up: emphasis, headings, code ticks, link targets.
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/gu, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/gu, "$1")
    .replace(/^\s*(?:#{1,6}|[-*>]|\d+\.)\s+/u, "")
    .replace(/`/gu, "")
    // What a removed word leaves behind.
    .replace(/\(\s*[,;:]?\s*\)|\[\s*\]/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ")
    .replace(/[\s,;:(-]+$/u, "")
    .trim();
  if (line.length > FEED_CAPTION_MAX) line = `${line.slice(0, FEED_CAPTION_MAX - 1).trimEnd()}…`;
  return { caption: line, removed };
}

function isClip(media: FeedMedia): boolean {
  return media.mimeType?.startsWith("video/") ?? /\.(?:mp4|mov|webm|m4v)(?:$|[?#])/iu.test(media.url);
}
function isPicture(media: FeedMedia): boolean {
  return (
    media.mimeType?.startsWith("image/") ?? /\.(?:png|jpe?g|gif|webp|svg|avif)(?:$|[?#])/iu.test(media.url)
  );
}
/** The one thing to look at first: a clip, then a picture, then whatever comes first. */
function leadVisual(media: readonly FeedMedia[] | undefined): FeedMedia | undefined {
  return media?.find(isClip) ?? media?.find(isPicture) ?? media?.[0];
}

const HEALTH: Record<string, string> = {
  onTrack: "On track",
  on_track: "On track",
  atRisk: "At risk",
  at_risk: "At risk",
  offTrack: "Off track",
  off_track: "Off track",
};

/**
 * Plain words for each kind, with its ids folded into the details. `project` is
 * the project's name; `details` is an owner update's own technical side.
 */
export function feedView(item: FeedItem, context: { project?: string; details?: string } = {}): FeedView {
  const details: FeedDetail[] = [];
  const add = (label: string, value: string | number | undefined) => {
    if (value !== undefined && String(value).trim() !== "")
      details.push({ label, value: String(value).slice(0, 2000) });
  };
  let source: string;
  let fallback: string;
  let media: readonly FeedMedia[] | undefined;
  if (item.kind === "check") {
    const { question, revision } = item.check;
    source = item.check.line ?? question.prompt;
    fallback = "Something to check";
    media = item.check.media;
    if (item.check.line !== undefined && item.check.line !== question.prompt) add("Asked", question.prompt);
    add("Waiting on it", question.waitingOn);
    add("Conversation", question.conversationId);
    add("Request", question.requestId);
    add("Incarnation", question.incarnationId);
    add("Revision", revision);
    if (question.issue) add("Issue", `${question.issue.key} ${question.issue.url}`);
  } else if (item.kind === "proof") {
    const { proof } = item;
    source = proof.line;
    fallback = `Finished: ${proof.title}`;
    media = proof.media;
    add("Item", `${proof.key}: ${proof.title}`);
    add("Stage", proof.stage);
    add("Issue id", proof.issueId);
    add("Proof bundle", proof.bundleId);
    add("Link", proof.url);
  } else if (item.kind === "drop") {
    const { drop } = item;
    source = drop.title;
    fallback = "Something you dropped";
    media = drop.media;
    add("Item", drop.itemId);
    add("Repo", drop.repoId);
    add("Status", drop.status);
    if (drop.posted)
      add("Posted to", [drop.posted.tracker, drop.posted.key, drop.posted.url].filter(Boolean).join(" "));
  } else {
    const { update } = item;
    media = update.media;
    if (update.projectUpdate) {
      const health = update.projectUpdate.health;
      const said = plainCaption(update.body).caption;
      source = health && HEALTH[health] ? `${HEALTH[health]}${said ? `: ${said}` : ""}` : said;
      fallback = "Project update";
      add("Health", health);
      add("Author", update.projectUpdate.author);
      add("Update id", update.projectUpdate.id);
      add("Tracker", update.projectUpdate.repoId);
    } else {
      source = update.title ?? update.body;
      fallback = "News";
      add("From conversation", update.ownerUpdate?.conversationId);
      add("From agent", update.ownerUpdate?.seatId);
      add("Mail id", update.ownerUpdate?.id);
    }
    if (update.issue) add("Issue", `${update.issue.key} ${update.issue.url}`);
  }
  const plain = plainCaption(source);
  if (plain.removed.length) {
    add("Taken from the line", plain.removed.join(", "));
    add(
      "Original line",
      source.split(/\r?\n/u).find((part) => part.trim() !== ""),
    );
  }
  add("Details", context.details);
  const visual = leadVisual(media);
  return {
    caption: plain.caption || fallback,
    ...(context.project ? { project: context.project } : {}),
    ...(visual ? { visual } : {}),
    ...(details.length ? { details: details.slice(0, FEED_DETAILS_MAX) } : {}),
  };
}
