/** Read existing turn records or observed issue/worker costs, with explicit coverage. */
import { ClankieApiClient } from "@clankie/api-client";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  CAPTAIN_TURN_METRICS_LIMIT_MAX,
  IssueMetricsQuerySchema,
  type IssueMetricsQuery,
  type IssueMetricsReport,
  type CaptainTurnSettledMetrics,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const METRICS_USAGE =
  "Usage: clankie metrics [--run ID] [--limit N] | --issues [--issue ID] [--worker ID] [--since ISO] [--until ISO]";

export interface MetricsCliCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

export type MetricsCliResult =
  | { readonly ok: true; readonly items: readonly CaptainTurnSettledMetrics[] }
  | { readonly ok: true; readonly report: IssueMetricsReport }
  | { readonly ok: false; readonly error: string };

interface MetricsCliArgs {
  readonly issues?: IssueMetricsQuery;
  readonly limit?: number;
  readonly runId?: string;
}

export function parseMetricsArgs(args: readonly string[]): MetricsCliArgs {
  let issueMode = false;
  const issueQuery: Record<string, string> = {};
  let limit: number | undefined;
  let runId: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--issues") {
      issueMode = true;
      continue;
    }
    if (["--issue", "--worker", "--since", "--until"].includes(flag!)) {
      if (value === undefined) throw new Error(METRICS_USAGE);
      issueQuery[flag!.slice(2)] = value;
      if (flag === "--issue" || flag === "--worker") issueMode = true;
      index += 1;
      continue;
    }
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
  if (issueMode) {
    if (limit !== undefined || runId !== undefined) throw new Error(METRICS_USAGE);
    return { issues: IssueMetricsQuerySchema.parse(issueQuery) };
  }
  if (Object.keys(issueQuery).length > 0) throw new Error(METRICS_USAGE);
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
    if (parsed.issues !== undefined)
      return { ok: true, report: await client.readIssueMetrics(parsed.issues) };
    const page = await client.readCaptainTurnMetrics(parsed);
    return { ok: true, items: page.items };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
