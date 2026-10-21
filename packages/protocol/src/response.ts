import { z } from "zod";

type UnknownKeys = Extract<z.core.$ZodIssue, { code: "unrecognized_keys" }>;
type UnknownValue = Extract<z.core.$ZodIssue, { code: "invalid_value" }>;

const ADDITIVE_VALUE = "Unknown value in an additive protocol list";

/** A response enum a newer host may extend (ADR 0016). Strict parsing still
 * rejects an unknown value; a response reader drops the nearest list entry
 * that holds one and keeps the rest. Use it only where a client can leave out
 * an entry it does not understand, such as a display catalog. Statuses,
 * versions and discriminators a client must act on stay plain enums.
 */
export function additiveEnum<const T extends readonly string[]>(values: T) {
  return z.enum(values, {
    error: (issue) =>
      typeof issue.input === "string" ? `${ADDITIVE_VALUE}; expected one of ${values.join("|")}` : undefined,
  });
}

function additiveIssues(
  issues: readonly z.core.$ZodIssue[],
  parent: PropertyKey[] = [],
): (UnknownKeys | UnknownValue)[] | undefined {
  const unknown: (UnknownKeys | UnknownValue)[] = [];
  for (const issue of issues) {
    const path = [...parent, ...issue.path];
    if (issue.code === "unrecognized_keys") unknown.push({ ...issue, path });
    else if (issue.code === "invalid_value" && issue.message.startsWith(`${ADDITIVE_VALUE};`))
      unknown.push({ ...issue, path });
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
 * Optional host additions may retain the wire version (ADR 0016), and so may
 * new values of an `additiveEnum`: their list entries are dropped. Requests,
 * persisted state and cryptographic envelopes still use their strict schemas.
 * No schema is weakened: only reported unknown keys and additive list entries
 * are removed, then the original schema validates the known shape again.
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
  const drops = new Map<unknown[], Set<number>>();
  const affected = new WeakSet<object>();
  for (const issue of issues) {
    let target = value;
    let entry: [unknown[], number] | undefined;
    for (const key of issue.path) {
      if (target === null || typeof target !== "object") return parsed;
      affected.add(target);
      if (Array.isArray(target) && typeof key === "number") entry = [target, key];
      target = (target as Record<PropertyKey, unknown>)[key];
    }
    if (issue.code === "invalid_value") {
      // An unknown additive value removes the list entry that holds it.
      if (entry === undefined) return parsed;
      const indexes = drops.get(entry[0]) ?? new Set<number>();
      indexes.add(entry[1]);
      drops.set(entry[0], indexes);
      continue;
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
    if (Array.isArray(input)) {
      const dropped = drops.get(input);
      return input.filter((_, index) => !dropped?.has(index)).map(strip);
    }
    const omitted = omissions.get(input);
    return Object.fromEntries(
      Object.entries(input)
        .filter(([key]) => !omitted?.has(key))
        .map(([key, entry]) => [key, strip(entry)]),
    );
  };
  return schema.safeParse(strip(value));
}
