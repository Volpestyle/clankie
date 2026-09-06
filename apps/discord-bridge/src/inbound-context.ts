/**
 * Which messages a thread's context window carries.
 *
 * A thread opened from a message keeps that message in the parent channel, so
 * `thread.messages.fetch` never returns it. Everyone in Discord sees that
 * opening post sitting at the top of the thread; without this, Clankie is the
 * only participant who cannot, which is how a picture someone started a thread
 * about goes missing when they tag him in it.
 *
 * Forum and media posts already carry their opening message inside the thread,
 * so a starter that is already present is left alone rather than duplicated.
 */
export function threadContextWindow<T extends { readonly id: string }>(
  ordered: readonly T[],
  starter: T | null,
  limit: number,
): readonly T[] {
  if (starter === null || ordered.some((candidate) => candidate.id === starter.id)) return ordered;
  // The opening post is what the thread is about, so it keeps its slot rather
  // than being the first thing the downstream recency bound drops.
  return [starter, ...(limit <= 1 ? [] : ordered.slice(-(limit - 1)))];
}
