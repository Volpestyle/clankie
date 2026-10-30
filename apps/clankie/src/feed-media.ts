import { FeedItemSchema, type FeedItem, type FeedMedia } from "@clankie/protocol";
import { evidenceLink } from "@clankie/protocol/evidence";
import type { EvidenceStore } from "./evidence-store.ts";

export type EvidenceTypes = Pick<EvidenceStore, "recordForBlob">;

const EVIDENCE = /^clankie:\/\/evidence\/sha256\/([0-9a-f]{64})$/u;

/** The blob hash of an evidence-store link (ADR 0258), or undefined for any other URL. */
export function evidenceHash(url: string): string | undefined {
  return EVIDENCE.exec(url)?.[1];
}

/** One evidence-store record as feed media: its link, and its type once known. */
export function evidenceMedia(sha256: string, alt?: string): FeedMedia {
  return { url: evidenceLink(sha256), ...(alt === undefined ? {} : { alt: alt.slice(0, 500) }) };
}

/**
 * Fills the content type of every evidence link on a feed page from its evidence
 * record, whatever the item's kind; links the store does not hold, and any other
 * URL, stay as they are. Each blob is looked up once per page.
 */
export async function withEvidenceTypes(
  page: readonly FeedItem[],
  evidence: EvidenceTypes | undefined,
): Promise<FeedItem[]> {
  if (evidence === undefined) return [...page];
  const types = new Map<string, Promise<string | undefined>>();
  const type = (sha256: string) => {
    let found = types.get(sha256);
    if (found === undefined) {
      found = evidence
        .recordForBlob(sha256)
        .then((record) => record?.contentType)
        // allow-swallowed-rejection -- an unreadable record leaves the link without a type; it still shows
        .catch(() => undefined);
      types.set(sha256, found);
    }
    return found;
  };
  const fill = (media: readonly FeedMedia[]) =>
    Promise.all(
      media.map(async (entry) => {
        const sha256 = evidenceHash(entry.url);
        if (sha256 === undefined || entry.mimeType !== undefined) return entry;
        const mimeType = await type(sha256);
        return mimeType === undefined ? entry : { ...entry, mimeType };
      }),
    );
  return Promise.all(
    page.map(async (item) => {
      const payload: { media?: FeedMedia[] | undefined } | undefined =
        item.kind === "check"
          ? item.check
          : item.kind === "update"
            ? item.update
            : item.kind === "drop"
              ? item.drop
              : item.proof;
      if (!payload?.media?.length) return item;
      const media = await fill(payload.media);
      return FeedItemSchema.parse({ ...item, [item.kind]: { ...payload, media } }) as FeedItem;
    }),
  );
}
