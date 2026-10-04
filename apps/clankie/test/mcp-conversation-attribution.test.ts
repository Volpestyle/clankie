import { describe, expect, it } from "vitest";
import type { CredentialStore, ProviderAccount, RedactedCredential } from "@clankie/credential-broker";
import type { McpServerSettings, SettingsStore } from "@clankie/settings";
import type { ConversationAuthority, NativeSeatAuthority } from "../src/captain/conversation-owner.ts";
import { linearWriteIssue } from "../src/linear-webhook.ts";
import { createMcpHost, type McpConnection, type McpHostOptions } from "../src/mcp-host.ts";

const issueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const account: ProviderAccount = {
  provider: "linear",
  connectionId: "linear-account",
  userId: "bot",
  workspaceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  name: "Bot",
  email: "bot@example.test",
  workspaceName: "Personal",
  verifiedAt: "2026-10-04T10:00:00.000Z",
};
const server: McpServerSettings = {
  id: "linear",
  transport: "stdio",
  command: "fake-mcp",
  args: [],
  lane: "operator",
  initialTools: [],
  enabled: true,
  credential: "linear",
};
const credentials: CredentialStore = {
  get: async () => ({ type: "api", key: "test-only", account }),
  set: async () => undefined,
  delete: async () => true,
  list: async () => ({}) as Record<string, RedactedCredential>,
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function settings(load = async () => ({ mcp: { servers: [server] } })): SettingsStore {
  return { load } as unknown as SettingsStore;
}

function connection(
  callTool: McpConnection["callTool"] = async () => ({ content: "saved", isError: false }),
): McpConnection {
  return { listTools: async () => [], callTool, close: async () => undefined };
}

function authority(conversationId = "original") {
  return {
    owner: { conversationId },
    current: () => true,
    authorize: async () => true,
  } satisfies ConversationAuthority;
}

function host(options: Partial<McpHostOptions> = {}) {
  return createMcpHost({
    credentials,
    settings: settings(),
    logger: { info: () => undefined, warn: () => undefined },
    curated: [],
    connect: async () => connection(),
    ...options,
  });
}

describe("MCP conversation attribution", () => {
  it("pins a native update author at write entry and prefers that author while retaining its hiring conversation", async () => {
    const connecting = gate();
    const connected = gate();
    const owner = authority("hiring-conversation");
    const native: NativeSeatAuthority = {
      recipient: {
        kind: "native",
        paneId: "kh2/w3:pK",
        seatId: "kh2/term-author",
        occupantId: "native-session",
        binding: "a".repeat(64),
        owner: owner.owner,
      },
      current: () => true,
      authorize: async () => true,
    };
    const observed: unknown[] = [];
    const proof = async () => undefined;
    const service = host({
      connect: async () => {
        connecting.release();
        await connected.promise;
        return connection();
      },
      writeAuthorityForWorker: async (principal, nativeProof) => {
        expect(principal).toBe("fleet:kh2:pane:w3:pK");
        expect(nativeProof).toBe(proof);
        return { conversationAuthority: owner, nativeRecipientAuthority: native };
      },
      observeCall: (call) => void observed.push({ owner: call.owner, recipient: call.recipient }),
    });
    try {
      const identity = await service.account("linear", "operator");
      const pending = service.call({
        lane: "operator",
        server: "linear",
        tool: "save_project_update",
        arguments: {},
        nativeWriteProof: proof,
        delegation: {
          binding: identity.binding,
          principalId: "fleet:kh2:pane:w3:pK",
          grantId: "grant",
          workId: "work",
        },
      });
      await connecting.promise;
      owner.owner.conversationId = "adopted-later";
      native.recipient.paneId = "kh2/w3:pOther";
      connected.release();
      expect(await pending).toMatchObject({ outcome: "ok" });
      expect(observed).toMatchObject([
        {
          owner: { conversationId: "hiring-conversation" },
          recipient: {
            kind: "native",
            paneId: "kh2/w3:pK",
            owner: { conversationId: "hiring-conversation" },
          },
        },
      ]);
    } finally {
      await service.close();
    }
  });

  it("does not attribute an unproved native write or synthesize a global recipient, without revoking connected tools", async () => {
    const observed: unknown[] = [];
    let writes = 0;
    const service = host({
      writeAuthorityForWorker: async () => undefined,
      conversationForWorker: async () => authority("global-default"),
      connect: async () =>
        connection(async () => {
          writes++;
          return { content: "saved", isError: false };
        }),
      observeCall: (call) => void observed.push({ owner: call.owner, recipient: call.recipient }),
    });
    try {
      const identity = await service.account("linear", "operator");
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_project_update",
          arguments: {},
          delegation: {
            binding: identity.binding,
            principalId: "fleet:kh2:pane:unverified",
            grantId: "grant",
            workId: "work",
          },
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(writes).toBe(1);
      expect(observed).toEqual([{ owner: undefined, recipient: undefined }]);
    } finally {
      await service.close();
    }
  });

  it("drops a replaced native author's proof after connection awaits while keeping the independent provider call", async () => {
    let current = true;
    const observed: unknown[] = [];
    const service = host({
      writeAuthorityForWorker: async () => ({
        nativeRecipientAuthority: {
          recipient: {
            kind: "native",
            paneId: "kh2/w3:pK",
            seatId: "kh2/term-author",
            occupantId: "original-session",
            binding: "a".repeat(64),
          },
          current: () => current,
          authorize: async () => current,
        },
      }),
      connect: async () => {
        current = false;
        return connection();
      },
      observeCall: (call) => void observed.push(call.recipient),
    });
    try {
      const identity = await service.account("linear", "operator");
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_project_update",
          arguments: {},
          delegation: {
            binding: identity.binding,
            principalId: "fleet:kh2:pane:w3:pK",
            grantId: "grant",
            workId: "work",
          },
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(observed).toEqual([undefined]);
    } finally {
      await service.close();
    }
  });

  it("keeps the connected write available when fresh native attribution observation throws", async () => {
    const observed: unknown[] = [];
    const service = host({
      writeAuthorityForWorker: async () => ({
        nativeRecipientAuthority: {
          recipient: {
            kind: "native",
            paneId: "kh2/w3:pK",
            seatId: "kh2/term-author",
            occupantId: "original",
            binding: "a".repeat(64),
          },
          current: () => true,
          authorize: async () => {
            throw new Error("native process observer unavailable");
          },
        },
      }),
      observeCall: (call) => void observed.push(call.recipient),
    });
    try {
      const identity = await service.account("linear", "operator");
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_project_update",
          arguments: {},
          delegation: {
            binding: identity.binding,
            principalId: "fleet:kh2:pane:w3:pK",
            grantId: "grant",
            workId: "work",
          },
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(observed).toEqual([undefined]);
    } finally {
      await service.close();
    }
  });

  it("captures the admitting turn before the first settings await", async () => {
    const paused = gate();
    let initialLoad = true;
    const source = authority();
    const observed: unknown[] = [];
    const service = host({
      settings: settings(async () => {
        if (initialLoad) {
          initialLoad = false;
          await paused.promise;
        }
        return { mcp: { servers: [server] } };
      }),
      observeCall: (call) => void observed.push(call.owner),
    });
    try {
      const pending = service.call({
        lane: "operator",
        server: "linear",
        tool: "save_comment",
        arguments: { issueId },
        conversationAuthority: source,
      });
      source.owner.conversationId = "next-turn";
      paused.release();
      expect(await pending).toMatchObject({ outcome: "ok" });
      expect(observed).toEqual([{ conversationId: "original" }]);
    } finally {
      await service.close();
    }
  });

  it("retains the admitting owner when its authorization check yields", async () => {
    const source = authority();
    const observed: unknown[] = [];
    source.authorize = async () => {
      source.owner.conversationId = "next-turn";
      return true;
    };
    const service = host({ observeCall: (call) => void observed.push(call.owner) });
    try {
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_comment",
          arguments: { issueId },
          conversationAuthority: source,
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(observed).toEqual([{ conversationId: "original" }]);
    } finally {
      await service.close();
    }
  });

  it("captures a native worker's original lead before connection work and later adoption", async () => {
    const connecting = gate();
    const connected = gate();
    let lead = "hiring-conversation";
    const observed: unknown[] = [];
    const service = host({
      connect: async () => {
        connecting.release();
        await connected.promise;
        return connection();
      },
      conversationForWorker: async () => authority(lead),
      observeCall: (call) => void observed.push(call.owner),
    });
    try {
      const identity = await service.account("linear", "operator");
      const pending = service.call({
        lane: "operator",
        server: "linear",
        tool: "save_comment",
        arguments: { issueId },
        delegation: {
          binding: identity.binding,
          principalId: "fleet:default:pane:w1:p1",
          grantId: "grant",
          workId: "work",
        },
      });
      await connecting.promise;
      lead = "adopting-conversation";
      connected.release();
      expect(await pending).toMatchObject({ outcome: "ok" });
      expect(observed).toEqual([{ conversationId: "hiring-conversation" }]);
    } finally {
      await service.close();
    }
  });

  it("rechecks the delegated fence after attribution waits", async () => {
    let admitted = true;
    let writes = 0;
    const source = authority();
    source.authorize = async () => {
      admitted = false;
      return true;
    };
    const service = host({
      connect: async () =>
        connection(async () => {
          writes++;
          return { content: "saved", isError: false };
        }),
    });
    try {
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_comment",
          arguments: { issueId },
          conversationAuthority: source,
          fence: async () => {
            if (!admitted) throw new Error("grant revoked");
          },
        }),
      ).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
      expect(writes).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("rechecks provider configuration after attribution waits", async () => {
    let enabled = true;
    let writes = 0;
    const source = authority();
    source.authorize = async () => {
      enabled = false;
      return true;
    };
    const service = host({
      settings: settings(async () => ({ mcp: { servers: [{ ...server, enabled }] } })),
      connect: async () =>
        connection(async () => {
          writes++;
          return { content: "saved", isError: false };
        }),
    });
    try {
      expect(
        await service.call({
          lane: "operator",
          server: "linear",
          tool: "save_comment",
          arguments: { issueId },
          conversationAuthority: source,
        }),
      ).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
      expect(writes).toBe(0);
    } finally {
      await service.close();
    }
  });

  it("observes the arguments sent to the provider despite caller mutation during settlement", async () => {
    const writing = gate();
    const settled = gate();
    const args = { issueId, body: { content: "original" } };
    let received: Record<string, unknown> | undefined;
    let written: ReturnType<typeof linearWriteIssue>;
    const service = host({
      connect: async () =>
        connection(async (_tool, input) => {
          received = input;
          writing.release();
          await settled.promise;
          return { content: JSON.stringify({ id: otherIssueId }), isError: false };
        }),
      observeCall: (call) => {
        written = linearWriteIssue(call);
      },
    });
    try {
      const pending = service.call({
        lane: "operator",
        server: "linear",
        tool: "save_comment",
        arguments: args,
        conversationAuthority: authority(),
      });
      await writing.promise;
      args.issueId = otherIssueId;
      args.body.content = "changed";
      settled.release();
      expect(await pending).toMatchObject({ outcome: "ok" });
      expect(received).toEqual({ issueId, body: { content: "original" } });
      expect(written).toEqual({ organizationId: account.workspaceId, issueId });
    } finally {
      await service.close();
    }
  });

  it("keeps settled writes successful and attributed once when the observer fails after adoption", async () => {
    const writing = gate();
    const settled = gate();
    let writes = 0;
    let stillCurrent = true;
    const source = { ...authority(), current: () => stillCurrent };
    const seen: unknown[] = [];
    const warnings: unknown[] = [];
    const service = host({
      logger: { info: () => undefined, warn: (context) => void warnings.push(context) },
      connect: async () =>
        connection(async () => {
          writes++;
          writing.release();
          await settled.promise;
          return { content: JSON.stringify({ issueId }), isError: false };
        }),
      observeCall: async (call) => {
        seen.push({ owner: call.owner, issue: linearWriteIssue(call) });
        await Promise.resolve();
        throw new Error("receipt disk full");
      },
    });
    try {
      const pending = service.call({
        lane: "operator",
        server: "linear",
        tool: "save_comment",
        arguments: { issueId },
        conversationAuthority: source,
      });
      await writing.promise;
      source.owner.conversationId = "adopted";
      stillCurrent = false;
      settled.release();
      expect(await pending).toMatchObject({ outcome: "ok", isError: false });
      expect(writes).toBe(1);
      expect(seen).toEqual([
        { owner: { conversationId: "original" }, issue: { organizationId: account.workspaceId, issueId } },
      ]);
      expect(warnings).toMatchObject([{ event: "mcp.host.observer_failed" }]);
    } finally {
      await service.close();
    }
  });
});
