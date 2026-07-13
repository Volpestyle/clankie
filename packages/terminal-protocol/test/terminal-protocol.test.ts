import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TerminalCapabilitiesSchema,
  TerminalCapabilitiesChangedMessageSchema,
  TerminalClientMessageSchema,
  TerminalDiscoveryResponseSchema,
  TerminalInputRequestSchema,
  TerminalLeaseGrantMessageSchema,
  TerminalLeaseRenewRequestSchema,
  TerminalOwnerStateMessageSchema,
  TerminalOutputMessageSchema,
  TerminalResizeRequestSchema,
  TerminalSequenceBoundarySchema,
  TerminalServerMessageSchema,
  TerminalSnapshotMessageSchema,
  TerminalSubscribedMessageSchema,
  TerminalWireMessageSchema,
  classifyTerminalCapabilitiesRevision,
  classifyTerminalSequence,
  decodeTerminalBytes,
  encodeTerminalBytes,
} from "../src/index.ts";
import {
  FixtureTerminal,
  ReplayFixtureSchema,
  applyReplayEvent,
  type ReplayFixture,
} from "./virtual-terminal.ts";

const attribution = {
  principalId: "principal-1",
  deviceId: "device-1",
  clientInstanceId: "client-1",
};
const timestamp = "2026-07-12T12:00:00.000Z";
const laterTimestamp = "2026-07-12T12:01:00.000Z";
const openLifecycle = { state: "open" as const };
const closedLifecycle = {
  state: "closed" as const,
  sequence: 3,
  reason: "exited" as const,
  exitCode: 0,
  signal: null,
  closedAt: timestamp,
};

describe("terminal protocol v1 schemas", () => {
  it("parses all byte-bearing messages and helpers without a Node Buffer global", () => {
    const bufferDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
    try {
      expect(Reflect.deleteProperty(globalThis, "Buffer")).toBe(true);
      const streamBase = { protocolVersion: 1, terminalId: "terminal-1", subscriptionId: "subscription-1" };
      const messages = [
        { ...streamBase, type: "terminal.output", sequence: 1, encoding: "base64", data: "aGk=" },
        {
          ...streamBase,
          type: "terminal.snapshot",
          boundary: { afterSequence: 0, nextSequence: 1, parserState: "quiescent" },
          geometry: { columns: 80, rows: 24 },
          restore: { format: "vt_restore_v1", encoding: "base64", data: "G1sySg==" },
          lifecycle: openLifecycle,
        },
        {
          protocolVersion: 1,
          type: "terminal.input",
          requestId: "input-1",
          terminalId: "terminal-1",
          leaseId: "lease-1",
          operationId: "operation-1",
          attribution,
          encoding: "base64",
          data: "aGk=",
        },
      ];
      for (const message of messages) {
        expect(() => TerminalWireMessageSchema.safeParse(message)).not.toThrow();
        expect(TerminalWireMessageSchema.safeParse(message).success).toBe(true);
      }
      for (const data of ["%%%==", "aGk", "aG=k", "Zh==", "Zm9="]) {
        expect(TerminalOutputMessageSchema.safeParse({ ...messages[0], data }).success, data).toBe(false);
      }
      const bytes = new TextEncoder().encode("portable");
      expect(decodeTerminalBytes(encodeTerminalBytes(bytes))).toEqual(bytes);
      expect(decodeTerminalBytes(encodeTerminalBytes(new Uint8Array()))).toEqual(new Uint8Array());
      expect(() => decodeTerminalBytes("Zh==")).toThrow(TypeError);
    } finally {
      if (bufferDescriptor) Object.defineProperty(globalThis, "Buffer", bufferDescriptor);
    }
  });

  it("round-trips raw terminal bytes for the legacy adapter", () => {
    const bytes = new TextEncoder().encode("hello\u001b[31m");
    expect(decodeTerminalBytes(encodeTerminalBytes(bytes))).toEqual(bytes);
  });

  it("negotiates read-only and partially controllable sources honestly", () => {
    const base = {
      observe: true as const,
      resume: true,
      vtRestoreSnapshot: true,
      controlLease: false,
      input: false,
      resize: false,
    };
    expect(TerminalCapabilitiesSchema.parse(base)).toEqual(base);
    expect(
      TerminalCapabilitiesSchema.parse({
        ...base,
        controlLease: true,
        input: true,
      }),
    ).toMatchObject({ input: true, resize: false });
    expect(TerminalCapabilitiesSchema.safeParse({ ...base, input: true }).success).toBe(false);
    expect(
      TerminalCapabilitiesSchema.safeParse({
        ...base,
        resume: true,
        vtRestoreSnapshot: false,
      }).success,
    ).toBe(false);

    expect(
      TerminalDiscoveryResponseSchema.parse({
        protocolVersion: 1,
        type: "terminal.discovery",
        requestId: "request-1",
        grantedScopes: ["observe"],
        sessions: [
          {
            terminalId: "terminal-1",
            workerRunId: "worker-1",
            title: "Verifier",
            source: "herdr",
            geometry: { columns: 100, rows: 30 },
            lastSequence: 42,
            lifecycle: openLifecycle,
            capabilities: base,
            capabilitiesRevision: 1,
          },
        ],
      }).grantedScopes,
    ).toEqual(["observe"]);
  });

  it("rejects unknown versions, extra fields, and malformed byte encodings", () => {
    const discovery = {
      protocolVersion: 1,
      type: "terminal.discover",
      requestId: "request-1",
      supportedProtocolVersions: [1],
      attribution,
    };
    expect(TerminalClientMessageSchema.safeParse(discovery).success).toBe(true);
    expect(TerminalClientMessageSchema.safeParse({ ...discovery, protocolVersion: 2 }).success).toBe(false);
    expect(TerminalClientMessageSchema.safeParse({ ...discovery, surprise: true }).success).toBe(false);
    const snapshot = {
      protocolVersion: 1,
      type: "terminal.snapshot",
      terminalId: "terminal-1",
      subscriptionId: "subscription-1",
      boundary: { afterSequence: 4, nextSequence: 5, parserState: "quiescent" },
      geometry: { columns: 80, rows: 24 },
      restore: { format: "vt_restore_v1", encoding: "base64", data: "G1sySg==" },
      lifecycle: openLifecycle,
    };
    expect(TerminalSnapshotMessageSchema.safeParse(snapshot).success).toBe(true);
    expect(TerminalServerMessageSchema.safeParse({ ...snapshot, protocolVersion: 2 }).success).toBe(false);
    expect(
      TerminalSnapshotMessageSchema.safeParse({
        ...snapshot,
        restore: { ...snapshot.restore, data: "%%%=" },
      }).success,
    ).toBe(false);
  });

  it("rejects inexact or non-quiescent snapshot boundaries", () => {
    expect(
      TerminalSequenceBoundarySchema.safeParse({
        afterSequence: 8,
        nextSequence: 10,
        parserState: "quiescent",
      }).success,
    ).toBe(false);
    expect(
      TerminalSequenceBoundarySchema.safeParse({
        afterSequence: 8,
        nextSequence: 9,
        parserState: "partial_escape",
      }).success,
    ).toBe(false);
    expect(
      TerminalSequenceBoundarySchema.parse({
        afterSequence: 8,
        nextSequence: 9,
        parserState: "quiescent",
      }),
    ).toMatchObject({ afterSequence: 8, nextSequence: 9 });
  });

  it("requires attribution and idempotency identities on control messages", () => {
    const input = {
      protocolVersion: 1,
      type: "terminal.input",
      requestId: "request-input",
      terminalId: "terminal-1",
      leaseId: "lease-1",
      operationId: "operation-1",
      attribution,
      encoding: "base64",
      data: "aGVsbG8=",
    };
    const resize = {
      protocolVersion: 1,
      type: "terminal.resize",
      requestId: "request-resize",
      terminalId: "terminal-1",
      leaseId: "lease-1",
      operationId: "operation-2",
      attribution,
      geometry: { columns: 120, rows: 40 },
    };
    const renew = {
      protocolVersion: 1,
      type: "terminal.lease.renew",
      requestId: "request-renew",
      terminalId: "terminal-1",
      leaseId: "lease-1",
      requestedTtlMs: 60_000,
      attribution,
    };

    expect(TerminalInputRequestSchema.safeParse(input).success).toBe(true);
    expect(TerminalResizeRequestSchema.safeParse(resize).success).toBe(true);
    expect(TerminalLeaseRenewRequestSchema.safeParse(renew).success).toBe(true);
    for (const [schema, message] of [
      [TerminalInputRequestSchema, input],
      [TerminalResizeRequestSchema, resize],
      [TerminalLeaseRenewRequestSchema, renew],
    ] as const) {
      const { attribution: _, ...unattributed } = message;
      expect(schema.safeParse(unattributed).success).toBe(false);
    }
    const { operationId: _, ...nonIdempotentInput } = input;
    expect(TerminalInputRequestSchema.safeParse(nonIdempotentInput).success).toBe(false);
    expect(
      TerminalInputRequestSchema.safeParse({
        ...input,
        attribution: { ...attribution, deviceId: "" },
      }).success,
    ).toBe(false);
  });

  it("models one renewable owner and validates lease attribution time bounds", () => {
    const owner = {
      leaseId: "lease-1",
      attribution,
      acquiredAt: timestamp,
      expiresAt: laterTimestamp,
    };
    expect(
      TerminalOwnerStateMessageSchema.parse({
        protocolVersion: 1,
        type: "terminal.owner_state",
        terminalId: "terminal-1",
        revision: 1,
        owner,
      }).owner,
    ).toEqual(owner);
    expect(
      TerminalLeaseGrantMessageSchema.safeParse({
        protocolVersion: 1,
        type: "terminal.lease.grant",
        requestId: "request-1",
        terminalId: "terminal-1",
        owner,
        ownerStateRevision: 1,
      }).success,
    ).toBe(true);
    expect(
      TerminalLeaseGrantMessageSchema.safeParse({
        protocolVersion: 1,
        type: "terminal.lease.grant",
        requestId: "request-1",
        terminalId: "terminal-1",
        owner: { ...owner, expiresAt: timestamp },
        ownerStateRevision: 1,
      }).success,
    ).toBe(false);
  });

  it("covers subscribe/resume/resync, stream, lifecycle, acknowledgement, error, and closure", () => {
    const clientMessages = [
      {
        protocolVersion: 1,
        type: "terminal.sessions.list",
        requestId: "sessions-1",
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.capabilities.get",
        requestId: "capabilities-1",
        terminalId: "terminal-1",
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.subscribe",
        requestId: "subscribe-1",
        terminalId: "terminal-1",
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.resume",
        requestId: "resume-1",
        terminalId: "terminal-1",
        cursor: { sequence: 4 },
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.resync",
        requestId: "resync-1",
        terminalId: "terminal-1",
        cursor: { sequence: 4 },
        cause: "gap",
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.request",
        requestId: "lease-1",
        terminalId: "terminal-1",
        requestedTtlMs: 60_000,
        attribution,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.release",
        requestId: "release-1",
        terminalId: "terminal-1",
        leaseId: "lease-1",
        attribution,
      },
    ];
    for (const message of clientMessages) {
      expect(TerminalClientMessageSchema.safeParse(message).success).toBe(true);
    }

    const owner = {
      leaseId: "lease-1",
      attribution,
      acquiredAt: timestamp,
      expiresAt: laterTimestamp,
    };
    const streamBase = {
      protocolVersion: 1,
      terminalId: "terminal-1",
      subscriptionId: "subscription-1",
    };
    const serverMessages = [
      {
        protocolVersion: 1,
        type: "terminal.sessions.listed",
        requestId: "sessions-1",
        sessions: [
          {
            terminalId: "terminal-1",
            workerRunId: "worker-1",
            title: "Worker",
            source: "runner_pty",
            geometry: { columns: 80, rows: 24 },
            lastSequence: 3,
            lifecycle: closedLifecycle,
            capabilities: {
              observe: true,
              resume: true,
              vtRestoreSnapshot: true,
              controlLease: true,
              input: true,
              resize: true,
            },
            capabilitiesRevision: 1,
          },
        ],
      },
      {
        protocolVersion: 1,
        type: "terminal.capabilities",
        requestId: "capabilities-1",
        terminalId: "terminal-1",
        revision: 1,
        capabilities: {
          observe: true,
          resume: true,
          vtRestoreSnapshot: true,
          controlLease: true,
          input: true,
          resize: true,
        },
      },
      {
        protocolVersion: 1,
        type: "terminal.subscribed",
        requestId: "subscribe-1",
        terminalId: "terminal-1",
        subscriptionId: "subscription-1",
        cursor: { sequence: 0 },
        initialDelivery: "snapshot",
        lifecycle: closedLifecycle,
        capabilities: {
          observe: true,
          resume: true,
          vtRestoreSnapshot: true,
          controlLease: true,
          input: true,
          resize: true,
        },
        capabilitiesRevision: 1,
      },
      {
        ...streamBase,
        type: "terminal.snapshot",
        boundary: { afterSequence: 0, nextSequence: 1, parserState: "quiescent" },
        geometry: { columns: 80, rows: 24 },
        restore: { format: "vt_restore_v1", encoding: "base64", data: "G1sySg==" },
        lifecycle: openLifecycle,
      },
      { ...streamBase, type: "terminal.output", sequence: 1, encoding: "base64", data: "aGk=" },
      {
        ...streamBase,
        type: "terminal.geometry",
        sequence: 2,
        geometry: { columns: 100, rows: 30 },
        cause: "control",
        operationId: "operation-2",
      },
      {
        ...streamBase,
        type: "terminal.closed",
        sequence: 3,
        reason: "exited",
        exitCode: 0,
        signal: null,
        closedAt: timestamp,
      },
      {
        protocolVersion: 1,
        type: "terminal.resync_required",
        terminalId: "terminal-1",
        subscriptionId: "subscription-1",
        requestedAfterSequence: 1,
        availableFromSequence: 8,
        reason: "replay_unavailable",
        lifecycle: closedLifecycle,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.renewed",
        terminalId: "terminal-1",
        requestId: "renew-1",
        owner,
        ownerStateRevision: 2,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.released",
        terminalId: "terminal-1",
        requestId: "release-1",
        leaseId: "lease-1",
        ownerStateRevision: 3,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.expired",
        terminalId: "terminal-1",
        leaseId: "lease-1",
        expiredAt: laterTimestamp,
        ownerStateRevision: 3,
      },
      {
        protocolVersion: 1,
        type: "terminal.lease.rejected",
        terminalId: "terminal-1",
        requestId: "lease-2",
        operation: "request",
        reason: "already_owned",
        ownerStateRevision: 2,
      },
      {
        protocolVersion: 1,
        type: "terminal.operation_ack",
        requestId: "input-1",
        terminalId: "terminal-1",
        leaseId: "lease-1",
        operationId: "operation-1",
        operation: "input",
        disposition: "duplicate",
      },
      {
        protocolVersion: 1,
        type: "terminal.error",
        requestId: "input-1",
        terminalId: "terminal-1",
        code: "operation_conflict",
        message: "operation id reused with different content",
        retryable: false,
      },
    ];
    for (const message of serverMessages) {
      expect(TerminalServerMessageSchema.safeParse(message).success).toBe(true);
      expect(TerminalWireMessageSchema.safeParse(message).success).toBe(true);
    }
  });

  it("preserves closed lifecycle across discovery and snapshot resync", () => {
    const discovery = {
      terminalId: "terminal-1",
      workerRunId: "worker-1",
      title: "Closed worker",
      source: "runner_pty",
      geometry: { columns: 80, rows: 24 },
      lastSequence: 20,
      lifecycle: closedLifecycle,
      capabilities: {
        observe: true,
        resume: true,
        vtRestoreSnapshot: true,
        controlLease: false,
        input: false,
        resize: false,
      },
      capabilitiesRevision: 1,
    };
    expect(
      TerminalDiscoveryResponseSchema.safeParse({
        protocolVersion: 1,
        type: "terminal.discovery",
        requestId: "discover-1",
        grantedScopes: ["observe"],
        sessions: [discovery],
      }).success,
    ).toBe(true);
    const snapshot = {
      protocolVersion: 1,
      type: "terminal.snapshot",
      terminalId: "terminal-1",
      subscriptionId: "subscription-1",
      boundary: { afterSequence: 20, nextSequence: 21, parserState: "quiescent" },
      geometry: { columns: 80, rows: 24 },
      restore: { format: "vt_restore_v1", encoding: "base64", data: "G1sySg==" },
      lifecycle: closedLifecycle,
    };
    expect(TerminalSnapshotMessageSchema.safeParse(snapshot).success).toBe(true);
    expect(
      TerminalSnapshotMessageSchema.safeParse({
        ...snapshot,
        boundary: { ...snapshot.boundary, afterSequence: 2, nextSequence: 3 },
      }).success,
    ).toBe(false);
  });

  it("pushes revisioned capability changes to attached clients", () => {
    const message = {
      protocolVersion: 1,
      type: "terminal.capabilities_changed",
      terminalId: "terminal-1",
      subscriptionId: "subscription-1",
      revision: 2,
      capabilities: {
        observe: true,
        resume: true,
        vtRestoreSnapshot: true,
        controlLease: false,
        input: false,
        resize: false,
      },
    };
    expect(TerminalCapabilitiesChangedMessageSchema.safeParse(message).success).toBe(true);
    expect(TerminalServerMessageSchema.safeParse(message).success).toBe(true);
    expect(TerminalCapabilitiesChangedMessageSchema.safeParse({ ...message, revision: 0 }).success).toBe(
      false,
    );
  });

  it("converges on the atomic subscribed capability baseline across an attach race", () => {
    const revisionNCapabilities = {
      observe: true as const,
      resume: true,
      vtRestoreSnapshot: true,
      controlLease: true,
      input: true,
      resize: true,
    };
    const revisionNPlusOneCapabilities = {
      ...revisionNCapabilities,
      controlLease: false,
      input: false,
      resize: false,
    };
    const discovered = TerminalDiscoveryResponseSchema.parse({
      protocolVersion: 1,
      type: "terminal.discovery",
      requestId: "discover-race",
      grantedScopes: ["observe", "control"],
      sessions: [
        {
          terminalId: "terminal-race",
          workerRunId: "worker-race",
          title: "Race",
          source: "runner_pty",
          geometry: { columns: 80, rows: 24 },
          lastSequence: 10,
          lifecycle: openLifecycle,
          capabilities: revisionNCapabilities,
          capabilitiesRevision: 7,
        },
      ],
    });
    expect(discovered.sessions[0]!.capabilitiesRevision).toBe(7);

    // Capabilities change to N+1 before attach. The acknowledgement is the
    // atomic baseline for subscribe, resume, and resync attachment paths.
    const subscribed = TerminalSubscribedMessageSchema.parse({
      protocolVersion: 1,
      type: "terminal.subscribed",
      requestId: "resume-race",
      terminalId: "terminal-race",
      subscriptionId: "subscription-race",
      cursor: { sequence: 10 },
      initialDelivery: "replay",
      lifecycle: openLifecycle,
      capabilities: revisionNPlusOneCapabilities,
      capabilitiesRevision: 8,
    });
    let capabilities = subscribed.capabilities;
    let revision = subscribed.capabilitiesRevision;
    expect({ capabilities, revision }).toEqual({
      capabilities: revisionNPlusOneCapabilities,
      revision: 8,
    });

    for (const push of [
      { revision: 7, capabilities: revisionNCapabilities },
      { revision: 8, capabilities: revisionNCapabilities },
      { revision: 9, capabilities: revisionNCapabilities },
    ]) {
      if (classifyTerminalCapabilitiesRevision(revision, push.revision) === "apply") {
        capabilities = push.capabilities;
        revision = push.revision;
      }
    }
    expect({ capabilities, revision }).toEqual({ capabilities: revisionNCapabilities, revision: 9 });
    expect(() => classifyTerminalCapabilitiesRevision(0, 1)).toThrow(RangeError);
  });
});

describe("terminal sequence policy", () => {
  it("applies contiguous frames, discards duplicates, and resyncs on a gap", () => {
    expect(classifyTerminalSequence(8, 9)).toBe("apply");
    expect(classifyTerminalSequence(8, 8)).toBe("duplicate");
    expect(classifyTerminalSequence(8, 3)).toBe("duplicate");
    expect(classifyTerminalSequence(8, 10)).toBe("gap");
    expect(() => classifyTerminalSequence(-1, 1)).toThrow(RangeError);
  });
});

describe("immutable VT restore replay fixtures", () => {
  const fixtureDirectory = fileURLToPath(new URL("./fixtures/v1/", import.meta.url));

  it("matches the pinned SHA-256 manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("./fixtures/v1/manifest.json", import.meta.url), "utf8"),
    ) as { algorithm: string; fixtures: Record<string, string>; schemaVersion: number };
    expect(manifest).toMatchObject({ schemaVersion: 1, algorithm: "sha256" });
    const compatibilityReport = await readFile(new URL("../COMPATIBILITY.md", import.meta.url), "utf8");
    for (const [name, expectedHash] of Object.entries(manifest.fixtures)) {
      const contents = await readFile(`${fixtureDirectory}${name}`);
      expect(createHash("sha256").update(contents).digest("hex"), name).toBe(expectedHash);
      expect(compatibilityReport, `${name} compatibility report hash`).toContain(expectedHash);
    }
  });

  for (const name of ["alternate-screen", "cursor-color", "resize-utf8"] as const) {
    it(`reconstructs uninterrupted visible state for ${name}`, async () => {
      const fixture = ReplayFixtureSchema.parse(
        JSON.parse(await readFile(new URL(`./fixtures/v1/${name}.json`, import.meta.url), "utf8")),
      );
      proveReplay(fixture);
    });
  }
});

function proveReplay(fixture: ReplayFixture): void {
  const uninterrupted = new FixtureTerminal(fixture.initialGeometry);
  const beforeBoundary = fixture.events.filter(
    (event) => event.sequence <= fixture.snapshot.boundary.afterSequence,
  );
  const afterBoundary = fixture.events.filter(
    (event) => event.sequence >= fixture.snapshot.boundary.nextSequence,
  );

  for (const event of beforeBoundary) applyReplayEvent(uninterrupted, event);
  expect(uninterrupted.isQuiescent, `${fixture.id} boundary must be parser-quiescent`).toBe(true);

  const restored = new FixtureTerminal(fixture.snapshot.geometry);
  restored.writeBase64(fixture.snapshot.restore);
  expect(restored.isQuiescent, `${fixture.id} restore must be parser-quiescent`).toBe(true);
  expect(restored.view(), `${fixture.id} snapshot-at-N`).toEqual(uninterrupted.view());

  let lastApplied = fixture.snapshot.boundary.afterSequence;
  for (const event of afterBoundary) {
    expect(classifyTerminalSequence(lastApplied, event.sequence)).toBe("apply");
    applyReplayEvent(uninterrupted, event);
    applyReplayEvent(restored, event);
    lastApplied = event.sequence;
  }

  expect(restored.isQuiescent, `${fixture.id} final restore parser state`).toBe(true);
  expect(restored.view(), `${fixture.id} snapshot plus tail`).toEqual(uninterrupted.view());
  expect(uninterrupted.view(), `${fixture.id} explicit expected state`).toEqual(fixture.expected);
}
