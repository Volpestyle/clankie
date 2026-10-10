import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { primeAgentDir } from "@clankie/agent-hosts";
import type { PrimeSpend, WorkerAccountStatus } from "./harness-accounts.ts";

const WEEK_MS = 7 * 86_400_000;
const LABEL = /^[a-z][a-z0-9_-]{0,63}$/u;

/**
 * Prime Agent's providers on this Mac (VUH-1556): how each is signed in to
 * Prime, from its `auth.json` kinds only, and what its API keys spent, from
 * Prime's own session transcripts. Of each sign-in only its kind and, for
 * ChatGPT, its account id (to find the Codex home it shares limits with) are
 * read; no credential leaves this function.
 */
export function readPrimeAccounts(
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: number;
  } = {},
): WorkerAccountStatus[] {
  const now = options.now ?? Date.now();
  const dir = primeAgentDir(options.env ?? process.env);
  let auth: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      auth = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const spend = primeSpend(dir, now);
  const providers = [...new Set([...Object.keys(auth), ...spend.keys()])].filter((name) => LABEL.test(name));
  return providers.sort().map((provider) => {
    const entry = auth[provider] as { type?: unknown; accountId?: unknown } | undefined;
    const credential =
      entry?.type === "api_key" ? "api_key" : entry?.type === "oauth" ? "subscription" : undefined;
    const chatgptAccountId =
      credential === "subscription" && provider === "openai-codex" && typeof entry?.accountId === "string"
        ? entry.accountId
        : undefined;
    let reason: string | undefined;
    if (credential === undefined)
      reason = "Prime used this provider, but its sign-in is not in Prime's auth.json; kind unknown";
    else if (credential === "subscription")
      reason =
        provider === "openai-codex"
          ? "draws from a ChatGPT/Codex subscription that is not one of Clankie's Codex accounts; limits unknown"
          : provider === "anthropic"
            ? "draws from a Claude subscription; Prime's sign-in does not say which account, so limits are unknown"
            : "draws from a subscription Clankie does not read; limits unknown";
    const used = spend.get(provider) ?? (credential === "api_key" ? emptySpend(now) : undefined);
    return {
      harness: "prime",
      label: provider,
      home: dir,
      signedIn: credential !== undefined ? true : null,
      ...(credential === undefined ? {} : { credential }),
      headroom: null,
      ...(chatgptAccountId === undefined ? {} : { chatgptAccountId }),
      ...(used === undefined || credential === "subscription" ? {} : { spend: used }),
      usable: false,
      // A Prime seat picks its own provider; Clankie never allocates hires to one.
      reason: reason ?? "API key, billed per token",
    };
  });
}

function emptySpend(now: number): PrimeSpend {
  return {
    source: "prime-transcripts",
    observedAt: new Date(now).toISOString(),
    today: { costUsd: 0, tokens: 0 },
    week: { costUsd: 0, tokens: 0 },
  };
}

/**
 * Cost and tokens per provider from every Prime transcript touched in the last
 * week, root sessions and their subagents alike. The cost is Prime's own
 * per-message estimate at the model's list price.
 */
function primeSpend(dir: string, now: number): Map<string, PrimeSpend> {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  const since = now - WEEK_MS;
  const totals = new Map<string, PrimeSpend>();
  const add = (provider: string, at: number, cost: number, tokens: number) => {
    const entry = totals.get(provider) ?? emptySpend(now);
    entry.week.costUsd += cost;
    entry.week.tokens += tokens;
    if (at >= midnight) {
      entry.today.costUsd += cost;
      entry.today.tokens += tokens;
    }
    totals.set(provider, entry);
  };
  for (const file of transcripts(dir, since)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.startsWith('{"type":"session"')) continue;
    for (const line of text.split("\n")) {
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      let row: { type?: unknown; timestamp?: unknown; message?: Record<string, unknown> };
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const message = row.message;
      if (row.type !== "message" || message?.role !== "assistant" || typeof message.provider !== "string")
        continue;
      const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
      if (!(at >= since)) continue;
      const usage = message.usage as { totalTokens?: unknown; cost?: { total?: unknown } } | undefined;
      const cost = typeof usage?.cost?.total === "number" ? usage.cost.total : 0;
      const tokens = typeof usage?.totalTokens === "number" ? usage.totalTokens : 0;
      add(message.provider, at, cost, tokens);
    }
  }
  return totals;
}

/** `sessions/*.jsonl` and each subagent's transcript under `session-artifacts/`, written since `since`. */
function transcripts(dir: string, since: number): string[] {
  const found: string[] = [];
  const walk = (path: string, depth: number) => {
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = join(path, entry.name);
      if (entry.isDirectory() && depth > 0) walk(file, depth - 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "semantic-edges.jsonl") {
        try {
          if (statSync(file).mtimeMs >= since) found.push(file);
        } catch {
          // Removed while listing.
        }
      }
    }
  };
  walk(join(dir, "sessions"), 0);
  walk(join(dir, "session-artifacts"), 8);
  return found;
}
