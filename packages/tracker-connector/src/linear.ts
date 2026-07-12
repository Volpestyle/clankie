import { z } from "zod";
import {
  TrackerAppIdentitySchema,
  TrackerIssueSchema,
  TrackerIssueRefSchema,
  type TrackerAppIdentity,
  type TrackerClient,
  type TrackerCommentInput,
  type TrackerIssue,
  type TrackerIssueMutation,
  type TrackerIssueRef,
} from "./types.ts";

export interface LinearIssueRecord {
  id: string;
  identifier: string;
  url: string;
  updatedAt: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  priorityLabel?: string | null;
  state: { id: string; name: string; type: string };
}

/** Trusted control-plane adapter supplies this credential-free actor=app port. */
export interface LinearClient {
  getAppIdentity(): Promise<TrackerAppIdentity>;
  getIssue(issueId: string): Promise<LinearIssueRecord>;
  createComment(input: TrackerCommentInput): Promise<{ commentId: string }>;
  setDelegate(input: { issueId: string; appIdentityId: string; idempotencyKey: string }): Promise<void>;
  updateIssue(input: {
    issueId: string;
    mutation: TrackerIssueMutation;
    idempotencyKey: string;
  }): Promise<void>;
}

const LinearIssueRecordSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().min(1),
  url: z.string().url(),
  updatedAt: z.string().min(1),
  title: z.string().min(1),
  description: z.string().nullable().optional(),
  priority: z.number().int().nonnegative().nullable().optional(),
  priorityLabel: z.string().nullable().optional(),
  state: z.object({ id: z.string().min(1), name: z.string().min(1), type: z.string().min(1) }),
});

export class LinearTrackerClient implements TrackerClient {
  public readonly connector = "linear";
  private readonly client: LinearClient;

  public constructor(client: LinearClient) {
    this.client = client;
  }

  public async getAppIdentity(): Promise<TrackerAppIdentity> {
    return TrackerAppIdentitySchema.parse(await this.client.getAppIdentity());
  }

  public async getIssue(rawRef: TrackerIssueRef): Promise<TrackerIssue> {
    const ref = TrackerIssueRefSchema.parse(rawRef);
    if (ref.connector !== this.connector) throw new Error(`Linear cannot read ${ref.connector} issues`);
    const issue = LinearIssueRecordSchema.parse(await this.client.getIssue(ref.issueId));
    if (issue.id !== ref.issueId) throw new Error("Linear returned a different issue than requested");
    const description = issue.description ?? "";
    return TrackerIssueSchema.parse({
      ref,
      identifier: issue.identifier,
      url: issue.url,
      revision: issue.updatedAt,
      intent: { title: issue.title, description },
      priority: {
        value: issue.priority ?? null,
        label: issue.priorityLabel ?? "No priority",
      },
      acceptanceCriteria: extractAcceptanceCriteria(description),
      state: issue.state,
    });
  }

  public postComment(input: TrackerCommentInput): Promise<{ commentId: string }> {
    this.assertLinear(input.ref);
    return this.client.createComment(input);
  }

  public mirrorAssignment(input: {
    ref: TrackerIssueRef;
    appIdentityId: string;
    idempotencyKey: string;
  }): Promise<void> {
    this.assertLinear(input.ref);
    return this.client.setDelegate({
      issueId: input.ref.issueId,
      appIdentityId: input.appIdentityId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  public mutateIssue(input: {
    ref: TrackerIssueRef;
    mutation: TrackerIssueMutation;
    idempotencyKey: string;
  }): Promise<void> {
    this.assertLinear(input.ref);
    return this.client.updateIssue({
      issueId: input.ref.issueId,
      mutation: input.mutation,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private assertLinear(ref: TrackerIssueRef): void {
    if (ref.connector !== this.connector) throw new Error(`Linear cannot mutate ${ref.connector} issues`);
  }
}

export function extractAcceptanceCriteria(description: string): string[] {
  const heading = /^#{1,6}\s+acceptance criteria\s*$|^\*\*acceptance criteria:\*\*\s*$/imu;
  const match = heading.exec(description);
  if (!match) return [];
  const section = description.slice(match.index + match[0].length);
  const nextHeading = /^(?:#{1,6}\s+.+|\*\*[^\n]+:\*\*)\s*$/mu.exec(section);
  const body = nextHeading ? section.slice(0, nextHeading.index) : section;
  return [...body.matchAll(/^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/gmu)].map((entry) => entry[1] as string);
}
