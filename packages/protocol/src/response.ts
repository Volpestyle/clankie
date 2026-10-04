import type { z } from "zod";

type UnknownKeys = Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }>;

function additiveIssues(
  issues: readonly z.core.$ZodIssue[],
  parent: PropertyKey[] = [],
): UnknownKeys[] | undefined {
  const unknown: UnknownKeys[] = [];
  for (const issue of issues) {
    const path = [...parent, ...issue.path];
    if (issue.code === "unrecognized_keys") unknown.push({ ...issue, path });
    else if (issue.code === "invalid_union") {
      // A plain union can wrap the unknown-key errors of an otherwise valid
      // branch. Select only a branch with no known-field validation failure.
      const branch = issue.errors
        .map((errors) => additiveIssues(errors, path))
        .find((candidate) => candidate !== undefined);
      if (branch === undefined) return undefined;
      unknown.push(...branch);
    } else return undefined;
  }
  return unknown;
}

/** Read a versioned JSON response using the fields this client knows.
 * Optional host additions may retain the wire version (ADR 0016). Requests,
 * persisted state and cryptographic envelopes still use their strict schemas.
 * No schema is weakened: only reported unknown keys are removed, then the
 * original schema validates the complete known shape again.
 */
export function parseProtocolResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = safeParseProtocolResponse(schema, value);
  if (!parsed.success) throw parsed.error;
  return parsed.data;
}

export function safeParseProtocolResponse<T>(schema: z.ZodType<T>, value: unknown): z.ZodSafeParseResult<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed;
  const issues = additiveIssues(parsed.error.issues);
  if (issues === undefined || issues.length === 0) return parsed;
  const omissions = new Map<object, Set<string>>();
  const affected = new WeakSet<object>();
  for (const issue of issues) {
    let target = value;
    for (const key of issue.path) {
      if (target === null || typeof target !== "object") return parsed;
      affected.add(target);
      target = (target as Record<PropertyKey, unknown>)[key];
    }
    if (target === null || typeof target !== "object") return parsed;
    affected.add(target);
    const keys = omissions.get(target) ?? new Set<string>();
    for (const key of issue.keys) keys.add(key);
    omissions.set(target, keys);
  }
  const strip = (input: unknown): unknown => {
    // Clone only paths with an omission. Opaque, schema-approved tool data
    // does not need traversal and may itself be deeply nested JSON.
    if (input === null || typeof input !== "object" || !affected.has(input)) return input;
    if (Array.isArray(input)) return input.map(strip);
    const omitted = omissions.get(input);
    return Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => !omitted?.has(key))
        .map(([key, entry]) => [key, strip(entry)]),
    );
  };
  return schema.safeParse(strip(value));
}
