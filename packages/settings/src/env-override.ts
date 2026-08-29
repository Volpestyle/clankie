/**
 * Environment-wins merge used by Discord and voice settings. Secrets never
 * take this path: an env token is a hard error in the credential broker.
 */
export function envOverrideReaders(env: NodeJS.ProcessEnv): {
  overridden: string[];
  takeString(merged: Record<string, unknown>, field: string, name: string): void;
  takeList(merged: Record<string, unknown>, field: string, name: string): void;
  takeBoolean(merged: Record<string, unknown>, field: string, name: string): void;
  takeInteger(merged: Record<string, unknown>, field: string, name: string): void;
} {
  const overridden: string[] = [];
  return {
    overridden,
    takeString(merged, field, name) {
      const value = env[name]?.trim();
      if (value === undefined || value.length === 0) return;
      merged[field] = value;
      overridden.push(name);
    },
    takeList(merged, field, name) {
      const value = env[name];
      if (value === undefined) return;
      merged[field] = value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      overridden.push(name);
    },
    takeBoolean(merged, field, name) {
      const value = env[name]?.trim();
      if (value === undefined || value.length === 0) return;
      merged[field] = value === "true";
      overridden.push(name);
    },
    takeInteger(merged, field, name) {
      const value = env[name]?.trim();
      if (value === undefined || value.length === 0) return;
      const parsed = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(parsed)) return;
      merged[field] = parsed;
      overridden.push(name);
    },
  };
}
