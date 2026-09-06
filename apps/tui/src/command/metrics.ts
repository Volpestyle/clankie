/**
 * `clankie metrics` — recent settled captain turns (VUH-1115).
 *
 * The same bounded rows the operator route answers: what ran each turn, what it
 * did, and what the provider reported. Never a transcript, tool arguments, or a
 * credential. `execution` and `usage` come back explicitly null when the turn
 * predates the capture or the provider reported nothing — neither is ever zero.
 */
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { CAPTAIN_TURN_METRICS_LIMIT_MAX, type CaptainTurnSettledMetrics } from "@clankie/protocol";
import { commandHost } from "./io.ts";

const METRICS_USAGE = "Usage: clankie metrics [--run ID] [--limit N]";

export interface MetricsCliCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

export type MetricsCliResult =
  | { readonly ok: true; readonly items: readonly CaptainTurnSettledMetrics[] }
  | { readonly ok: false; readonly error: string };

interface MetricsCliArgs {
  readonly limit?: number;
  readonly runId?: string;
}

export function parseMetricsArgs(args: readonly string[]): MetricsCliArgs {
  let limit: number | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--run" || flag === "--limit") {
      if (value === undefined) throw new Error(METRICS_USAGE);
      index += 1;
      if (flag === "--run") {
        runId = value;
        continue;
      }
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > CAPTAIN_TURN_METRICS_LIMIT_MAX) {
        throw new Error(`--limit must be 1…${CAPTAIN_TURN_METRICS_LIMIT_MAX}. ${METRICS_USAGE}`);
      }
      continue;
    }
    throw new Error(METRICS_USAGE);
  }
  return { ...(limit === undefined ? {} : { limit }), ...(runId === undefined ? {} : { runId }) };
}

export async function runMetricsCommand(
  args: readonly string[],
  options: MetricsCliCommandOptions = {},
): Promise<MetricsCliResult> {
  const parsed = parseMetricsArgs(args);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined) {
    return { ok: false, error: "Turn metrics need the local operator credential. Run `clankie doctor`." };
  }
  const client = new ClankieApiClient({
    baseUrl: commandHost({ ...options, env }),
    operatorToken: credential.token,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  try {
    const page = await client.readCaptainTurnMetrics(parsed);
    return { ok: true, items: page.items };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
