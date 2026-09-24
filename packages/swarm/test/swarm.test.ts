import { afterEach, expect, test, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, realpath } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CoordinationClient, enrollRuntime, localEndpoint, ownerState } from "swarm-mcp/runtime";
import { SwarmHost } from "../src/index.ts";
import { Value } from "typebox/value";

const roots: string[] = [];
const hosts: SwarmHost[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    // Only this test's private coordinator can listen on this freshly allocated path.
    for (const entry of await readdir(root).catch(() => [])) {
      try {
        const config = JSON.parse(await readFile(join(root, entry, "owner.json"), "utf8"));
        const pids = execFileSync("lsof", ["-t", "--", localEndpoint(config.databasePath)], {
          encoding: "utf8",
        })
          .trim()
          .split(/\s+/u);
        for (const pid of pids) if (/^\d+$/u.test(pid)) process.kill(Number(pid), "SIGTERM");
      } catch {
        /* Already stopped or not a coordinator directory. */
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("real MCP delivers isolated inboxes, explicit acknowledgment and stable identity after host restart", async () => {
  const root = await mkdtemp("/tmp/clankie-swarm-test-");
  roots.push(root);
  const received: Array<{ id: string; prompt: string }> = [];
  let ready = false;
  let preference = "Original owner preference 🐑";
  let snapshots = 0;
  const doctrine = () => preference + "\n" + "Project instructions 🐑\n".repeat(1400);
  const open = async () => {
    const host = new SwarmHost({
      stateDirectory: root,
      canDispatch: () => false,
      warn: (message) => {
        throw new Error(message);
      },
    });
    hosts.push(host);
    await host.start({
      ready: () => ready,
      instructions: async (binding, skills) => {
        expect(skills).toEqual(["fixture-portable-skill"]);
        snapshots++;
        return binding.conversationId + "\n" + doctrine();
      },
      wake: async (id, prompt) => {
        received.push({ id, prompt });
      },
    });
    return host;
  };
  const tools = async (host: SwarmHost, id: string) => {
    const registered = new Map<
      string,
      { execute(id: string, args: unknown): Promise<{ content: Array<{ text: string }> }> }
    >();
    await host.extension({ conversationId: id, cwd: root }).factory({
      registerTool: (tool: { name: string; execute: never }) => registered.set(tool.name, tool),
      on: () => undefined,
    } as never);
    return async (name: string, args: unknown) =>
      JSON.parse((await registered.get(name)!.execute("test", args)).content[0]!.text).data;
  };
  const host = await open();
  const alice = await tools(host, "alice");
  await expect(alice("swarm_assign", { routing: { capabilities: ["code"], durable: true } })).rejects.toThrow(
    "provisioning unavailable",
  );
  const native = await host.tools({ conversationId: "alice", cwd: root });
  const nativeCall = async (name: string, args: Record<string, unknown>) => {
    const tool = native.find((tool) => tool.name === name)!;
    expect(Value.Check(tool.parameters, args)).toBe(true);
    const result = await tool.execute("native", args, undefined, undefined, {} as never);
    return JSON.parse((result.content[0] as { text: string }).text).data;
  };
  expect((await nativeCall("swarm_sync", {})).actor).toBe((await alice("swarm_sync", {})).actor);
  const assignment = {
    commandId: "record-work-without-runtime",
    skills: ["fixture-portable-skill"],
    title: "Review an existing result",
    contract: {
      objective: "Review",
      worktree: root,
      acceptanceCriteria: ["Reviewed"],
      expectedArtifacts: [],
      constraints: [],
    },
  };
  const original = "alice\n" + doctrine();
  const assigned = await nativeCall("swarm_assign", assignment);
  preference = "Changed preferences";
  expect((await nativeCall("swarm_assign", assignment)).value.task.id).toBe(assigned.value.task.id);
  expect(snapshots).toBe(1);
  await expect(nativeCall("swarm_assign", { ...assignment, title: "Different work" })).rejects.toThrow(
    "different work",
  );
  const bob = await tools(host, "bob");
  const a = await alice("swarm_sync", {}),
    b = await bob("swarm_sync", {});
  expect(a.actor).not.toBe(b.actor);
  const enrolled = await enrollRuntime({
    stateDirectory: join(root, createHash("sha256").update(root).digest("hex")),
    nodePath: process.execPath,
    ownerPath: join(
      dirname(createRequire(import.meta.url).resolve("swarm-mcp/package.json")),
      "dist/coordination/owner-cli.js",
    ),
    host: "pi",
    hostSessionId: "external-worker",
    incarnation: "external-1",
    identity: { directory: root, fileRoot: root, projectRoot: root, profile: "clankie" },
  });
  const peer = await CoordinationClient.connect(
    enrolled.environment.SWARM_COORDINATOR_ENDPOINT,
    enrolled.environment.SWARM_SESSION_CAPABILITY,
  );
  try {
    const task = (await peer.request({ op: "task_detail", taskId: assigned.value.task.id })) as {
      contract: { instructions: string[] };
    };
    expect(task.contract.instructions.length).toBeGreaterThan(1);
    const parts: string[] = [];
    for (const uri of task.contract.instructions) {
      const artifactId = uri.split("/").at(-1)!;
      const page = (await peer.request({ op: "artifact_read", artifactId })) as {
        data: string;
        status: string;
      };
      expect(page.status).toBe("available");
      parts.push(Buffer.from(page.data, "base64").toString("utf8"));
      expect(
        await nativeCall("swarm_evidence", { action: "read", commandId: "read", artifactId }),
      ).toMatchObject({ status: "available", text: parts.at(-1) });
    }
    expect(parts.join("")).toBe(original);
  } finally {
    peer.close();
  }
  expect(await host.worker("alice", enrolled.environment.SWARM_SESSION_CAPABILITY)).toEqual({
    actor: enrolled.actor,
    scope: enrolled.scope,
  });
  expect(await host.workerInScope(enrolled.scope, enrolled.environment.SWARM_SESSION_CAPABILITY)).toEqual({
    actor: enrolled.actor,
    scope: enrolled.scope,
  });
  await expect(
    host.workerInScope("unknown-scope", enrolled.environment.SWARM_SESSION_CAPABILITY),
  ).rejects.toThrow("not connected");
  await expect(host.workerInScope(enrolled.scope, "wrong-capability")).rejects.toThrow();
  await expect(host.worker("alice", "wrong-capability")).rejects.toThrow();
  await expect(host.worker("missing", enrolled.environment.SWARM_SESSION_CAPABILITY)).rejects.toThrow(
    "not connected",
  );
  const taskId = assigned.value.task.id;
  const claim = (
    await bob("swarm_task", { action: "claim", commandId: "worker-claim", taskId, expectedVersion: 1 })
  ).value;
  expect(await host.assignment("alice", taskId, b.actor)).toMatchObject({
    conversationId: "alice",
    taskId,
    actor: b.actor,
    attemptId: claim.attemptId,
    fence: claim.fence,
  });
  await expect(host.assignment("bob", taskId, b.actor)).rejects.toThrow("owned by this conversation");
  await expect(host.assignment("alice", taskId, a.actor)).rejects.toThrow("active work");
  await expect(host.assignment("missing", taskId, b.actor)).rejects.toThrow("not connected");
  await alice("swarm_send", {
    commandId: "ask-1",
    recipient: b.actor,
    threadId: "acceptance",
    kind: "question",
    body: "Which acceptance criterion?",
  });
  expect(received).toEqual([]);
  ready = true;
  host.settled("bob");
  await expect.poll(() => received.length).toBe(1);
  expect(received[0]!.id).toBe("bob");
  const envelope = JSON.parse(received[0]!.prompt.split("\n").slice(1).join("\n"));
  expect(envelope.message.body).toBe("Which acceptance criterion?");
  // Admission does not consume the message: only the recipient can acknowledge it.
  await expect(
    alice("swarm_inbox", {
      commandId: "wrong-ack",
      action: "ack",
      messageId: envelope.message.id,
      leaseToken: envelope.leaseToken,
    }),
  ).rejects.toThrow();
  await bob("swarm_inbox", {
    commandId: "ack-1",
    action: "ack",
    messageId: envelope.message.id,
    leaseToken: envelope.leaseToken,
  });
  await bob("swarm_task", {
    action: "finish",
    commandId: "worker-finish",
    taskId,
    attemptId: claim.attemptId,
    fence: claim.fence,
    outcome: "completed",
    report: { summary: "reviewed", evidence: ["result checked"], limitations: [] },
  });
  await expect(host.assignment("alice", taskId, b.actor)).rejects.toThrow("active work");
  ready = false;
  const contact = (await alice("swarm_find", { kind: "peers" })).items.find(
    (peer: { agentId: string }) => peer.agentId === b.actor,
  );
  expect(a.recipientGeneration).toBe(true);
  const directMessage = {
    commandId: "contact-before-restart",
    recipient: contact.agentId,
    recipientGeneration: contact.generation,
    kind: "question",
    body: "For this particular session",
    threadId: "contact-thread",
  };
  await nativeCall("swarm_send", directMessage);
  await host.close();
  hosts.splice(hosts.indexOf(host), 1);
  ready = false;
  const resumed = await open();
  const resumedAlice = await tools(resumed, "alice");
  expect((await resumedAlice("swarm_assign", assignment)).value.task.id).toBe(taskId);
  expect(snapshots).toBe(1);
  const fresh = await resumedAlice("swarm_assign", { ...assignment, commandId: "new-work" });
  const freshTask = await resumedAlice("swarm_find", { kind: "task", taskId: fresh.value.task.id });
  const freshText = await resumedAlice("swarm_evidence", {
    action: "read",
    commandId: "read-fresh",
    artifactId: freshTask.contract.instructions[0].split("/").at(-1),
  });
  expect(freshText.text).toContain(preference);
  expect(snapshots).toBe(2);
  const next = await tools(resumed, "bob");
  expect((await next("swarm_sync", {})).actor).toBe(b.actor);
  expect(
    (await next("swarm_inbox", { commandId: "fetch-after-restart", action: "fetch", consumer: "test" })).value
      .deliveries,
  ).toEqual([]);
  await expect(resumedAlice("swarm_send", { ...directMessage, commandId: "stale-contact" })).rejects.toThrow(
    "Recipient session",
  );
  const replacement = (await resumedAlice("swarm_find", { kind: "peers" })).items.find(
    (peer: { agentId: string }) => peer.agentId === b.actor,
  );
  expect(replacement.generation).toBeGreaterThan(contact.generation);
  await resumedAlice("swarm_send", {
    ...directMessage,
    commandId: "explicit-new-contact",
    recipientGeneration: replacement.generation,
  });
  const delivery = (
    await next("swarm_inbox", { commandId: "contact-fetch", action: "fetch", consumer: "test" })
  ).value.deliveries[0];
  expect(delivery.message).toMatchObject({
    body: directMessage.body,
    recipientGeneration: replacement.generation,
  });
}, 30000);

test("named external coordinators retain independent work, doctrine and grants across restart", async () => {
  const { SettingsStore } = await import("@clankie/settings");
  const { FileCredentialStore } = await import("@clankie/credential-broker");
  const root = await mkdtemp("/tmp/clankie-external-");
  roots.push(join(root, "clankie"), root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const ownerPath = join(
    dirname(createRequire(import.meta.url).resolve("swarm-mcp/package.json")),
    "dist/coordination/owner-cli.js",
  );
  const enroll = (name: string, hostSessionId: string) =>
    enrollRuntime({
      stateDirectory: join(root, name),
      nodePath: process.execPath,
      ownerPath,
      host: "pi",
      hostSessionId,
      incarnation: "first",
      identity: { directory: root, fileRoot: root, projectRoot: root, profile: "external" },
    });
  const alpha = await enroll("alpha", "lead");
  const beta = await enroll("beta", "lead");
  expect(alpha.scope).toBe(beta.scope); // Same project/profile is not coordinator identity.
  const worker = await enroll("alpha", "user-started-terminal");
  const peer = await CoordinationClient.connect(
    worker.environment.SWARM_COORDINATOR_ENDPOINT,
    worker.environment.SWARM_SESSION_CAPABILITY,
  );
  const messages: string[] = [];
  let ready = false;
  const open = async () => {
    const host = new SwarmHost({
      stateDirectory: join(root, "clankie"),
      connections: { settings, credentials },
      canDispatch: () => false,
      warn: () => {},
    });
    hosts.push(host);
    await host.start({
      ready: () => ready,
      wake: async (_id, message) => {
        messages.push(message);
      },
      instructions: async (binding) => `${binding.conversationId}: owner doctrine`,
    });
    return host;
  };
  const caller = async (host: SwarmHost, conversationId = "global-default") => {
    const tools = await host.tools({ conversationId, cwd: root });
    return async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(Value.Check(tool.parameters, args)).toBe(true);
      return JSON.parse(
        ((await tool.execute("test", args, undefined, undefined, {} as never)).content[0] as { text: string })
          .text,
      ).data;
    };
  };
  const input = (id: string, enrolled: typeof alpha) => ({
    id,
    conversationId: "global-default",
    endpoint: enrolled.environment.SWARM_COORDINATOR_ENDPOINT,
    capability: enrolled.environment.SWARM_SESSION_CAPABILITY,
  });
  let host = await open();
  try {
    await host.connect(input("alpha", alpha), root);
    await host.connect(input("beta", beta), root);
    const contact = (await host.contacts()).find(
      (entry) => entry.contact.connectionId === "alpha" && entry.contact.actor === worker.actor,
    )!.contact;
    await expect(
      host.sendContact({ ...contact, connectionId: "beta" }, "wrong owner", "cross-contact", "thread"),
    ).rejects.toThrow("coordinator changed");
    await host.sendContact(contact, "Direct contact", "direct-contact", "contact-thread");
    const direct = (await peer.request({
      op: "command",
      command: { id: "direct-fetch", type: "inbox.fetch", payload: { consumer: "test" } },
    })) as { value: { deliveries: Array<{ message: { body: string; id: string }; leaseToken: string }> } };
    expect(direct.value.deliveries[0]!.message.body).toBe("Direct contact");
    await peer.request({
      op: "command",
      command: {
        id: "direct-ack",
        type: "inbox.ack",
        payload: {
          messageId: direct.value.deliveries[0]!.message.id,
          leaseToken: direct.value.deliveries[0]!.leaseToken,
        },
      },
    });
    ready = true;
    await peer.request({
      op: "command",
      command: {
        id: "first-contact",
        type: "message.send",
        payload: {
          recipient: alpha.actor,
          threadId: "introduction",
          kind: "question",
          body: "Already listening?",
        },
      },
    });
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toContain("connection=alpha");
    ready = false;
    const firstEnvelope = JSON.parse(messages[0]!.split("\n").slice(1).join("\n"));
    const call = await caller(host);
    await call("swarm_inbox", {
      connection: "alpha",
      action: "ack",
      commandId: "ack-first",
      messageId: firstEnvelope.message.id,
      leaseToken: firstEnvelope.leaseToken,
    });
    messages.length = 0;
    expect((await call("swarm_sync", { connection: "alpha" })).actor).toBe(alpha.actor);
    expect((await call("swarm_sync", { connection: "beta" })).actor).toBe(beta.actor);
    await expect(call("swarm_sync", { connection: "missing" })).rejects.toThrow("unavailable");
    const other = await caller(host, "other-project");
    await expect(other("swarm_sync", { connection: "alpha" })).rejects.toThrow("another conversation");
    const work = {
      commandId: "same-command",
      title: "Review existing work",
      contract: {
        objective: "Review",
        worktree: root,
        acceptanceCriteria: ["Checked"],
        expectedArtifacts: [],
        constraints: [],
      },
    };
    const a = await call("swarm_assign", { ...work, connection: "alpha" });
    const b = await call("swarm_assign", { ...work, connection: "beta" });
    expect(a.value.task.id).not.toBe(b.value.task.id);
    const taskId = a.value.task.id;
    const detail = await call("swarm_find", { connection: "alpha", kind: "task", taskId });
    const instruction = await call("swarm_evidence", {
      connection: "alpha",
      action: "read",
      commandId: "read",
      artifactId: detail.contract.instructions[0].split("/").at(-1),
    });
    expect(instruction.text).toBe("global-default: owner doctrine");
    await expect(call("swarm_find", { connection: "beta", kind: "task", taskId })).rejects.toThrow();
    await peer.request({
      op: "command",
      command: { id: "claim", type: "task.claim", payload: { taskId, expectedVersion: 1 } },
    });
    expect(await host.assignment("global-default", taskId, worker.actor, "alpha")).toMatchObject({
      connectionId: "alpha",
      actor: worker.actor,
    });
    await expect(host.assignment("global-default", taskId, worker.actor, "beta")).rejects.toThrow();
    expect(
      await host.workerInScope(worker.scope, worker.environment.SWARM_SESSION_CAPABILITY, "alpha"),
    ).toEqual({ actor: worker.actor, scope: worker.scope });
    await expect(
      host.workerInScope(worker.scope, worker.environment.SWARM_SESSION_CAPABILITY, "beta"),
    ).rejects.toThrow();
    await expect(
      host.workerInScope(worker.scope, worker.environment.SWARM_SESSION_CAPABILITY),
    ).rejects.toThrow();
    await expect(host.connect(input("alpha", beta), root)).rejects.toThrow("pinned");
    expect(await readFile(settings.path, "utf8")).not.toContain(alpha.environment.SWARM_SESSION_CAPABILITY);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    host = await open();
    const resumed = await caller(host);
    expect((await resumed("swarm_assign", { ...work, connection: "alpha" })).value.task.id).toBe(taskId);
    expect((await resumed("swarm_sync", { connection: "beta" })).actor).toBe(beta.actor);
    await peer.request({
      op: "command",
      command: {
        id: "question",
        type: "message.send",
        payload: {
          recipient: alpha.actor,
          threadId: "existing-work",
          kind: "question",
          body: "Review complete?",
        },
      },
    });
    ready = true;
    host.settled("global-default");
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toContain("connection=alpha");
    await host.disconnect("alpha");
    expect((await host.contacts()).some((entry) => entry.contact.connectionId === "alpha")).toBe(false);
    await expect(host.sendContact(contact, "disconnected", "disabled-contact", "thread")).rejects.toThrow(
      "disabled",
    );
    await expect(resumed("swarm_sync", { connection: "alpha" })).rejects.toThrow("disabled");
    await expect(host.assignment("global-default", taskId, worker.actor, "alpha")).rejects.toThrow(
      "disabled",
    );
    expect((await resumed("swarm_sync", { connection: "beta" })).actor).toBe(beta.actor);
    await host.connect(input("alpha", alpha), root);
    expect((await resumed("swarm_sync", { connection: "alpha" })).actor).toBe(alpha.actor);
  } finally {
    peer.close();
  }
}, 30_000);

test("updating Clankie's worker bridge preserves other configured execution routes", async () => {
  const root = await mkdtemp("/tmp/clankie-swarm-routes-");
  roots.push(root);
  const stateDirectory = join(root, createHash("sha256").update(root).digest("hex"));
  const owner = await ownerState(stateDirectory);
  const route = {
    id: "herdr-claude",
    stateDirectory,
    profile: "clankie",
    socketPath: join(root, "one.sock"),
    herdrPath: process.execPath,
    nodePath: process.execPath,
    workerPath: process.execPath,
    claudePath: process.execPath,
    capabilities: ["code"],
    capacity: 1,
  };
  const other = { ...route, id: "another-runtime", socketPath: join(root, "two.sock") };
  await writeFile(
    owner.configPath,
    JSON.stringify({
      ...owner,
      dispatch: {
        maximum: 2,
        observationMaxAgeMs: 60000,
        peers: [],
        herdr: [route, other],
      },
    }),
    { mode: 0o600 },
  );
  const workerMcp = { command: "clankie", args: ["mcp", "--swarm"] };
  const host = new SwarmHost({
    stateDirectory: root,
    workerMcp,
    canDispatch: () => false,
    warn: (message) => {
      throw new Error(message);
    },
  });
  hosts.push(host);
  await host.start({ ready: () => true, wake: async () => undefined });
  const tools = await host.tools({ conversationId: "lead", cwd: root });
  await tools
    .find((tool) => tool.name === "swarm_sync")!
    .execute("test", {}, undefined, undefined, {} as never);
  const configured = JSON.parse(await readFile(owner.configPath, "utf8"));
  expect(configured.dispatch.herdr).toEqual([
    { ...route, enabled: true, mcpServers: { clankie_worker: workerMcp } },
    { ...other, enabled: true },
  ]);
});

test("routes explicit runtime selection and retains uncertain work across disconnect and endpoint changes", async () => {
  const root = await realpath(await mkdtemp("/tmp/clankie-runtime-dispatch-"));
  roots.push(root);
  const bin = join(root, "bin"),
    log = join(root, "launches.jsonl");
  await mkdir(bin);
  await writeFile(
    join(bin, "herdr"),
    `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({socket:process.env.HERDR_SOCKET_PATH,args:process.argv.slice(2)})+'\\n');
process.exit(1);
`,
    { mode: 0o700 },
  );
  await writeFile(join(bin, "claude"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  let connections = ["one", "two"].map((id) => ({
    id,
    socketPath: join(root, `${id}.sock`),
    enabled: true,
    state: "healthy",
    capacity: 1,
    capabilities: ["code"],
  }));
  const host = new SwarmHost({
    stateDirectory: root,
    runtimeConnections: async () => connections,
    warn: (message) => {
      throw new Error(message);
    },
  });
  hosts.push(host);
  await host.start({ ready: () => true, wake: async () => undefined });
  const tools = await host.tools({ conversationId: "lead", cwd: root });
  const assign = tools.find((tool) => tool.name === "swarm_assign")!;
  const input = {
    commandId: "runtime-work",
    title: "Work",
    runtime: "two",
    routing: { capabilities: ["code"], durable: true },
    contract: {
      objective: "Work",
      worktree: root,
      acceptanceCriteria: ["Done"],
      expectedArtifacts: [],
      constraints: [],
    },
  };
  const first = await assign.execute("test", input, undefined, undefined, {} as never);
  expect(JSON.stringify(first)).toContain("uncertain");
  const launched = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(launched).toHaveLength(1);
  expect(launched[0].socket).toBe(join(root, "two.sock"));
  const request = CoordinationClient.prototype.request;
  const oldOwner = vi
    .spyOn(CoordinationClient.prototype, "request")
    .mockImplementation(async function (this: CoordinationClient, op) {
      const result = await request.call(this, op);
      return op.op === "bootstrap" ? { ...(result as object), dispatchConfigReload: false } : result;
    });
  await expect(host.syncRuntimeConnections()).rejects.toThrow(/upgraded/u);
  await expect(assign.execute("test", input, undefined, undefined, {} as never)).rejects.toThrow(/upgraded/u);
  oldOwner.mockRestore();
  connections = connections.map((entry) => (entry.id === "two" ? { ...entry, enabled: false } : entry));
  await host.syncRuntimeConnections();
  await expect(assign.execute("test", input, undefined, undefined, {} as never)).rejects.toThrow(
    /unavailable/u,
  );
  connections = connections.map((entry) =>
    entry.id === "two" ? { ...entry, enabled: true, socketPath: join(root, "replacement.sock") } : entry,
  );
  await host.syncRuntimeConnections();
  const retry = await assign.execute("test", input, undefined, undefined, {} as never);
  expect(JSON.stringify(retry)).toContain("blocked");
  expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
  const owner = await ownerState(join(root, createHash("sha256").update(root).digest("hex")));
  expect(
    Array.isArray(owner.dispatch?.herdr) &&
      owner.dispatch.herdr.some(
        (route) => route.socketPath === join(root, "two.sock") && route.enabled === false,
      ),
  ).toBe(true);
  // Existing enrolled peers remain usable with every Herdr connection disabled.
  connections = connections.map((entry) => ({ ...entry, enabled: false }));
  const worker = await enrollRuntime({
    stateDirectory: dirname(owner.configPath),
    nodePath: process.execPath,
    ownerPath: join(
      dirname(createRequire(import.meta.url).resolve("swarm-mcp/package.json")),
      "dist/coordination/owner-cli.js",
    ),
    host: "pi",
    hostSessionId: "independent-terminal",
    incarnation: "first",
    identity: { directory: root, fileRoot: root, projectRoot: root, profile: "clankie" },
  });
  const peer = await CoordinationClient.connect(
    worker.environment.SWARM_COORDINATOR_ENDPOINT,
    worker.environment.SWARM_SESSION_CAPABILITY,
  );
  try {
    await peer.request({
      op: "command",
      command: { id: "available", type: "session.observe", payload: { runtime: "available" } },
    });
    const configured = JSON.parse(await readFile(owner.configPath, "utf8"));
    configured.dispatch.peers = [
      {
        id: "independent-terminal",
        worker: {
          scope: worker.scope,
          actor: worker.actor,
          sessionId: worker.sessionId,
          generation: worker.generation,
        },
        host: "terminal",
        capabilities: ["code"],
        durable: true,
        capacity: 1,
        overhead: 0,
      },
    ];
    await writeFile(owner.configPath, JSON.stringify(configured), { mode: 0o600 });
    const routed = await assign.execute(
      "test",
      { ...input, commandId: "peer-work", runtime: undefined },
      undefined,
      undefined,
      {} as never,
    );
    const block = routed.content.find((entry) => entry.type === "text");
    if (!block || block.type !== "text") throw new Error("Missing dispatch result");
    const { data } = JSON.parse(block.text);
    expect(data.status).toBe("bound");
    await expect(host.assignment("lead", data.taskId, worker.actor)).resolves.toBeDefined();
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(1);
  } finally {
    peer.close();
  }
});
