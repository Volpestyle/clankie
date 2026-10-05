/**
 * A Linear write answers with the whole saved record: the description the
 * caller just sent, every comment body, and signed attachment URLs that expire
 * in minutes. That is context the writer already has, so a write returns a
 * receipt instead: what was saved, where, and its state. Reads are untouched;
 * they select their own fields.
 */
const ISSUE_FIELDS = [
  "id",
  "identifier",
  "uuid",
  "name",
  "title",
  "url",
  "status",
  "state",
  "priority",
  "assignee",
  "project",
  "parentId",
  "updatedAt",
  "completedAt",
  "canceledAt",
] as const;
const PREVIEW = 160;

export function compactLinearWrite(tool: string, content: string): string {
  if (!/^(save|create)_/u.test(tool)) return content;
  let record: unknown;
  try {
    record = JSON.parse(content);
  } catch {
    return content;
  }
  if (typeof record !== "object" || record === null || Array.isArray(record)) return content;
  const source = record as Record<string, unknown>;
  const receipt: Record<string, unknown> = {};
  for (const key of ISSUE_FIELDS)
    if (source[key] !== undefined && source[key] !== null) receipt[key] = source[key];
  if (receipt.id === undefined && source.id !== undefined) receipt.id = source.id;
  for (const key of ["body", "description", "content"] as const) {
    const text = source[key];
    if (typeof text === "string")
      receipt[key] = text.length > PREVIEW ? `${text.slice(0, PREVIEW)}… (${text.length} chars saved)` : text;
  }
  if (Array.isArray(source.labels)) receipt.labels = source.labels;
  if (Array.isArray(source.attachments))
    receipt.attachments = source.attachments.map((attachment) =>
      typeof attachment === "object" && attachment !== null
        ? { id: (attachment as { id?: unknown }).id, title: (attachment as { title?: unknown }).title }
        : attachment,
    );
  if (typeof source.author === "object" && source.author !== null)
    receipt.author = (source.author as { name?: unknown }).name;
  if (source.createdAt !== undefined) receipt.createdAt = source.createdAt;
  return JSON.stringify(receipt);
}
