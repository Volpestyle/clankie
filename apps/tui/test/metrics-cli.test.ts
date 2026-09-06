import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import type { CaptainTurnMetricsPage, CaptainTurnSettledMetrics } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { parseMetricsArgs, runMetricsCommand } from "../src/command/metrics.ts";

function row(runId: string, overrides: Partial<CaptainTurnSettledMetrics> = {}): CaptainTurnSettledMetrics {
  return {
    schemaVersion: 1,
    type: "captain.turn.settled",
    conversationId: "conv-1",
    lane: "operator",
    runId,
    acceptedAt: "2026-09-04T12:00:00.000Z",
    completedAt: "2026-09-04T12:00:05.000Z",
    outcome: "completed",
    toolCount: { bash: 3 },
    mutatingCount: 1,
    execution: { model: "gpt-6-astra", provider: "openai-codex", effort: "high" },
    usage: { totalTokens: 4_200, reports: 2 },
    ...overrides,
  };
}

/** Stands in for the service: records the query the CLI asked with. */
function service(items: readonly CaptainTurnSettledMetrics[]): {
  urls: string[];
  authorizations: (string | null)[];
  fetchImpl: typeof fetch;
} {
  const urls: string[] = [];
  const authorizations: (string | null)[] = [];
  const fetchImpl = ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    authorizations.push(new Headers(init?.headers).get("authorization"));
    const page: CaptainTurnMetricsPage = { schemaVersion: 1, items: [...items] };
    return Promise.resolve(Response.json(page));
  }) as typeof fetch;
  return { urls, authorizations, fetchImpl };
}

const env = { CLANKIE_OPERATOR_TOKEN: "operator-test-token" };

describe("clankie metrics arguments", () => {
  it("accepts the flags it documents and refuses the rest", () => {
    expect(parseMetricsArgs([])).toEqual({});
    expect(parseMetricsArgs(["--run", "run-7"])).toEqual({ runId: "run-7" });
    expect(parseMetricsArgs(["--limit", "5", "--run", "run-7"])).toEqual({ limit: 5, runId: "run-7" });
    expect(() => parseMetricsArgs(["--limit"])).toThrow("Usage:");
    expect(() => parseMetricsArgs(["--limit", "0"])).toThrow("--limit");
    expect(() => parseMetricsArgs(["--limit", "101"])).toThrow("--limit");
    expect(() => parseMetricsArgs(["--limit", "many"])).toThrow("--limit");
    expect(() => parseMetricsArgs(["status"])).toThrow("Usage:");
  });
});

describe("clankie metrics", () => {
  it("prints recent turns with what ran them and what they reported", async () => {
    const { urls, authorizations, fetchImpl } = service([row("run-2"), row("run-1")]);
    const result = await runMetricsCommand([], { env, fetchImpl, host: "http://127.0.0.1:4319" });
    expect(result).toMatchObject({ ok: true });
    expect("items" in result && result.items.map((item) => item.runId)).toEqual(["run-2", "run-1"]);
    expect("items" in result && result.items[0]?.execution).toEqual({
      model: "gpt-6-astra",
      provider: "openai-codex",
      effort: "high",
    });
    expect(urls).toEqual(["/v1/captain/turn-metrics"]);
    expect(authorizations).toEqual(["Bearer operator-test-token"]);
  });

  it("narrows to one run and bounds the page", async () => {
    const { urls, fetchImpl } = service([row("run-7")]);
    await runMetricsCommand(["--run", "run-7", "--limit", "3"], { env, fetchImpl });
    expect(urls).toEqual(["/v1/captain/turn-metrics?limit=3&runId=run-7"]);
  });

  it("keeps a legacy row's unknowns explicit", async () => {
    const { fetchImpl } = service([row("run-legacy", { execution: null, usage: null })]);
    const result = await runMetricsCommand([], { env, fetchImpl });
    expect("items" in result && result.items[0]?.execution).toBeNull();
    expect("items" in result && result.items[0]?.usage).toBeNull();
  });

  it("refuses without the operator credential rather than reading anonymously", async () => {
    const { urls, fetchImpl } = service([]);
    // An empty store and no environment override: the real machine credential
    // must not leak into the assertion.
    const empty = new FileCredentialStore(
      join(await mkdtemp(join(tmpdir(), "clankie-metrics-cli-")), "credentials.json"),
    );
    const result = await runMetricsCommand([], { env: {}, fetchImpl, operatorCredentialStore: empty });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("operator credential");
    expect(urls).toEqual([]);
  });
});
