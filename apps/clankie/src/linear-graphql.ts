import {
  LINEAR_API_GRAPHQL_ENDPOINT,
  LINEAR_API_PROVIDER_ID,
  LINEAR_PROVIDER_ID,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import {
  Kind,
  parse,
  type DocumentNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import { z } from "zod";
import { LinearRequestBudgetRefused, type LinearRequestBudget } from "./linear-request-budget.ts";

/** Provider responses are bounded like the API tracker's; a larger page needs a smaller query. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
/** `issueArchive`, `documentDelete`, `userSuspend`… but not `issueUnarchive`. */
const DESTRUCTIVE_FIELD = /(?:delete|(?<!un)archive|suspend|revoke|purge|trash)/iu;

const Arguments = z
  .object({
    query: z.string().min(1).max(100_000),
    variables: z.record(z.string(), z.unknown()).optional(),
    operationName: z.string().min(1).max(256).optional(),
    confirm: z.array(z.string().min(1).max(256)).max(100).optional(),
  })
  .strict();

export const LINEAR_GRAPHQL_TOOL = {
  name: "graphql",
  description: [
    "Run any Linear GraphQL query or mutation against api.linear.app as the workspace Clankie app, for operations the other linear_* tools lack (documents, archive/delete, initiatives, attachments, and the rest of Linear's API).",
    "Safety: queries work wherever Linear reads do; mutations only from operator tools (Clankie's own lane and admitted fleet workers), never from rooms.",
    "Any *Delete, *Archive, *Suspend, *Revoke, *Purge or *Trash mutation must target explicit ids, and confirm must list exactly those target ids; otherwise it is refused before dispatch. Only confirm targets the owner asked to remove.",
    "A mutation is sent once and never retried. If a result is uncertain, reconcile by receipt or read the entity; never resend the mutation.",
    "Prefer the dedicated linear_* tools for ordinary issue, comment and project work. Requires the connected Linear API app (`linear-api`).",
  ].join(" "),
  inputSchema: z.toJSONSchema(
    Arguments.extend({
      query: Arguments.shape.query.describe("One GraphQL document; name the operation when it has several."),
      variables: Arguments.shape.variables.describe("GraphQL variables object."),
      operationName: Arguments.shape.operationName.describe(
        "Operation to run from a multi-operation document.",
      ),
      confirm: Arguments.shape.confirm.describe(
        "Destructive mutations only: every target id the operation deletes or archives, exactly.",
      ),
    }),
  ),
} as const;

export class LinearGraphqlRefusal extends Error {
  readonly reason: "invalid_arguments" | "confirmation_required";
  constructor(message: string, reason: LinearGraphqlRefusal["reason"] = "invalid_arguments") {
    super(message);
    this.reason = reason;
  }
}

export interface LinearGraphqlPlan {
  readonly query: string;
  readonly variables: Record<string, unknown>;
  readonly operationName?: string;
  readonly mutation: boolean;
  /** Destructive root fields and the exact ids they act on; empty for ordinary operations. */
  readonly destructive: readonly { readonly field: string; readonly targets: readonly string[] }[];
}

/** Classifies the one operation that will run. Unparseable or ambiguous input never reaches Linear. */
export function planLinearGraphql(args: Record<string, unknown>): LinearGraphqlPlan {
  const parsed = Arguments.safeParse(args);
  if (!parsed.success)
    throw new LinearGraphqlRefusal(
      `Invalid linear_graphql arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"} ${issue.message}`).join("; ")}`,
    );
  const { query, operationName, confirm } = parsed.data;
  const variables = parsed.data.variables ?? {};
  let document: DocumentNode;
  try {
    document = parse(query);
  } catch (error) {
    throw new LinearGraphqlRefusal(
      `Invalid GraphQL document: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const operations = document.definitions.filter(
    (definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION,
  );
  const fragments = new Map(
    document.definitions
      .filter(
        (definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION,
      )
      .map((fragment) => [fragment.name.value, fragment]),
  );
  const operation =
    operationName === undefined
      ? operations.length === 1
        ? operations[0]
        : undefined
      : operations.find((candidate) => candidate.name?.value === operationName);
  if (!operation)
    throw new LinearGraphqlRefusal(
      operationName === undefined
        ? "The GraphQL document must contain exactly one operation, or name one with operationName"
        : `The GraphQL document has no operation named ${operationName}`,
    );
  if (operation.operation === "subscription")
    throw new LinearGraphqlRefusal("linear_graphql does not run subscriptions");
  const mutation = operation.operation === "mutation";
  const destructive: { field: string; targets: string[] }[] = [];
  if (mutation) {
    const defaults = new Map(
      (operation.variableDefinitions ?? []).map((definition) => [
        definition.variable.name.value,
        definition.defaultValue,
      ]),
    );
    const resolve = (value: ValueNode): unknown => {
      switch (value.kind) {
        case Kind.STRING:
          return value.value;
        case Kind.LIST:
          return value.values.map(resolve);
        case Kind.VARIABLE: {
          const name = value.name.value;
          if (Object.hasOwn(variables, name)) return variables[name];
          const fallback = defaults.get(name);
          return fallback === undefined ? undefined : resolve(fallback);
        }
        default:
          return undefined;
      }
    };
    const visit = (selections: SelectionSetNode, seen: ReadonlySet<string>) => {
      for (const selection of selections.selections) {
        if (selection.kind === Kind.INLINE_FRAGMENT) visit(selection.selectionSet, seen);
        else if (selection.kind === Kind.FRAGMENT_SPREAD) {
          const name = selection.name.value;
          const fragment = fragments.get(name);
          if (!fragment || seen.has(name))
            throw new LinearGraphqlRefusal(`Unresolvable fragment ${name} in mutation`);
          visit(fragment.selectionSet, new Set([...seen, name]));
        } else if (DESTRUCTIVE_FIELD.test(selection.name.value)) {
          const field = selection.name.value;
          const targets: string[] = [];
          for (const argument of selection.arguments ?? []) {
            if (argument.name.value !== "id" && argument.name.value !== "ids") continue;
            const value = resolve(argument.value);
            const values = Array.isArray(value) ? value : [value];
            if (!values.length || values.some((item) => typeof item !== "string" || item.length === 0))
              throw new LinearGraphqlRefusal(`Cannot determine the target ids of destructive ${field}`);
            targets.push(...(values as string[]));
          }
          if (!targets.length)
            throw new LinearGraphqlRefusal(
              `Destructive ${field} has no id or ids argument; linear_graphql only runs destructive mutations whose targets it can name`,
            );
          destructive.push({ field, targets });
        }
      }
    };
    visit(operation.selectionSet, new Set());
  }
  const required = new Set(destructive.flatMap((entry) => entry.targets));
  const confirmed = new Set(confirm ?? []);
  if (required.size > 0) {
    if (confirmed.size !== required.size || [...required].some((target) => !confirmed.has(target)))
      throw new LinearGraphqlRefusal(
        `Destructive Linear mutation (${destructive.map((entry) => entry.field).join(", ")}) needs confirm listing exactly its target ids. Confirm only what the owner asked to remove.`,
        "confirmation_required",
      );
  } else if (confirmed.size > 0) {
    throw new LinearGraphqlRefusal("confirm is only for destructive mutations; remove it");
  }
  return {
    query,
    variables,
    ...(operationName === undefined ? {} : { operationName }),
    mutation,
    destructive,
  };
}

/**
 * The GraphQL audience: the registered `linear-api` app first, then a workspace
 * app (`client_credentials`) stored as `linear`. MCP OAuth tokens are audience-
 * restricted to mcp.linear.app and never qualify.
 */
export async function linearGraphqlCredential(
  credentials: Pick<CredentialStore, "get">,
): Promise<
  { readonly id: string; readonly credential: Extract<ProviderCredential, { type: "oauth" }> } | undefined
> {
  const api = await credentials.get(LINEAR_API_PROVIDER_ID);
  if (api?.type === "oauth" && api.linearAuth === "api" && api.account?.actor === "app")
    return { id: LINEAR_API_PROVIDER_ID, credential: api };
  const app = await credentials.get(LINEAR_PROVIDER_ID);
  if (app?.type === "oauth" && app.linearAuth === "app" && app.account?.actor === "app")
    return { id: LINEAR_PROVIDER_ID, credential: app };
  return undefined;
}

export const LINEAR_GRAPHQL_RECONNECT =
  "linear_graphql needs the connected Linear API app. Connect it from /connect linear (Linear API app), then retry; `clankie doctor` shows whether linear_graphql is usable.";

/**
 * One wire attempt. A mutation is never retried here: a definite provider
 * rejection returns as an error result, and anything uncertain throws so the
 * host records it as possibly dispatched for receipt reconciliation.
 */
export async function executeLinearGraphql(input: {
  readonly plan: LinearGraphqlPlan;
  readonly bearer: string;
  readonly credential: ProviderCredential;
  readonly fetch?: typeof fetch;
  readonly requestBudget?: LinearRequestBudget;
  readonly dispatch: () => void;
  readonly signal: AbortSignal;
}): Promise<{ content: string; isError: boolean }> {
  const { plan } = input;
  const secrets = [
    input.bearer,
    input.credential.type === "oauth" ? input.credential.refresh : undefined,
    input.credential.type === "oauth" ? input.credential.access : undefined,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  const redact = (text: string) =>
    secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text);
  const uncertain = (reason: string) =>
    new Error(
      plan.mutation
        ? `Linear GraphQL mutation outcome unknown (${reason}); read the target or reconcile the receipt before any retry`
        : `Linear GraphQL query failed (${reason})`,
    );
  // Response consumption keeps its own cap after a shorter caller deadline.
  const completion = AbortSignal.timeout(30_000);
  const init: RequestInit = {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${input.bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: plan.query,
      variables: plan.variables,
      ...(plan.operationName === undefined ? {} : { operationName: plan.operationName }),
    }),
    signal: completion,
  };
  const request = input.fetch ?? fetch;
  let sent = false;
  const dispatch = () => {
    input.signal.throwIfAborted();
    input.dispatch();
    sent = true;
  };
  let response: Response;
  try {
    response = input.requestBudget
      ? await input.requestBudget.fetch(
          input.credential,
          request,
          LINEAR_API_GRAPHQL_ENDPOINT,
          init,
          dispatch,
        )
      : await (() => {
          dispatch();
          return request(LINEAR_API_GRAPHQL_ENDPOINT, init);
        })();
  } catch (error) {
    // Refusals before the wire (budget, revoked admission) keep their own type.
    if (error instanceof LinearRequestBudgetRefused || !sent) throw error;
    throw uncertain(error instanceof Error ? error.name : "network failure");
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw uncertain(`HTTP ${response.status} body unreadable`);
  }
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
    throw uncertain(`response exceeds ${MAX_RESPONSE_BYTES} bytes; select fewer fields`);
  let body: { data?: unknown; errors?: unknown } | undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) body = value as typeof body;
  } catch {
    body = undefined;
  }
  const errors = Array.isArray(body?.errors) ? body.errors : undefined;
  const data = body?.data ?? null;
  // Linear rejects invalid documents, bad credentials and rate limits before
  // execution; those are definite, not uncertain, outcomes.
  if (!response.ok) {
    if (
      response.status >= 500 ||
      (errors === undefined && response.status !== 401 && response.status !== 403)
    )
      throw uncertain(`HTTP ${response.status}`);
    return {
      content: redact(
        JSON.stringify({
          status: response.status,
          errors: errors ?? [{ message: `Linear rejected the app credential (HTTP ${response.status})` }],
          ...(response.status === 401 || response.status === 403 ? { hint: LINEAR_GRAPHQL_RECONNECT } : {}),
        }),
      ),
      isError: true,
    };
  }
  if (body === undefined || (data === null && errors === undefined)) throw uncertain("invalid response");
  return {
    content: redact(JSON.stringify(errors === undefined ? { data } : { data, errors })),
    isError: errors !== undefined && errors.length > 0,
  };
}
