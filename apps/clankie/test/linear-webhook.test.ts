import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderAccount } from "@clankie/credential-broker";
import { describe, expect, it } from "vitest";
import {
  LinearWriteReceipts,
  classifyLinearDelivery,
  linearWriteIssue,
  linearActivityUpdateParent,
  type LinearActivityEvent,
} from "../src/linear-webhook.ts";
import type { LinearRecipient } from "../src/captain/conversation-owner.ts";

const SECRET = "linear-webhook-signing-secret";
const NOW = new Date("2026-09-07T01:00:00.000Z");
function commentBody(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: "create",
    type: "Comment",
    webhookTimestamp: NOW.getTime(),
    createdAt: NOW.toISOString(),
    url: "https://linear.app/vuhlp/issue/VUH-1234#comment-abc",
    actor: { id: "user-james", name: "James", email: "volpestyle@gmail.com" },
    data: {
      id: "comment-abc",
      body: "Please inspect this result.",
      issue: { id: "issue-1", identifier: "VUH-1234", title: "Linear comment ingress" },
      ...data,
    },
    ...overrides,
  });
}
function sign(body: string) {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}
describe("canonical Linear issue routing identity", () => {
  const organizationId = "8397840d-889c-49d5-b686-254640d488b3";
  const issueId = "a06a1c92-8a14-4240-8802-a0bb868d639c";
  const otherIssueId = "be9a13a6-2236-4da1-bc7f-a275392e69b8";
  const commentId = "0f5a2d1e-7c3b-4a1d-9e2f-1234567890ab";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "connected-linear",
    userId: "bot",
    workspaceId: organizationId,
    email: "bot@example.test",
    name: "Clankie",
    workspaceName: "Workspace",
    verifiedAt: NOW.toISOString(),
  };
  const write = (tool: string, result: unknown, args: Record<string, unknown> = {}) => ({
    server: "linear",
    tool,
    arguments: args,
    content: JSON.stringify(result),
    isError: false,
    account,
  });

  it.each([
    ["create_issue", { uuid: issueId, id: "VUH-1234" }, {}],
    ["update_issue", { id: issueId.toUpperCase() }, { id: "VUH-1234" }],
    ["save_issue", { id: issueId, uuid: issueId.toUpperCase() }, {}],
    ["create_worker_issue", { uuid: issueId, personaId: "worker" }, {}],
    ["create_comment", { id: commentId, issueId }, { issueId: "VUH-1234" }],
    ["update_comment", { id: commentId, issue: { id: issueId } }, {}],
    ["save_comment", { id: commentId, issue: { uuid: issueId, id: "VUH-1234" } }, {}],
    ["create_worker_comment", { id: commentId, issue: { uuid: issueId }, personaId: "worker" }, {}],
    ["create_comment", { id: commentId, body: "Posted" }, { issueId: issueId.toUpperCase() }],
  ] as const)("extracts the canonical addressed issue for %s", (tool, result, args) => {
    expect(linearWriteIssue(write(tool, result, args))).toEqual({ organizationId, issueId });
  });

  it.each([
    ["save_issue", { id: "VUH-1234" }, { id: issueId }],
    ["save_issue", { title: issueId }, { identifier: "VUH-1234" }],
    ["create_issue", { issue: { id: issueId } }, {}],
    ["create_comment", { id: commentId }, { issueId: "VUH-1234" }],
    ["update_comment", { id: commentId, body: `Issue ${issueId}` }, { id: issueId }],
    ["create_issue", { id: issueId, uuid: otherIssueId }, {}],
    ["create_comment", { issueId, issue: { id: otherIssueId } }, {}],
    ["create_comment", { issueId }, { issueId: otherIssueId }],
    ["create_comment", { id: commentId, success: false }, { issueId }],
    ["create_issue", { id: issueId, ok: false }, {}],
    ["get_issue", { id: issueId }, {}],
    ["create_project", { id: issueId }, {}],
    ["create_issue", [issueId], {}],
    ["create_issue", `Issue ${issueId}`, {}],
  ] as const)("refuses ambiguous or noncanonical routing proof from %s", (tool, result, args) => {
    expect(linearWriteIssue(write(tool, result, args))).toBeUndefined();
  });

  it("requires a successful Linear call and the verified connected workspace", () => {
    const call = write("save_issue", { id: issueId });
    for (const altered of [
      { ...call, server: "another-service" },
      { ...call, isError: true },
      { ...call, account: undefined },
      { ...call, account: { ...account, provider: "github" } as unknown as ProviderAccount },
      { ...call, account: { ...account, workspaceId: "display-workspace" } },
      { ...call, content: "malformed" },
    ])
      expect(linearWriteIssue(altered)).toBeUndefined();
    expect(linearWriteIssue({ ...call, account: { ...account, workspaceId: otherIssueId } })).toEqual({
      organizationId: otherIssueId,
      issueId,
    });
  });

  it.each([
    ["Issue", { id: issueId.toUpperCase(), identifier: "VUH-1234" }, issueId],
    ["Comment", { id: commentId, issueId }, issueId],
    ["Comment", { id: commentId, issue: { id: issueId } }, issueId],
    ["Comment", { id: commentId, issueId, issue: { id: otherIssueId } }, undefined],
    ["Comment", { id: commentId, issue: { id: "VUH-1234" } }, undefined],
    ["ProjectUpdate", { id: issueId }, undefined],
  ] as const)("stamps canonical identity only from verified %s resource data", (type, data, expected) => {
    const body = commentBody({ type, data, organizationId });
    const result = classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: sign(body), delivery: "signed", event: type },
      secret: SECRET,
      now: NOW,
    });
    expect(result.kind).toBe("activity");
    if (result.kind !== "activity") throw new Error("verified event unavailable");
    expect(result.activity.issueId).toBe(expected);
  });
});

describe("host ownership of exact signed Linear writes", () => {
  const organizationId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const commentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "connection",
    userId: "bot",
    workspaceId: organizationId,
    name: "Clankie",
    email: "bot@example.test",
    workspaceName: "Personal",
    verifiedAt: NOW.toISOString(),
  };
  const owner = {
    conversationId: "room-owned",
    discord: {
      baseSessionKey: "discord:channel",
      targetId: "channel",
      actorId: "authorized-owner",
      guildId: "guild",
      channelId: "channel",
      messageId: "origin",
      transportKind: "bot" as const,
    },
  };
  const revision = { id: commentId, updatedAt: NOW.toISOString(), body: "Completed the requested fix" };
  const call = {
    server: "linear",
    tool: "save_comment",
    arguments: { issueId: "VUH-1611" },
    content: JSON.stringify(revision),
    isError: false,
    account,
    owner,
  };
  function delivery(
    writes: LinearWriteReceipts | undefined,
    overrides: Record<string, unknown> = {},
    signature?: string,
  ) {
    const body = commentBody(
      { actor: { id: "bot" }, organizationId, ...overrides },
      { ...revision, issueId, issue: { id: issueId, identifier: "VUH-1611" } },
    );
    const seen: LinearActivityEvent[] = [];
    const result = classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: signature ?? sign(body), delivery: "signed-owner", event: "Comment" },
      secret: SECRET,
      now: NOW,
      ...(writes ? { writes } : {}),
      recordActivity: (event) => void seen.push(event),
    });
    return { result, seen };
  }

  it("resolves an identifier-only comment write to its signed parent with durable host ownership before suppression", async () => {
    expect(linearWriteIssue(call)).toBeUndefined();
    const root = await mkdtemp("/tmp/clankie-linear-write-owner-");
    const path = join(root, "writes.json");
    try {
      new LinearWriteReceipts(path).record(call, NOW);
      const stored = await readFile(path, "utf8");
      expect(stored).toContain("room-owned");
      expect(stored).not.toContain(revision.body);
      expect(stored).not.toContain("VUH-1611");
      const resumed = new LinearWriteReceipts(path);
      const { result, seen } = delivery(resumed);
      expect(result).toMatchObject({ kind: "ignored", reason: "self_echo" });
      expect(seen).toMatchObject([
        { organizationId, issueId, conversationOwner: owner, conversationOwnerRecordedAt: NOW.getTime() },
      ]);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts owner stamps only from exact host receipts, never signed provider owner fields", () => {
    const writes = new LinearWriteReceipts();
    writes.record(call, NOW);
    const forged = { conversationOwner: { conversationId: "forged" }, owner: { conversationId: "forged" } };
    expect(delivery(writes, forged).seen[0]?.conversationOwner).toEqual(owner);
    expect(delivery(undefined, forged).seen[0]?.conversationOwner).toBeUndefined();
    expect(
      delivery(writes, { ...forged, actor: { id: "other-actor" } }).seen[0]?.conversationOwner,
    ).toBeUndefined();
    expect(
      delivery(writes, { ...forged, organizationId: "other-workspace" }).seen[0]?.conversationOwner,
    ).toBeUndefined();
    const bad = delivery(writes, forged, "bad");
    expect(bad.result).toEqual({ kind: "rejected", reason: "bad_signature" });
    expect(bad.seen).toEqual([]);
  });

  it("stamps the original receipt time on delayed echoes without changing suppression", () => {
    const recordedAt = new Date(NOW.getTime() - 30_000);
    const writes = new LinearWriteReceipts();
    writes.record(call, recordedAt);
    const { result, seen } = delivery(writes, { conversationOwnerRecordedAt: NOW.getTime() });
    expect(result).toMatchObject({ kind: "ignored", reason: "self_echo" });
    expect(seen[0]?.conversationOwner).toEqual(owner);
    expect(seen[0]?.conversationOwnerRecordedAt).toBe(recordedAt.getTime());
  });

  it("does not recover identifier-only ownership when the saved revision lacks proof", () => {
    for (const change of [
      { content: JSON.stringify({ id: commentId, body: revision.body, createdAt: NOW.toISOString() }) },
      { content: JSON.stringify({ id: commentId, updatedAt: NOW.toISOString() }) },
      { content: `Saved comment ${commentId}` },
      { isError: true },
      { account: undefined },
    ]) {
      const writes = new LinearWriteReceipts();
      writes.record({ ...call, ...change }, NOW);
      const { result, seen } = delivery(writes);
      expect(result.kind).toBe("activity");
      expect(seen[0]?.issueId).toBe(issueId);
      expect(seen[0]?.conversationOwner).toBeUndefined();
      expect(seen[0]?.conversationOwnerRecordedAt).toBeUndefined();
    }
  });

  it.each([
    [undefined, undefined],
    [undefined, { conversationId: "another-owner" }],
    [{ grantId: "grant", principalId: "worker", workId: "work" }, { conversationId: "another-owner" }],
  ] as const)(
    "drops ambiguous owners while preserving existing receipt provenance %#",
    (worker, otherOwner) => {
      const writes = new LinearWriteReceipts();
      writes.record({ ...call, ...(worker ? { worker } : {}) }, NOW);
      writes.record({ ...call, owner: otherOwner, ...(worker ? { worker } : {}) }, NOW);
      const { result, seen } = delivery(writes);
      expect(seen[0]?.conversationOwner).toBeUndefined();
      expect(seen[0]?.conversationOwnerRecordedAt).toBeUndefined();
      if (worker) {
        expect(result).toMatchObject({ kind: "ignored", reason: "self_echo" });
        expect(seen[0]?.worker).toEqual(worker);
      } else expect(result).toMatchObject({ kind: "ignored", reason: "self_echo" });
    },
  );
});

describe("exact status update reply recipients", () => {
  const updateId = "d9b90f52-0b0e-463d-a1e9-9457d250592c";
  const commentId = "0707b479-8a50-4496-b6ba-bec2efbd0a1f";
  const organizationId = "75f1d1f0-542b-4095-9967-fd7b27093472";
  const account: ProviderAccount = {
    provider: "linear",
    connectionId: "native-linear",
    userId: "clankie",
    workspaceId: organizationId,
    name: "Clankie",
    email: "bot@example.test",
    workspaceName: "Vuhlp",
    verifiedAt: NOW.toISOString(),
  };
  const native: LinearRecipient = {
    kind: "native",
    paneId: "pc/w3:pK",
    seatId: "kh2-native-claude",
    occupantId: "claude:kh2-session",
    binding: "a".repeat(64),
  };
  function write(type = "project", recipient: LinearRecipient | undefined = native) {
    return {
      server: "linear",
      tool: "save_status_update",
      arguments: { type },
      content: JSON.stringify({
        id: updateId,
        type,
        updatedAt: NOW.toISOString(),
        body: "Status",
        user: { id: "clankie" },
      }),
      isError: false,
      account,
      recipient,
    };
  }
  function classify(
    writes: LinearWriteReceipts,
    type = "project",
    data: Record<string, unknown> = {},
    overrides: Record<string, unknown> = {},
  ) {
    const parentFields =
      type === "initiative"
        ? { initiativeUpdateId: updateId, initiativeUpdate: { id: updateId, userId: "clankie" } }
        : { projectUpdateId: updateId, projectUpdate: { id: updateId, userId: "clankie" } };
    const body = commentBody(
      { organizationId, actor: { id: "james", type: "user" }, ...overrides },
      {
        id: commentId,
        body: "I APPROVE all!!",
        ...parentFields,
        ...data,
      },
    );
    return classifyLinearDelivery({
      rawBody: Buffer.from(body),
      headers: { signature: sign(body), delivery: "reply", event: "Comment" },
      secret: SECRET,
      now: NOW,
      writes,
    });
  }

  it.each(["project", "initiative"])(
    "retains an exact %s update's remote native author across receipt restart",
    async (type) => {
      const root = await mkdtemp("/tmp/clankie-status-recipient-");
      const path = join(root, "writes.json");
      try {
        new LinearWriteReceipts(path).record(write(type), NOW);
        const resumed = new LinearWriteReceipts(path);
        const outcome = classify(resumed, type);
        expect(outcome).toMatchObject({
          kind: "activity",
          activity: {
            replyRecipient: {
              parentType: type === "project" ? "ProjectUpdate" : "InitiativeUpdate",
              parentId: updateId,
              recipient: native,
              recordedAt: NOW.getTime(),
            },
            replyTo: { type: type === "project" ? "ProjectUpdate" : "InitiativeUpdate", id: updateId },
          },
        });
        expect(await readFile(path, "utf8")).not.toContain("Status");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses existing conversation ownership when a retained legacy write has no native author", () => {
    const writes = new LinearWriteReceipts();
    writes.record({ ...write(), recipient: undefined, owner: { conversationId: "work-owner" } }, NOW);
    expect(classify(writes)).toMatchObject({
      kind: "activity",
      activity: {
        replyRecipient: { recipient: { kind: "conversation", owner: { conversationId: "work-owner" } } },
      },
    });
  });

  it("stamps native ownership for an identifier-only comment from its exact signed revision before suppression", () => {
    const writes = new LinearWriteReceipts();
    const call = {
      server: "linear",
      tool: "save_comment",
      arguments: { issueId: "VUH-1611" },
      content: JSON.stringify({ id: commentId, body: "Result", updatedAt: NOW.toISOString() }),
      isError: false,
      account,
      recipient: native,
    };
    expect(linearWriteIssue(call)).toBeUndefined();
    writes.record(call, NOW);
    const body = commentBody(
      { organizationId, actor: { id: "clankie" } },
      {
        id: commentId,
        body: "Result",
        updatedAt: NOW.toISOString(),
        issueId: updateId,
        issue: { id: updateId },
      },
    );
    const seen: LinearActivityEvent[] = [];
    const receive = () =>
      classifyLinearDelivery({
        rawBody: Buffer.from(body),
        headers: { signature: sign(body), delivery: "native-write", event: "Comment" },
        secret: SECRET,
        now: NOW,
        writes,
        recordActivity: (event) => void seen.push(event),
      });
    expect(receive()).toMatchObject({ kind: "ignored", reason: "self_echo" });
    expect(seen[0]).toMatchObject({
      issueId: updateId,
      writeRecipient: native,
      writeRecipientRecordedAt: NOW.getTime(),
    });
    expect(seen[0]?.conversationOwner).toBeUndefined();
    writes.record({ ...call, recipient: { ...native, paneId: "pc/another" } }, NOW);
    expect(receive()).toMatchObject({ kind: "ignored", reason: "self_echo" });
    expect(seen[1]?.writeRecipient).toBeUndefined();
    expect(seen[1]?.writeRecipientRecordedAt).toBeUndefined();
  });

  it("ignores signed provider-selected recipients and refuses bad signatures before stamping", () => {
    const forged = {
      replyRecipient: {
        parentType: "ProjectUpdate",
        parentId: updateId,
        recipient: native,
        recordedAt: NOW.getTime(),
      },
      writeRecipient: native,
    };
    const withoutReceipt = classify(new LinearWriteReceipts(), "project", {}, forged);
    if (withoutReceipt.kind === "activity") {
      expect(withoutReceipt.activity.replyRecipient).toBeUndefined();
      expect(withoutReceipt.activity.writeRecipient).toBeUndefined();
    }
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    const body = commentBody({ organizationId, ...forged }, { id: commentId, projectUpdateId: updateId });
    expect(
      classifyLinearDelivery({
        rawBody: Buffer.from(body),
        headers: { signature: "bad", delivery: "forged", event: "Comment" },
        secret: SECRET,
        now: NOW,
        writes,
      }),
    ).toEqual({ kind: "rejected", reason: "bad_signature" });
  });

  it("never resolves parent identity from prefixes, URLs, or conflicting signed IDs", () => {
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    for (const data of [
      { projectUpdateId: "d9b90f52", projectUpdate: {} },
      { projectUpdateId: updateId, projectUpdate: { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } },
      { initiativeUpdateId: updateId, initiativeUpdate: { id: updateId } },
      { projectUpdateId: undefined, projectUpdate: undefined },
      { id: "0707b479" },
    ]) {
      const result = classify(writes, "project", data, {
        url: "https://linear.app/work/project/kh2/activity#project-update-d9b90f52&comment-0707b479",
        replyRecipient: { recipient: native },
      });
      expect(result.kind).toBe("activity");
      if (result.kind === "activity") expect(result.activity.replyRecipient).toBeUndefined();
    }
    expect(
      linearActivityUpdateParent({ type: "Comment", data: { projectUpdateId: updateId.toUpperCase() } }),
    ).toEqual({ parentType: "ProjectUpdate", parentId: updateId });
  });

  it("retains ambiguous recipient attribution without changing own echo suppression", () => {
    const writes = new LinearWriteReceipts();
    writes.record(write(), NOW);
    writes.record(write("project", { ...native, paneId: "pc/w3:other" }), NOW);
    expect(classify(writes)).toMatchObject({ kind: "activity" });
    const outcome = classify(writes);
    if (outcome.kind === "activity") expect(outcome.activity.replyRecipient).toBeUndefined();
    const self = classify(writes, "project", {}, { actor: { id: "clankie" } });
    if (self.kind === "activity") expect(self.activity.replyRecipient).toBeUndefined();
    const ownBody = commentBody(
      { type: "ProjectUpdate", actor: { id: "clankie" }, organizationId },
      { id: updateId, body: "Status", updatedAt: NOW.toISOString() },
    );
    expect(
      classifyLinearDelivery({
        rawBody: Buffer.from(ownBody),
        headers: { signature: sign(ownBody), delivery: "echo", event: "ProjectUpdate" },
        secret: SECRET,
        now: NOW,
        writes,
      }),
    ).toMatchObject({ kind: "ignored", reason: "self_echo" });
  });

  it.each([
    { tool: "get_status_update" },
    { arguments: { type: "initiative" } },
    {
      arguments: {},
      content: JSON.stringify({ id: updateId, updatedAt: NOW.toISOString(), body: "Status" }),
    },
    {
      content: JSON.stringify({
        id: updateId,
        type: "project",
        createdAt: NOW.toISOString(),
        body: "Status",
      }),
    },
    {
      content: JSON.stringify({
        id: "d9b90f52",
        type: "project",
        updatedAt: NOW.toISOString(),
        body: "Status",
      }),
    },
    { isError: true },
    { account: undefined },
  ])("does not retain ownership from unproven status writes %#", (change) => {
    const writes = new LinearWriteReceipts();
    writes.record({ ...write(), ...change }, NOW);
    const outcome = classify(writes);
    expect(outcome.kind).toBe("activity");
    if (outcome.kind === "activity") expect(outcome.activity.replyRecipient).toBeUndefined();
  });
});
