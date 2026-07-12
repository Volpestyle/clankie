import { z } from "zod";
import {
  LinearGraphqlRequestSchema,
  LinearOAuthCredentialRefSchema,
  type LinearOAuthCredentialBroker,
  type LinearOAuthCredentialRef,
} from "./linear-agent-auth.ts";

const LinearUserSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const LinearAgentActivityContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("thought"), body: z.string() }),
  z.object({ type: z.literal("response"), body: z.string() }),
  z.object({ type: z.literal("elicitation"), body: z.string() }),
  z.object({ type: z.literal("prompt"), body: z.string() }),
  z.object({
    type: z.literal("action"),
    action: z.string(),
    parameter: z.string(),
    result: z.string().nullable().optional(),
  }),
  z.object({ type: z.literal("error"), body: z.string() }),
]);

export const LinearAgentActivitySchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ephemeral: z.boolean(),
  user: LinearUserSchema,
  content: LinearAgentActivityContentSchema,
});
export type LinearAgentActivity = z.infer<typeof LinearAgentActivitySchema>;

export const LinearAgentSessionSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["pending", "active", "awaitingInput", "complete", "error", "stale"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().optional(),
  endedAt: z.string().datetime().nullable().optional(),
  summary: z.string().nullable().optional(),
  url: z.string().url().nullable().optional(),
  appUser: LinearUserSchema,
  creator: LinearUserSchema.nullable().optional(),
  issue: z
    .object({
      id: z.string().min(1),
      identifier: z.string().min(1),
      title: z.string().min(1),
      url: z.string().url(),
    })
    .nullable()
    .optional(),
  comment: z
    .object({ id: z.string().min(1), body: z.string(), issueId: z.string().min(1).nullable().optional() })
    .nullable()
    .optional(),
  activities: z.object({
    nodes: z.array(LinearAgentActivitySchema),
    pageInfo: z.object({
      endCursor: z.string().nullable().optional(),
      hasNextPage: z.boolean(),
    }),
  }),
});
export type LinearAgentSession = z.infer<typeof LinearAgentSessionSchema>;

export const LinearAgentSessionListInputSchema = z.object({
  first: z.number().int().min(1).max(250).default(50),
  after: z.string().min(1).optional(),
  includeArchived: z.boolean().default(false),
});
export type LinearAgentSessionListInput = z.input<typeof LinearAgentSessionListInputSchema>;

export const LinearAgentSessionPageSchema = z.object({
  nodes: z.array(LinearAgentSessionSchema),
  pageInfo: z.object({
    endCursor: z.string().nullable().optional(),
    hasNextPage: z.boolean(),
  }),
});
export type LinearAgentSessionPage = z.infer<typeof LinearAgentSessionPageSchema>;

export const LinearAgentActivityCreateInputSchema = z
  .object({
    agentSessionId: z.string().min(1),
    activityId: z.string().uuid().optional(),
    ephemeral: z.boolean().optional(),
    content: z.discriminatedUnion("type", [
      z.object({ type: z.literal("thought"), body: z.string().min(1) }),
      z.object({ type: z.literal("response"), body: z.string().min(1) }),
      z.object({ type: z.literal("elicitation"), body: z.string().min(1) }),
    ]),
  })
  .superRefine((input, context) => {
    if (input.ephemeral === true && input.content.type !== "thought") {
      context.addIssue({
        code: "custom",
        message: "Only thought activities can be ephemeral",
        path: ["ephemeral"],
      });
    }
  });
export type LinearAgentActivityCreateInput = z.infer<typeof LinearAgentActivityCreateInputSchema>;

export const LinearReactionCreateInputSchema = z.union([
  z.object({
    emoji: z.string().min(1),
    reactionId: z.string().uuid().optional(),
    issueId: z.string().min(1),
    commentId: z.never().optional(),
  }),
  z.object({
    emoji: z.string().min(1),
    reactionId: z.string().uuid().optional(),
    commentId: z.string().min(1),
    issueId: z.never().optional(),
  }),
]);
export type LinearReactionCreateInput = z.infer<typeof LinearReactionCreateInputSchema>;

export const LinearReactionSchema = z.object({
  id: z.string().min(1),
  emoji: z.string().min(1),
});
export type LinearReaction = z.infer<typeof LinearReactionSchema>;

export interface LinearAgentClient {
  readonly identity: { workspaceId: string; appUserId: string };
  getAgentSession(agentSessionId: string, activityAfter?: string): Promise<LinearAgentSession>;
  listAgentSessions(input?: LinearAgentSessionListInput): Promise<LinearAgentSessionPage>;
  createAgentActivity(input: LinearAgentActivityCreateInput): Promise<LinearAgentActivity>;
  reactionCreate(input: LinearReactionCreateInput): Promise<LinearReaction>;
}

const LinearAgentClientConfigSchema = z.object({
  credential: LinearOAuthCredentialRefSchema,
  appUserId: z.string().min(1),
});
export type LinearAgentClientConfig = z.infer<typeof LinearAgentClientConfigSchema>;

const AgentSessionResultSchema = z.object({ agentSession: LinearAgentSessionSchema });
const AgentSessionsResultSchema = z.object({ agentSessions: LinearAgentSessionPageSchema });
const AgentActivityResultSchema = z.object({
  agentActivityCreate: z.object({ success: z.literal(true), agentActivity: LinearAgentActivitySchema }),
});
const ReactionResultSchema = z.object({
  reactionCreate: z.object({ success: z.literal(true), reaction: LinearReactionSchema }),
});

/** Credential-free typed client for Linear's app-agent GraphQL surface. */
export class CredentialBrokerLinearAgentClient implements LinearAgentClient {
  private readonly broker: LinearOAuthCredentialBroker;
  private readonly credential: LinearOAuthCredentialRef;
  public readonly identity: { workspaceId: string; appUserId: string };

  public constructor(broker: LinearOAuthCredentialBroker, rawConfig: LinearAgentClientConfig) {
    const config = LinearAgentClientConfigSchema.parse(rawConfig);
    this.broker = broker;
    this.credential = structuredClone(config.credential);
    this.identity = { workspaceId: config.credential.workspaceId, appUserId: config.appUserId };
  }

  public async getAgentSession(agentSessionId: string, activityAfter?: string): Promise<LinearAgentSession> {
    const id = z.string().min(1).parse(agentSessionId);
    const after = activityAfter === undefined ? undefined : z.string().min(1).parse(activityAfter);
    const result = AgentSessionResultSchema.parse(
      await this.execute({
        operationName: "AgentSession",
        document: AGENT_SESSION_QUERY,
        variables: { id, ...(after === undefined ? {} : { activityAfter: after }) },
      }),
    );
    this.assertAppIdentity(result.agentSession);
    return result.agentSession;
  }

  public async listAgentSessions(
    rawInput: LinearAgentSessionListInput = {},
  ): Promise<LinearAgentSessionPage> {
    const input = LinearAgentSessionListInputSchema.parse(rawInput);
    const result = AgentSessionsResultSchema.parse(
      await this.execute({
        operationName: "AgentSessions",
        document: AGENT_SESSIONS_QUERY,
        variables: input.after === undefined ? input : { ...input, after: input.after },
      }),
    );
    for (const session of result.agentSessions.nodes) this.assertAppIdentity(session);
    return result.agentSessions;
  }

  public async createAgentActivity(rawInput: LinearAgentActivityCreateInput): Promise<LinearAgentActivity> {
    const input = LinearAgentActivityCreateInputSchema.parse(rawInput);
    const result = AgentActivityResultSchema.parse(
      await this.execute({
        operationName: "AgentActivityCreate",
        document: AGENT_ACTIVITY_CREATE_MUTATION,
        variables: {
          input: {
            agentSessionId: input.agentSessionId,
            content: input.content,
            ...(input.activityId === undefined ? {} : { id: input.activityId }),
            ...(input.ephemeral === undefined ? {} : { ephemeral: input.ephemeral }),
          },
        },
      }),
    );
    const activity = result.agentActivityCreate.agentActivity;
    this.assertAppUserIdentity(activity.user.id, "activity");
    return activity;
  }

  public async reactionCreate(rawInput: LinearReactionCreateInput): Promise<LinearReaction> {
    const input = LinearReactionCreateInputSchema.parse(rawInput);
    const { reactionId, ...reaction } = input;
    const result = ReactionResultSchema.parse(
      await this.execute({
        operationName: "ReactionCreate",
        document: REACTION_CREATE_MUTATION,
        variables: { input: { ...reaction, ...(reactionId === undefined ? {} : { id: reactionId }) } },
      }),
    );
    return result.reactionCreate.reaction;
  }

  private execute(request: z.input<typeof LinearGraphqlRequestSchema>): Promise<unknown> {
    return this.broker.executeGraphql({
      credential: this.credential,
      request: LinearGraphqlRequestSchema.parse(request),
    });
  }

  private assertAppIdentity(session: LinearAgentSession): void {
    this.assertAppUserIdentity(session.appUser.id, "session");
  }

  private assertAppUserIdentity(appUserId: string, resource: "activity" | "session"): void {
    if (appUserId !== this.identity.appUserId) {
      throw new Error(`Linear agent ${resource} belongs to a different app identity`);
    }
  }
}

const AGENT_SESSION_IDENTITY_FIELDS = `
  id
  status
  createdAt
  updatedAt
  startedAt
  endedAt
  summary
  url
  appUser { id name }
  creator { id name }
  issue { id identifier title url }
  comment { id body issueId }
`;

const AGENT_ACTIVITY_FIELDS = `
  id
  createdAt
  updatedAt
  ephemeral
  user { id name }
  content {
    ... on AgentActivityThoughtContent { type body }
    ... on AgentActivityResponseContent { type body }
    ... on AgentActivityElicitationContent { type body }
    ... on AgentActivityPromptContent { type body }
    ... on AgentActivityActionContent { type action parameter result }
    ... on AgentActivityErrorContent { type body }
  }
`;

const AGENT_SESSION_FIELDS = `
  ${AGENT_SESSION_IDENTITY_FIELDS}
  activities(first: 50) {
    nodes {
      ${AGENT_ACTIVITY_FIELDS}
    }
    pageInfo { endCursor hasNextPage }
  }
`;

export const AGENT_SESSION_QUERY = `
  query AgentSession($id: String!, $activityAfter: String) {
    agentSession(id: $id) {
      ${AGENT_SESSION_IDENTITY_FIELDS}
      activities(first: 50, after: $activityAfter) {
        nodes { ${AGENT_ACTIVITY_FIELDS} }
        pageInfo { endCursor hasNextPage }
      }
    }
  }
`;

export const AGENT_SESSIONS_QUERY = `
  query AgentSessions($first: Int!, $after: String, $includeArchived: Boolean!) {
    agentSessions(first: $first, after: $after, includeArchived: $includeArchived) {
      nodes { ${AGENT_SESSION_FIELDS} }
      pageInfo { endCursor hasNextPage }
    }
  }
`;

export const AGENT_ACTIVITY_CREATE_MUTATION = `
  mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
    agentActivityCreate(input: $input) {
      success
      agentActivity {
        id
        createdAt
        updatedAt
        ephemeral
        user { id name }
        content {
          ... on AgentActivityThoughtContent { type body }
          ... on AgentActivityResponseContent { type body }
          ... on AgentActivityElicitationContent { type body }
        }
      }
    }
  }
`;

export const REACTION_CREATE_MUTATION = `
  mutation ReactionCreate($input: ReactionCreateInput!) {
    reactionCreate(input: $input) {
      success
      reaction { id emoji }
    }
  }
`;
