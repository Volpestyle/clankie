/** Encode a reaction for the Discord REST path (unicode or name:id custom). */
export function encodeReactionEmoji(emoji: string): string {
  const trimmed = emoji.trim();
  const mentioned = /^<a?:([a-zA-Z0-9_]{2,32}):(\d+)>$/u.exec(trimmed);
  if (mentioned) return `${mentioned[1]}:${mentioned[2]}`;
  if (/^[a-zA-Z0-9_]{2,32}:\d+$/u.test(trimmed)) return trimmed;
  if (trimmed.includes(":")) throw new Error("discord_presence_invalid_emoji");
  return encodeURIComponent(trimmed);
}
