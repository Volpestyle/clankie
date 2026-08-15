/**
 * Linear as a first-class captain connector. The API key is broker-owned
 * (`linear`); the optional default team id is owner-authored settings.
 */
import {
  LINEAR_PROVIDER_ID,
  linearOauthNeedsRefresh,
  refreshLinearOauth,
  type CredentialStore,
  type ProviderCredential,
} from "@clankie/credential-broker";
import type { SettingsStore } from "@clankie/settings";

export { LINEAR_PROVIDER_ID };
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

export type LinearRefusalReason = "credential_unavailable" | "provider_error";

export type LinearRefusal = {
  readonly outcome: "refused";
  readonly reason: LinearRefusalReason;
  readonly detail: string;
};

export type LinearIssue = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly url: string;
  readonly state?: string;
  readonly assignee?: string;
  readonly team?: string;
  readonly description?: string;
};

export type LinearTeam = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
};

export type LinearViewer = {
  readonly name: string;
  readonly organization?: string;
};

export type LinearPort = {
  search(term: string, limit?: number): Promise<{ outcome: "ok"; issues: LinearIssue[] } | LinearRefusal>;
  get(id: string): Promise<{ outcome: "ok"; issue: LinearIssue } | LinearRefusal>;
  create(input: {
    title: string;
    description?: string;
    teamId?: string;
  }): Promise<{ outcome: "ok"; issue: LinearIssue } | LinearRefusal>;
  update(input: {
    id: string;
    title?: string;
    description?: string;
    state?: string;
  }): Promise<{ outcome: "ok"; issue: LinearIssue } | LinearRefusal>;
  comment(input: { id: string; body: string }): Promise<{ outcome: "ok"; commentId: string } | LinearRefusal>;
  teams(): Promise<{ outcome: "ok"; teams: LinearTeam[] } | LinearRefusal>;
  viewer(): Promise<{ outcome: "ok"; viewer: LinearViewer } | LinearRefusal>;
};

export type LinearGraphql = (
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
) => Promise<{ data?: unknown; errors?: readonly { readonly message: string }[] }>;

const ISSUE_FIELDS = `{
  id
  identifier
  title
  description
  url
  state { name }
  assignee { name }
  team { key name }
}`;

export function createLinearPort(options: {
  credentials: CredentialStore;
  settings: SettingsStore;
  graphql?: LinearGraphql;
}): LinearPort {
  const graphql = options.graphql ?? defaultGraphql;

  async function authorized(): Promise<{ apiKey: string } | LinearRefusal> {
    const stored = await options.credentials.get(LINEAR_PROVIDER_ID);
    const bearer = await resolveLinearBearer(stored, options.credentials);
    if (bearer === undefined) {
      return {
        outcome: "refused",
        reason: "credential_unavailable",
        detail: "Linear is not connected — run /connect linear",
      };
    }
    return { apiKey: bearer };
  }

  async function request<T>(
    apiKey: string,
    query: string,
    variables: Record<string, unknown> | undefined,
    pick: (data: unknown) => T | LinearRefusal,
  ): Promise<T | LinearRefusal> {
    let payload: { data?: unknown; errors?: readonly { readonly message: string }[] };
    try {
      payload = await graphql(apiKey, query, variables);
    } catch (error) {
      return {
        outcome: "refused",
        reason: "provider_error",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (payload.errors !== undefined && payload.errors.length > 0) {
      return {
        outcome: "refused",
        reason: "provider_error",
        detail: payload.errors.map((entry) => entry.message).join("; "),
      };
    }
    return pick(payload.data);
  }

  return {
    async search(term, limit = 10) {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      const capped = Math.min(Math.max(limit, 1), 25);
      return request(
        auth.apiKey,
        `query Search($term: String!, $first: Int!) {
          searchIssues(term: $term, first: $first, includeComments: false) {
            nodes ${ISSUE_FIELDS}
          }
        }`,
        { term, first: capped },
        (data) => {
          const nodes = (data as { searchIssues?: { nodes?: unknown } } | undefined)?.searchIssues?.nodes;
          return { outcome: "ok", issues: Array.isArray(nodes) ? compactMap(nodes, parseIssue) : [] };
        },
      );
    },

    async get(id) {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      return request(
        auth.apiKey,
        `query Issue($id: String!) { issue(id: $id) ${ISSUE_FIELDS} }`,
        { id },
        (data) => {
          const parsed = parseIssue((data as { issue?: unknown } | undefined)?.issue);
          return parsed === undefined
            ? { outcome: "refused", reason: "provider_error", detail: `no Linear issue ${id}` }
            : { outcome: "ok", issue: parsed };
        },
      );
    },

    async create(input) {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      const settings = await options.settings.load();
      const teamId = input.teamId?.trim() || settings.linear.defaultTeamId;
      if (teamId === undefined || teamId.length === 0) {
        return {
          outcome: "refused",
          reason: "provider_error",
          detail: "no team id — pass teamId or set a default with /connect linear",
        };
      }
      return request(
        auth.apiKey,
        `mutation Create($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue ${ISSUE_FIELDS} }
        }`,
        {
          input: {
            teamId,
            title: input.title,
            ...(input.description === undefined ? {} : { description: input.description }),
          },
        },
        (data) => {
          const parsed = parseIssue(
            (data as { issueCreate?: { issue?: unknown } } | undefined)?.issueCreate?.issue,
          );
          return parsed === undefined
            ? {
                outcome: "refused",
                reason: "provider_error",
                detail: "Linear did not return the created issue",
              }
            : { outcome: "ok", issue: parsed };
        },
      );
    },

    async update(input) {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      const patch: Record<string, string> = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.state !== undefined) patch.stateId = input.state;
      return request(
        auth.apiKey,
        `mutation Update($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) { success issue ${ISSUE_FIELDS} }
        }`,
        { id: input.id, input: patch },
        (data) => {
          const parsed = parseIssue(
            (data as { issueUpdate?: { issue?: unknown } } | undefined)?.issueUpdate?.issue,
          );
          return parsed === undefined
            ? {
                outcome: "refused",
                reason: "provider_error",
                detail: "Linear did not return the updated issue",
              }
            : { outcome: "ok", issue: parsed };
        },
      );
    },

    async comment(input) {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      return request(
        auth.apiKey,
        `mutation Comment($issueId: String!, $body: String!) {
          commentCreate(input: { issueId: $issueId, body: $body }) { success comment { id } }
        }`,
        { issueId: input.id, body: input.body },
        (data) => {
          const commentId = (data as { commentCreate?: { comment?: { id?: unknown } } } | undefined)
            ?.commentCreate?.comment?.id;
          return typeof commentId === "string"
            ? { outcome: "ok", commentId }
            : { outcome: "refused", reason: "provider_error", detail: "Linear did not return the comment" };
        },
      );
    },

    async teams() {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      return request(auth.apiKey, `query { teams { nodes { id key name } } }`, undefined, (data) => {
        const nodes = (data as { teams?: { nodes?: unknown } } | undefined)?.teams?.nodes;
        return { outcome: "ok", teams: Array.isArray(nodes) ? compactMap(nodes, parseTeam) : [] };
      });
    },

    async viewer() {
      const auth = await authorized();
      if ("outcome" in auth) return auth;
      return request(auth.apiKey, `query { viewer { name } organization { name } }`, undefined, (data) => {
        const name = (data as { viewer?: { name?: unknown } } | undefined)?.viewer?.name;
        if (typeof name !== "string" || name.length === 0) {
          return { outcome: "refused", reason: "provider_error", detail: "Linear did not return a viewer" };
        }
        const organization = (data as { organization?: { name?: unknown } } | undefined)?.organization?.name;
        return {
          outcome: "ok",
          viewer: {
            name,
            ...(typeof organization === "string" ? { organization } : {}),
          },
        };
      });
    },
  };
}

export async function resolveLinearBearer(
  stored: ProviderCredential | undefined,
  credentials: CredentialStore,
  now = Date.now(),
): Promise<string | undefined> {
  if (stored?.type === "api" && stored.key.trim().length > 0) return stored.key;
  if (stored?.type !== "oauth" || stored.access.trim().length === 0) return undefined;
  if (!linearOauthNeedsRefresh(stored, now)) return stored.access;
  try {
    const refreshed = await refreshLinearOauth(stored);
    await credentials.set(LINEAR_PROVIDER_ID, refreshed);
    return refreshed.access;
  } catch {
    return stored.access;
  }
}

export async function defaultGraphql(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<{ data?: unknown; errors?: readonly { readonly message: string }[] }> {
  const response = await fetchImpl(LINEAR_GRAPHQL_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(variables === undefined ? { query } : { query, variables }),
  });
  const payload = (await response.json()) as {
    data?: unknown;
    errors?: readonly { readonly message: string }[];
  };
  if (!response.ok && (payload.errors === undefined || payload.errors.length === 0)) {
    return { errors: [{ message: `Linear HTTP ${String(response.status)}` }] };
  }
  return payload;
}

function compactMap<T>(values: readonly unknown[], parse: (value: unknown) => T | undefined): T[] {
  const result: T[] = [];
  for (const value of values) {
    const parsed = parse(value);
    if (parsed !== undefined) result.push(parsed);
  }
  return result;
}

function parseIssue(value: unknown): LinearIssue | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.identifier !== "string" ||
    typeof record.title !== "string" ||
    typeof record.url !== "string"
  ) {
    return undefined;
  }
  const state = nestedName(record.state);
  const assignee = nestedName(record.assignee);
  const team = nestedName(record.team, "key") ?? nestedName(record.team);
  return {
    id: record.id,
    identifier: record.identifier,
    title: record.title,
    url: record.url,
    ...(state === undefined ? {} : { state }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(team === undefined ? {} : { team }),
    ...(typeof record.description === "string" && record.description.length > 0
      ? { description: record.description.slice(0, 4_000) }
      : {}),
  };
}

function parseTeam(value: unknown): LinearTeam | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.key !== "string" || typeof record.name !== "string") {
    return undefined;
  }
  return { id: record.id, key: record.key, name: record.name };
}

function nestedName(value: unknown, key = "name"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}
