import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  appendFile,
  rm,
  realpath,
  lstat,
  rename,
  mkdir,
  symlink,
  chmod,
  link,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { beforeAll, expect, it } from "vitest";
import { NativeFixtureAdmissions, type FixtureOriginalVerifier } from "../src/native-fixture-admissions.ts";
import { createFixtureBootstrap, type OwnedFixture } from "../src/fixture-admission-bootstrap.ts";
import { FixtureRequestIndex } from "../src/fixture-request-index.ts";
import { fleetProcessHelper, nativeProcessStart } from "../src/local-fleet-process.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const auditPath = join(repoRoot, ".local/fixture-corrective-roots.jsonl");
// Source checkouts build the kernel helper and the pinned fixture artifact the host trusts.
beforeAll(async () => {
  for (const script of ["build-fleet-proof.mjs", "build-fixture-read.mjs"])
    await promisify(execFile)(process.execPath, [join(repoRoot, "scripts", script)], { timeout: 120_000 });
}, 130_000);
const privateRoot = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fixture-corrective-")));
  await appendFile(auditPath, `${JSON.stringify({ event: "test-root-created", root, pid: process.pid })}\n`);
  return root;
};
const address = async (server: ReturnType<typeof serve>) => {
  if (!server.listening) await once(server, "listening");
  const value = server.address();
  if (!value || typeof value === "string") throw new Error("Owned listener unavailable");
  return `http://127.0.0.1:${value.port}`;
};
const close = (server: ReturnType<typeof serve>) =>
  new Promise<void>((resolveClose) => server.close(() => resolveClose()));
const absent = async (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
const issue = () => ({ requestId: randomUUID(), receiptId: randomUUID(), assurance: "host-seat/v1" });
// Hardlinks a test-owned file into the next owned fixture root as soon as it appears, so that
// root's real cleanup must refuse its contents and preserve it.
const plantForeignLink = (scratch: string, foreign: string) => {
  let stopped = false;
  const planted = (async () => {
    while (!stopped) {
      const entry = (await readdir(scratch).catch(() => [])).find((name) =>
        name.startsWith("native-fixture-"),
      );
      if (entry) {
        await link(foreign, join(scratch, entry, "foreign-link"));
        return join(scratch, entry);
      }
      await new Promise((resolveTick) => setImmediate(resolveTick));
    }
    return undefined;
  })();
  return {
    planted,
    stop: () => {
      stopped = true;
      return planted;
    },
  };
};

// Explicit controlled subject port, NOT a native-original admission or registry acceptance test.
// Actual HTTP sockets, kernel observations, files, strict backend and fixture children remain real.
async function host(
  stateRoot: string,
  config: {
    failBootstrap?: boolean;
    beforeBootstrapReturn?: () => Promise<void>;
    beforeOwnedClose?: (fixture: OwnedFixture) => Promise<void>;
    loseReply?: "claim" | "consume";
    bootstrapOrigin?: string;
    plantForeignLink?: string;
  } = {},
) {
  const proof: ProjectProcessProof = {
    privateSeat: true,
    fleet: "default",
    pane: "controlled",
    nativeOccupantId: "controlled",
    binding: { socketPath: "/controlled-test", session: "controlled" },
    processes: [{ pid: process.pid, startTime: "controlled" }],
    shell: { pid: process.pid, startTime: "controlled" },
  };
  let workspace = "/controlled-test-subject",
    launches = 0;
  let owned: OwnedFixture | undefined, plantedRoot: string | undefined;
  let replyLossOrigin: string | undefined;
  const verifier: FixtureOriginalVerifier = {
    capture: async (_proof, observation) => ({
      proof,
      controller: {
        pid: observation.owner.pid,
        start: nativeProcessStart(observation.owner.birth, observation.owner.kernelIdentity),
        threadId: "controlled",
        endpoint: "controlled",
      },
      projectId: "controlled",
      workspace,
      hire: { state: "assigned" },
      projectsRevision: "controlled",
      hostUid: process.getuid!(),
      originalObservation: observation,
    }),
    reprove: async (subject, observation) => {
      if (
        subject.workspace !== workspace ||
        observation.owner.pid !== process.pid ||
        !observation.ancestors.some((entry) => entry.pid === process.pid)
      )
        throw new Error("Controlled original-controller identity refused");
      return () => {};
    },
  };
  const bootstrap = await createFixtureBootstrap(repoRoot, join(stateRoot, "scratch"));
  const admission = new NativeFixtureAdmissions({
    stateRoot,
    processHelper: fleetProcessHelper(repoRoot),
    verifier,
    bootstrap: async (origin, expiresAt) => {
      launches++;
      if (config.failBootstrap) throw new Error("Controlled lost bootstrap reply");
      const planting = config.plantForeignLink
        ? plantForeignLink(join(stateRoot, "scratch"), config.plantForeignLink)
        : undefined;
      let launched: OwnedFixture;
      try {
        launched = await bootstrap(config.bootstrapOrigin ?? replyLossOrigin ?? origin, expiresAt);
      } finally {
        plantedRoot = await planting?.stop();
      }
      owned = config.beforeOwnedClose
        ? {
            ...launched,
            close: async () => {
              await config.beforeOwnedClose!(launched);
              await launched.close();
            },
          }
        : launched;
      await config.beforeBootstrapReturn?.();
      return owned;
    },
  });
  // A real owned HTTP callback listener drops only the selected acknowledgement after
  // the real controller has persisted its transition. Controlled port, not native acceptance.
  const replyLossListener = config.loseReply
    ? serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: async (request, env) => {
          const input = await request.clone().json();
          const response = await admission.handleCallback(request, env.incoming.socket);
          if (response.ok && input.action === config.loseReply) return new Response(null, { status: 503 });
          return response;
        },
      })
    : undefined;
  if (replyLossListener) replyLossOrigin = await address(replyLossListener);
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, env) => admission.handleOriginal(request, proof, env.incoming.socket, () => true),
  });
  const origin = await address(server);
  const request = async (suffix = "", body?: unknown) =>
    fetch(`${origin}/v1/fleet/seats/controlled/fixture-admissions${suffix}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    admission,
    request,
    get owned() {
      return owned;
    },
    get launches() {
      return launches;
    },
    get plantedRoot() {
      return plantedRoot;
    },
    changeSubject: () => {
      workspace += "-changed";
    },
    close: async () => {
      try {
        await admission.close();
      } finally {
        await close(server);
        if (replyLossListener) await close(replyLossListener);
      }
    },
  };
}

it("retains pending/lost-issuance IDs outside fixture roots and refuses duplicate minting after host restart", async () => {
  const root = await privateRoot(),
    input = issue();
  let h = await host(root, { failBootstrap: true });
  try {
    expect((await h.request("", input)).status).toBe(403);
    expect(h.launches).toBe(1);
    const bytes = await readFile(join(root, "fixture-admission-requests/index.json"));
    expect(JSON.parse(bytes.toString()).records[0]).toMatchObject({
      ...input,
      state: "pending",
      uncertain: true,
    });
    await h.close();
    h = await host(root);
    const replay = await h.request("", input);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      state: "pending",
      priorHost: true,
      statusOnly: true,
      mayExecute: false,
      uncertain: true,
    });
    expect(h.launches).toBe(0);
    expect(await (await h.request(`/requests/${input.requestId}`)).json()).toMatchObject({
      state: "pending",
      priorHost: true,
    });
    expect((await h.request("", { ...input, receiptId: randomUUID() })).status).toBe(403);
    expect((await h.request("", { ...input, requestId: randomUUID() })).status).toBe(403);
    h.changeSubject();
    expect((await h.request("", input)).status).toBe(403);
    expect(await readFile(join(root, "fixture-admission-requests/index.json"))).toEqual(bytes);
  } finally {
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("same-UID bad original cannot write/squat receipts; one authenticated record retains consumed result and restart is status-only", async () => {
  const root = await privateRoot();
  let h = await host(root);
  try {
    expect(process.env.NODE_ENV).toBe("test"); // successful child startup enforces NODE_ENV absent
    const input = issue(),
      response = await h.request("", input);
    expect(response.status).toBe(201);
    const ticket = await response.json(),
      fixture = h.owned!;
    const read = {
      ticketId: ticket.ticketId,
      bindingHash: ticket.bindingHash,
      requestId: input.requestId,
      receiptId: input.receiptId,
      claimId: randomUUID(),
    };
    const path = join(fixture.descriptor.root, "fixture-receipts.json");
    const domain = join(fixture.descriptor.root, "builtin/tracker.json"),
      before = await readFile(domain);
    const send = (body: unknown) =>
      fetch(`${fixture.descriptor.origin}/v1/fixture/reads`, { method: "POST", body: JSON.stringify(body) });
    // Unknown ticket, then matching receipt from a different actual same-UID process.
    expect((await send({ ...read, ticketId: randomUUID() })).status).toBe(403);
    const attacker = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "const r=await fetch(process.argv[1],{method:'POST',body:process.argv[2]});process.stdout.write(String(r.status));",
        `${fixture.descriptor.origin}/v1/fixture/reads`,
        JSON.stringify(read),
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: {} },
    );
    let output = "";
    attacker.stdout.on("data", (chunk) => {
      output += chunk;
    });
    expect((await once(attacker, "exit"))[0]).toBe(0);
    expect(output).toBe("403");
    await absent(path);
    expect(await readFile(domain)).toEqual(before);
    expect((await send(read)).status).toBe(200);
    const receipt = await readFile(path),
      parsed = JSON.parse(receipt.toString());
    expect(Array.isArray(parsed)).toBe(false);
    expect(parsed).toMatchObject({ input: read, state: "settled" });
    expect(parsed.subjectObservation.owner.pid).toBe(process.pid);
    expect((await send(read)).status).toBe(409);
    expect((await send({ ...read, receiptId: randomUUID(), claimId: randomUUID() })).status).toBe(403);
    expect(await readFile(path)).toEqual(receipt);
    expect(await readFile(domain)).toEqual(before);
    const status = await fetch(`${fixture.descriptor.origin}/v1/fixture/reads/status`, {
      method: "POST",
      body: JSON.stringify(read),
    });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ state: "settled" });
    const originalRoot = fixture.descriptor.root;
    await h.close();
    await absent(originalRoot);
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    h = await host(root);
    expect(await (await h.request("", input)).json()).toMatchObject({
      state: "consumed",
      revoked: true,
      cleanup: "removed",
      priorHost: true,
      mayExecute: false,
    });
    expect((await h.request(`/${ticket.ticketId}/revoke`, {})).status).toBe(409);
    expect(h.launches).toBe(0);
  } finally {
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("an authenticated claim with failed consume retains exactly one uncertain receipt without another read", async () => {
  const root = await privateRoot(),
    h = await host(root);
  try {
    const input = issue(),
      ticket = await (await h.request("", input)).json(),
      fixture = h.owned!;
    // Change locked store between bootstrap and admitted read; claim succeeds, pure read refuses.
    const store = join(fixture.descriptor.root, "builtin/tracker.json");
    const bytes = await readFile(store);
    await writeFile(store, `${bytes.toString()}\n`);
    const read = {
      ticketId: ticket.ticketId,
      bindingHash: ticket.bindingHash,
      requestId: input.requestId,
      receiptId: input.receiptId,
      claimId: randomUUID(),
    };
    const send = (body: unknown) =>
      fetch(`${fixture.descriptor.origin}/v1/fixture/reads`, { method: "POST", body: JSON.stringify(body) });
    expect((await send(read)).status).toBe(403);
    const path = join(fixture.descriptor.root, "fixture-receipts.json"),
      receipt = await readFile(path);
    expect(JSON.parse(receipt.toString())).toMatchObject({ state: "uncertain", input: read });
    expect((await send(read)).status).toBe(409);
    expect((await send({ ...read, receiptId: randomUUID() })).status).toBe(403);
    expect(await readFile(path)).toEqual(receipt);
    expect(await (await h.request(`/requests/${input.requestId}`)).json()).toMatchObject({
      state: "claimed",
    });
  } finally {
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("revoke removes only its exited owned fixture including credentials and retains host status", async () => {
  const root = await privateRoot(),
    h = await host(root);
  try {
    const input = issue(),
      ticket = await (await h.request("", input)).json(),
      fixture = h.owned!;
    const response = await h.request(`/${ticket.ticketId}/revoke`, { requestId: randomUUID() });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revoked: true, cleanup: "removed" });
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    await absent(fixture.descriptor.root);
    expect(await readFile(join(root, "fixture-admission-requests/index.json"))).toBeTruthy();
  } finally {
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("natural expiry cleanup follows observed child exit; substituted root is refused and preserved", async () => {
  const root = await privateRoot();
  const bootstrap = await createFixtureBootstrap(repoRoot, root);
  let fixture: OwnedFixture | undefined;
  try {
    fixture = await bootstrap("http://127.0.0.1:19999", Date.now() + 1_500);
    await once(fixture.child, "exit");
    await fixture.close();
    await absent(fixture.descriptor.root);
    fixture = await bootstrap("http://127.0.0.1:19999", Date.now() + 60_000);
    const original = fixture.descriptor.root,
      moved = `${original}-preserved`;
    await rename(original, moved);
    await mkdir(original, { mode: 0o700 });
    await writeFile(join(original, "sentinel"), "not owned");
    await expect(fixture.close()).rejects.toThrow("root identity changed");
    expect(await readFile(join(original, "sentinel"), "utf8")).toBe("not owned");
    expect(await readFile(join(moved, "credentials.json"))).toBeTruthy();
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
  } finally {
    if (fixture) await fixture.close().catch(() => {});
    // Explicitly owned test-created replacement/moved roots only, after verified exit.
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("strict host index refuses absent/corrupt/alias/public files and never resets prior identity", async () => {
  const root = await privateRoot();
  try {
    new FixtureRequestIndex(root);
    const path = join(root, "fixture-admission-requests/index.json");
    await writeFile(path, "corrupt");
    expect(() => new FixtureRequestIndex(root)).toThrow();
    await rm(path);
    expect(() => new FixtureRequestIndex(root)).toThrow();
    const other = join(root, "other");
    await writeFile(other, '{"version":1,"records":[]}');
    await symlink(other, path);
    expect(() => new FixtureRequestIndex(root)).toThrow();
    await rm(path);
    await writeFile(path, '{"version":1,"records":[]}', { mode: 0o644 });
    expect(() => new FixtureRequestIndex(root)).toThrow();
    await chmod(path, 0o600);
    const index = new FixtureRequestIndex(root),
      record = {
        ...issue(),
        assurance: "host-seat/v1" as const,
        issuer: randomUUID(),
        subjectHash: "a".repeat(64),
        expiresAt: Date.now() + 60_000,
        state: "pending" as const,
        uncertain: true,
        revoked: false,
        expired: false,
      };
    index.reserve(record);
    const before = await readFile(path);
    expect(() => index.reserve({ ...record, subjectHash: "b".repeat(64) })).toThrow("identity mismatch");
    expect(() => index.update(record.requestId, randomUUID(), { state: "issued" })).toThrow("status-only");
    await mkdir(join(root, "fixture-admission-requests/writer.lock"), { mode: 0o700 });
    expect(new FixtureRequestIndex(root).find(record.requestId)).toMatchObject(record);
    expect(() => index.reserve({ ...record, requestId: randomUUID(), receiptId: randomUUID() })).toThrow();
    expect(await readFile(path)).toEqual(before);
  } finally {
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("host deadline expires authority and removes only the exited owned root while retaining index status", async () => {
  const root = await privateRoot(),
    h = await host(root);
  try {
    const input = issue(),
      response = await h.request("", input);
    expect(response.status).toBe(201);
    const fixture = h.owned!;
    if (fixture.child.exitCode === null && fixture.child.signalCode === null)
      await once(fixture.child, "exit");
    await expect
      .poll(async () => {
        try {
          await lstat(fixture.descriptor.root);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return true;
        }
      })
      .toBe(true);
    expect(await (await h.request(`/requests/${input.requestId}`)).json()).toMatchObject({
      expired: true,
      revoked: false,
      cleanup: "removed",
      state: "issued",
      mayExecute: false,
    });
  } finally {
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
}, 70_000);

it("host close drains an in-flight owned bootstrap before returning and retains its uncertain ID", async () => {
  const root = await privateRoot();
  let ready!: () => void, release!: () => void;
  const prepared = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = await host(root, {
    beforeBootstrapReturn: async () => {
      ready();
      await released;
    },
  });
  try {
    const input = issue(),
      response = h.request("", input);
    await prepared;
    const fixture = h.owned!;
    const closed = h.admission.close();
    release();
    expect((await response).status).toBe(403);
    await closed;
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    await absent(fixture.descriptor.root);
    expect(new FixtureRequestIndex(root).find(input.requestId)).toMatchObject({
      state: "pending",
      uncertain: true,
    });
  } finally {
    release();
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

for (const lost of ["claim", "consume"] as const)
  it(`lost ${lost} acknowledgement preserves terminal uncertainty without remint/re-read`, async () => {
    const root = await privateRoot(),
      h = await host(root, { loseReply: lost });
    try {
      const input = issue(),
        issued = await h.request("", input);
      expect(issued.status).toBe(201);
      const ticket = await issued.json(),
        fixture = h.owned!;
      const read = {
        ticketId: ticket.ticketId,
        bindingHash: ticket.bindingHash,
        requestId: input.requestId,
        receiptId: input.receiptId,
        claimId: randomUUID(),
      };
      const file = join(fixture.descriptor.root, "builtin/tracker.json"),
        before = await readFile(file);
      const send = () =>
        fetch(`${fixture.descriptor.origin}/v1/fixture/reads`, {
          method: "POST",
          body: JSON.stringify(read),
        });
      expect((await send()).status).toBe(403);
      const receipt = join(fixture.descriptor.root, "fixture-receipts.json");
      if (lost === "claim") await absent(receipt);
      else
        expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
          state: "uncertain",
          input: read,
        });
      expect((await send()).status).toBe(lost === "claim" ? 403 : 409);
      expect(await readFile(file)).toEqual(before);
      expect(await (await h.request("", input)).json()).toMatchObject({
        state: lost === "claim" ? "claimed" : "consumed",
        uncertain: true,
        statusOnly: true,
        mayExecute: false,
      });
      expect(h.launches).toBe(1);
    } finally {
      await h.close();
      await rm(root, { recursive: true });
      await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
    }
  });

it("failed issuance finalization fences a second issuance and settled host close until owned cleanup drains", async () => {
  const root = await privateRoot();
  let closeStarted!: () => void, release!: () => void;
  const closingStarted = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstFixtureId: string | undefined;
  let first = true;
  const h = await host(root, {
    beforeBootstrapReturn: async () => {
      if (first) {
        first = false;
        h.changeSubject();
      }
    },
    beforeOwnedClose: async (fixture) => {
      firstFixtureId ??= fixture.descriptor.fixtureId;
      if (fixture.descriptor.fixtureId === firstFixtureId) {
        closeStarted();
        await released;
      }
    },
  });
  const original = issue(),
    second = issue();
  let response: Promise<Response> | undefined, closing: Promise<void> | undefined;
  try {
    response = h.request("", original);
    await closingStarted;
    const fixture = h.owned!;
    const secondResponse = await h.request("", second);
    closing = h.admission.close();
    const escaped = await Promise.race([
      closing.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    const aliveWhileHeld = fixture.child.exitCode === null && fixture.child.signalCode === null;
    await lstat(fixture.descriptor.root);
    await appendFile(
      auditPath,
      `${JSON.stringify({ event: "finalization-observed", root, originalRequestId: original.requestId, secondRequestId: second.requestId, secondStatus: secondResponse.status, launches: h.launches, closeEscapedWhileHeld: escaped, ownedChildAliveWhileHeld: aliveWhileHeld })}\n`,
    );
    // Always release/drain even against the pre-fix implementation before asserting.
    release();
    expect((await response).status).toBe(403);
    await closing;
    expect(secondResponse.status).toBe(409);
    expect(await secondResponse.json()).toMatchObject({ error: "issuance_uncertain" });
    expect(h.launches).toBe(1);
    expect(escaped).toBe(false);
    expect(aliveWhileHeld).toBe(true);
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    await absent(fixture.descriptor.root);
    const index = new FixtureRequestIndex(root);
    expect(index.find(original.requestId)).toMatchObject({
      state: "pending",
      uncertain: true,
      cleanup: "removed",
    });
    expect(index.find(second.requestId)).toBeUndefined();
  } finally {
    release();
    await response;
    await closing;
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("first-use private index reopens with immutable request identity and real lock state intact", async () => {
  const root = await privateRoot();
  try {
    const index = new FixtureRequestIndex(root);
    const input = {
      ...issue(),
      assurance: "host-seat/v1" as const,
      issuer: randomUUID(),
      subjectHash: "c".repeat(64),
      expiresAt: Date.now() + 60_000,
      state: "pending" as const,
      uncertain: true,
      revoked: false,
      expired: false,
    };
    index.reserve(input);
    const before = await readFile(join(root, "fixture-admission-requests/index.json"));
    const reopened = new FixtureRequestIndex(root);
    expect(reopened.find(input.requestId)).toEqual(input);
    expect(reopened.reserve({ ...input, issuer: randomUUID() })).toEqual(input);
    expect(await readFile(join(root, "fixture-admission-requests/index.json"))).toEqual(before);
    expect((await lstat(join(root, "fixture-admission-requests"))).mode & 0o077).toBe(0);
    await absent(join(root, "fixture-admission-requests/writer.lock"));
  } finally {
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("an existing 0755 state root admits fixtures; only the index directory must be private", async () => {
  const root = await privateRoot();
  await chmod(root, 0o755);
  try {
    const h = await host(root);
    try {
      const response = await h.request("", issue());
      expect(response.status).toBe(201);
      expect((await lstat(join(root, "fixture-admission-requests"))).mode & 0o077).toBe(0);
    } finally {
      await h.close();
    }
  } finally {
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("an unusable index refuses fixture admission with its reason instead of failing host construction", async () => {
  const root = await privateRoot();
  try {
    new FixtureRequestIndex(root);
    const path = join(root, "fixture-admission-requests/index.json");
    await writeFile(path, "corrupt");
    const corrupt = await host(root);
    try {
      const response = await corrupt.request("", issue());
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "fixture_index_unavailable" });
      expect(corrupt.launches).toBe(0);
      expect(await readFile(path, "utf8")).toBe("corrupt");
    } finally {
      await corrupt.close();
    }
    await rm(join(root, "fixture-admission-requests"), { recursive: true });
    await chmod(root, 0o770);
    const shared = await host(root);
    try {
      expect(await (await shared.request("", issue())).json()).toMatchObject({
        error: "fixture_index_unavailable",
      });
      await absent(join(root, "fixture-admission-requests"));
    } finally {
      await shared.close();
    }
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("an interrupted first index write is recovered on the next construction; unknown staging is preserved", async () => {
  const root = await privateRoot(),
    other = await privateRoot();
  try {
    const staging = join(root, "fixture-admission-requests.init");
    await mkdir(staging, { mode: 0o700 });
    await writeFile(join(staging, `index.json.${randomUUID()}.tmp`), '{"vers', { mode: 0o600 });
    new FixtureRequestIndex(root);
    expect(JSON.parse(await readFile(join(root, "fixture-admission-requests/index.json"), "utf8"))).toEqual({
      version: 1,
      records: [],
    });
    await absent(staging);
    const unknown = join(other, "fixture-admission-requests.init");
    await mkdir(unknown, { mode: 0o700 });
    await writeFile(join(unknown, "unexpected"), "", { mode: 0o600 });
    expect(() => new FixtureRequestIndex(other)).toThrow();
    await lstat(join(unknown, "unexpected"));
    await absent(join(other, "fixture-admission-requests"));
    // A staged index holding any record is prior state, never an interrupted first write.
    await rm(join(unknown, "unexpected"));
    const recorded = JSON.stringify({
      version: 1,
      records: [
        {
          ...issue(),
          issuer: randomUUID(),
          subjectHash: "d".repeat(64),
          expiresAt: Date.now() + 60_000,
          state: "pending",
          uncertain: true,
          revoked: false,
          expired: false,
        },
      ],
    });
    await writeFile(join(unknown, "index.json"), recorded, { mode: 0o600 });
    expect(() => new FixtureRequestIndex(other)).toThrow();
    expect(await readFile(join(unknown, "index.json"), "utf8")).toBe(recorded);
    await absent(join(other, "fixture-admission-requests"));
  } finally {
    for (const owned of [root, other]) {
      await rm(owned, { recursive: true });
      await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root: owned })}\n`);
    }
  }
});

it("revoke cleanup holds the issuance fence until its owned child is gone", async () => {
  const root = await privateRoot();
  let closeStarted!: () => void, release!: () => void;
  const closingStarted = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let firstFixtureId: string | undefined;
  const h = await host(root, {
    beforeOwnedClose: async (fixture) => {
      firstFixtureId ??= fixture.descriptor.fixtureId;
      if (fixture.descriptor.fixtureId === firstFixtureId) {
        closeStarted();
        await released;
      }
    },
  });
  let revoking: Promise<Response> | undefined;
  try {
    const ticket = await (await h.request("", issue())).json(),
      fixture = h.owned!;
    revoking = h.request(`/${ticket.ticketId}/revoke`, { requestId: randomUUID() });
    await closingStarted;
    const during = await h.request("", issue());
    const aliveWhileHeld = fixture.child.exitCode === null && fixture.child.signalCode === null;
    const launchesWhileHeld = h.launches;
    await appendFile(
      auditPath,
      `${JSON.stringify({ event: "revoke-fence-observed", root, duringStatus: during.status, launches: launchesWhileHeld, ownedChildAliveWhileHeld: aliveWhileHeld })}\n`,
    );
    // Always release/drain even against the pre-fix implementation before asserting.
    release();
    expect((await revoking).status).toBe(200);
    expect(during.status).toBe(409);
    expect(await during.json()).toMatchObject({ error: "fixture_cleanup_pending" });
    expect(launchesWhileHeld).toBe(1);
    expect(aliveWhileHeld).toBe(true);
    await absent(fixture.descriptor.root);
    expect((await h.request("", issue())).status).toBe(201);
    expect(h.launches).toBe(2);
  } finally {
    release();
    await revoking;
    await h.close();
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("refused revoke cleanup keeps the issuance fence, preserves its root and fails host close", async () => {
  const root = await privateRoot(),
    foreign = join(root, "foreign");
  await writeFile(foreign, "", { mode: 0o600 });
  const h = await host(root);
  try {
    const input = issue(),
      ticket = await (await h.request("", input)).json(),
      fixture = h.owned!;
    await link(foreign, join(fixture.descriptor.root, "foreign-link"));
    expect((await h.request(`/${ticket.ticketId}/revoke`, { requestId: randomUUID() })).status).toBe(403);
    expect(fixture.child.exitCode !== null || fixture.child.signalCode !== null).toBe(true);
    await lstat(fixture.descriptor.root);
    const after = await h.request("", issue());
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ error: "fixture_cleanup_pending" });
    expect(h.launches).toBe(1);
    await expect(h.admission.close()).rejects.toThrow();
    expect(new FixtureRequestIndex(root).find(input.requestId)).toMatchObject({
      revoked: true,
      cleanup: "refused",
      uncertain: true,
    });
  } finally {
    await h.close().catch(() => {});
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});

it("failed bootstrap whose own cleanup refuses keeps the issuance fence and fails host close", async () => {
  const root = await privateRoot(),
    foreign = join(root, "foreign");
  await writeFile(foreign, "", { mode: 0o600 });
  // The real worker refuses this callback origin and exits; the planted link makes its root unprovable.
  const h = await host(root, { bootstrapOrigin: "http://localhost:1", plantForeignLink: foreign });
  try {
    const input = issue();
    expect((await h.request("", input)).status).toBe(403);
    expect(h.plantedRoot).toBeDefined();
    await lstat(join(h.plantedRoot!, "foreign-link"));
    const after = await h.request("", issue());
    expect(after.status).toBe(409);
    expect(await after.json()).toMatchObject({ error: "issuance_uncertain" });
    expect(h.launches).toBe(1);
    await expect(h.admission.close()).rejects.toThrow("cleanup unresolved");
    expect(new FixtureRequestIndex(root).find(input.requestId)).toMatchObject({
      state: "pending",
      uncertain: true,
      cleanup: "refused",
    });
  } finally {
    await h.close().catch(() => {});
    await rm(root, { recursive: true });
    await appendFile(auditPath, `${JSON.stringify({ event: "test-root-removed", root })}\n`);
  }
});
