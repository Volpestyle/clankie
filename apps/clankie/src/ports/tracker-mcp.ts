import type { CredentialStore, ProviderCredential } from "@clankie/credential-broker";

/**
 * What the MCP host needs from a connected tracker's own tools beyond the ones its
 * server lists: a GraphQL escape hatch, worker publishing as a persona, compact
 * write results and its request budget (ADR 0328). The tracker's extension fills
 * it; the host is the same for every tracker.
 */

/** Meters a tracker provider's own API requests; its refusals name when to retry. */
export interface ProviderRequestBudget {
  fetch(
    credential: ProviderCredential,
    request: typeof fetch,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    beforeDispatch?: () => void,
  ): Promise<Response>;
}

/** One classified GraphQL operation, before it runs. */
export interface TrackerGraphqlPlan {
  readonly mutation: boolean;
  /** Destructive root fields and the exact ids they act on; empty for ordinary operations. */
  readonly destructive: readonly { readonly field: string; readonly targets: readonly string[] }[];
  /** Every string the document or its variables carry, so a host can see which records it names. */
  readonly references: readonly string[];
}

interface TrackerMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

type ToolResult = { content: string; isError: boolean };

export interface TrackerMcpAdapter<Plan extends TrackerGraphqlPlan = TrackerGraphqlPlan> {
  readonly graphql: {
    readonly tool: TrackerMcpTool;
    /** What to tell him when the connected app the escape hatch needs is missing. */
    readonly reconnect: string;
    /** Classifies the one operation that will run; throws a refusal for unusable input. */
    plan(args: Record<string, unknown>): Plan;
    /** A planning refusal's reason and message, or undefined for any other error. */
    refusal(
      error: unknown,
    ):
      | { readonly reason: "invalid_arguments" | "confirmation_required"; readonly message: string }
      | undefined;
    /** The stored credential the escape hatch runs as, when one qualifies. */
    credential(
      credentials: Pick<CredentialStore, "get">,
    ): Promise<{ readonly id: string; readonly credential: ProviderCredential } | undefined>;
    execute(input: {
      readonly plan: Plan;
      readonly bearer: string;
      readonly credential: ProviderCredential;
      readonly fetch?: typeof fetch;
      readonly requestBudget?: ProviderRequestBudget;
      readonly dispatch: () => void;
      readonly signal: AbortSignal;
    }): Promise<ToolResult>;
  };
  /** Tools the host serves itself, writing as a worker persona through the connected app. */
  readonly workerTools: readonly TrackerMcpTool[];
  isWorkerTool(name: string): boolean;
  publishWorker(input: {
    tool: string;
    args: Record<string, unknown>;
    credential: ProviderCredential | undefined;
    author: (personaId: string) => Promise<{ name: string; avatarUrl: string } | undefined>;
    beforeWrite: () => Promise<void>;
    signal?: AbortSignal;
    beforeDispatch?: () => void;
    fetch?: typeof fetch;
    requestBudget?: ProviderRequestBudget;
  }): Promise<ToolResult>;
  /** A model-facing write result, compacted to what he needs. */
  compactWrite(tool: string, content: string): string;
  /** When an error is the request budget's refusal, when to retry. */
  budgetRefusal(error: unknown): { readonly retryAt: number } | undefined;
}
