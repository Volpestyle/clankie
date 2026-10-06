import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { serve } from "@hono/node-server";
import { mintOperatorToken } from "@clankie/credential-broker";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { DeployHolds } from "../src/deploy-holds.ts";
import { RuntimeCanary } from "../src/runtime-canary.ts";
import { createRuntimeHealthSampler } from "../src/runtime-health-sample.ts";
import { createRuntimeUpdateRoutes } from "../src/runtime-update-routes.ts";
import { createRuntimeUpdater } from "../../tui/bin/runtime-updater.ts";
import { createReleaseUpdater } from "../../tui/bin/release-updater.ts";
import { writeRuntimeUpdate } from "../../tui/bin/runtime-update.ts";
import { writePrivateJson } from "../../tui/bin/update-files.ts";
import { runUpdateCli } from "../../tui/src/command/update-output.ts";
import { runUpdateCommand } from "../../tui/src/command/update.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// Real Git, updater, loopback HTTP, bearer authentication and durable holds.
// An existing unfinished transaction prevents all helper/deploy effects in this fixture.
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-update-ux-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    origin = join(root, "origin.git"),
    pin = join(root, ".clankie/pinned");
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, "init", "--bare", origin);
  git(root, "init", "-b", "main", source);
  git(source, "config", "user.name", "UX fixture");
  git(source, "config", "user.email", "fixture@example.test");
  await writeFile(join(source, "body"), "before");
  git(source, "add", "body");
  git(source, "commit", "-m", "Before update");
  const old = git(source, "rev-parse", "HEAD");
  git(source, "remote", "add", "origin", origin);
  git(source, "push", "origin", "main");
  await mkdir(join(root, ".clankie"), { mode: 0o700 });
  git(source, "worktree", "add", "--detach", pin, old);
  await writeFile(join(source, "body"), "after");
  git(source, "commit", "-am", "Explain held updates");
  git(source, "push", "origin", "main");
  const next = git(source, "rev-parse", "HEAD");
  const updater = createRuntimeUpdater({ repoRoot: pin, env: { HOME: root } });
  const updates = join(root, ".clankie/updates"),
    pending = randomUUID();
  await mkdir(join(updates, pending), { recursive: true, mode: 0o700 });
  await mkdir(join(updates, "active"), { mode: 0o700 });
  writePrivateJson(join(updates, "active/operation.json"), { id: pending });
  writePrivateJson(join(updates, "latest.json"), { id: pending });
  writeRuntimeUpdate(join(updates, pending), {
    id: pending,
    ref: "main",
    oldCommit: old,
    newCommit: next,
    phase: "installing",
    updatedAt: new Date().toISOString(),
  });
  const holds = new DeployHolds(join(root, "integration"));
  const ids: string[] = [];
  for (let n = 0; n < 7; n++) {
    const id = randomUUID();
    ids.push(id);
    await mkdir(join(updates, id), { mode: 0o700 });
    writeRuntimeUpdate(join(updates, id), {
      id,
      ref: "main",
      oldCommit: old,
      newCommit: next,
      phase: "healthy",
      updatedAt: new Date().toISOString(),
      canary: {
        state: "failed",
        error: "runtime-canary-cpu-budget-exceeded",
        previousHealthyCommit: old,
        cpuMeanPercent: 12 + (n * 2) / 3,
        healthP95Ms: 1.3,
        policy: { windowMs: 300000, sampleIntervalMs: 10000, cpuPercent: 10, healthLatencyMs: 250 },
      },
    });
    await holds.acquire({
      id,
      holder: "Clankie runtime canary",
      reason: `Runtime canary for ${next}; previous healthy ${old}`,
    });
  }
  const app = new Hono();
  const requests: string[] = [];
  app.use("*", async (c, next) => {
    requests.push(c.req.method);
    await next();
  });
  const token = mintOperatorToken();
  const authenticate = createBearerAuthenticator(token, { operatorId: "fixture-owner" });
  let granted = true;
  app.route(
    "/",
    createRuntimeUpdateRoutes({
      updater,
      holds,
      canary: new RuntimeCanary({
        updatesDirectory: updates,
        runtime: updater.runtime,
        holds,
        sample: createRuntimeHealthSampler({ healthUrl: "http://127.0.0.1:1/health" }),
      }),
      authorize: async (request) => {
        const identity = granted ? await authenticate(request) : undefined;
        if (!identity) return undefined;
        return {
          initiator: { kind: "cli", operatorId: identity.operatorId },
          current: () => granted,
          guard: async () => {
            if (!granted || !(await authenticate(request))) throw Error("operator_revoked");
          },
        };
      },
    }),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
  await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Fixture listener missing");
  const options = { host: `http://127.0.0.1:${address.port}`, env: { CLANKIE_OPERATOR_TOKEN: token } };
  const audit = async () =>
    JSON.parse(await readFile(join(root, "integration/holds.json"), "utf8")) as {
      events: Array<{ actor: string; reason: string; hold: { id: string } }>;
    };
  return {
    root,
    old,
    next,
    ids,
    holds,
    requests,
    options,
    audit,
    revoke: () => {
      granted = false;
    },
  };
}

it("explains all seven historical CPU holds, real target commits and canary policy, while piped and explicit JSON stay structured", async () => {
  const f = await fixture();
  let text = "";
  const stdout = {
    write: (value: string) => {
      text += value;
    },
  };
  expect(await runUpdateCli(["status"], { ...f.options, stdout, isTTY: true })).toBe(0);
  expect(text).toContain(`Live: ${f.old.slice(0, 8)}`);
  expect(text).toContain(`Target: main ${f.next.slice(0, 8)} (1 new commit)`);
  expect(text).toContain("Explain held updates");
  expect(text).toContain("7 historical CPU canary holds: CPU mean 12.0–16.0% vs 10.0% advisory; health p95 1.3 ms, fine");
  expect(text).toContain("--override-holds --reason");
  text = "";
  await runUpdateCli(["canary"], { ...f.options, stdout, isTTY: true });
  expect(text).toContain("Canary policy: 10% CPU advisory (one core; never holds), 250 ms health p95 budget; 300s window, every 10s");
  for (const args of [["status", "--json"], ["status"]]) {
    text = "";
    await runUpdateCli(args, { ...f.options, stdout, isTTY: args.includes("--json") });
    expect(JSON.parse(text).holds).toHaveLength(7);
  }
  expect(f.requests.every((method) => method === "GET")).toBe(true);
});

it("bulk override requires a reason, authenticates the actual owner and audits every hold without clearing it", async () => {
  const f = await fixture();
  for (const args of [["--override-holds"], ["--override-holds", "--reason", " "]])
    await expect(runUpdateCommand(args, f.options)).rejects.toThrow("requires --reason");
  expect(f.requests).toEqual([]);
  await expect(
    runUpdateCommand(["--override-holds", "--reason", "Reviewed CPU cause"], {
      ...f.options,
      env: { CLANKIE_OPERATOR_TOKEN: mintOperatorToken() },
    }),
  ).rejects.toThrow("(403)");
  expect((await f.audit()).events).toEqual([]);
  const result = await runUpdateCommand(["--override-holds", "--reason", "Reviewed CPU cause"], f.options);
  expect(result).toMatchObject({ accepted: false, latest: { phase: "installing" } });
  const events = (await f.audit()).events;
  expect(events.map((e) => e.hold.id)).toEqual(f.ids);
  expect(events.every((e) => e.actor === "fixture-owner" && e.reason === "Reviewed CPU cause")).toBe(true);
  expect(await f.holds.list()).toHaveLength(7);
  f.revoke();
  await expect(runUpdateCommand(["--override-holds", "--reason", "Reviewed"], f.options)).rejects.toThrow(
    "(403)",
  );
  expect((await f.audit()).events).toHaveLength(7);
});

it("interactive override confirms, requests a reason, and cannot authorize a newly acquired hold", async () => {
  const f = await fixture();
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let text = "";
  let added: Promise<unknown> | undefined;
  const extra = randomUUID();
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    if (chunk.toString().includes("[y/N]")) {
      added = f.holds.acquire({ id: extra, holder: "Owner review", reason: "New hold after preview" });
      void added.then(() => input.write("yes\n"));
    }
    if (chunk.toString().includes("Reason for each")) setImmediate(() => input.write("Reviewed idle CPU\n"));
  });
  expect(await runUpdateCli([], { ...f.options, stdout: output, input, isTTY: true })).toBe(1);
  expect(text).toContain("New hold after preview");
  expect((await f.audit()).events).toEqual([]);
  expect(f.requests.filter((method) => method === "POST")).toHaveLength(1);
  input.destroy();
  output.destroy();
});

it("legacy actor claims cannot replace the authenticated audit identity, and HTTP cannot omit the bulk reason", async () => {
  const f = await fixture();
  const refused = await fetch(`${f.options.host}/v1/runtime-update`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.options.env.CLANKIE_OPERATOR_TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ overrideHolds: true }),
  });
  expect(refused.status).toBe(400);
  expect((await f.audit()).events).toEqual([]);
  await runUpdateCommand(
    [
      ...f.ids.flatMap((id) => ["--override-hold", id]),
      "--actor",
      "untrusted-name",
      "--reason",
      "Reviewed legacy flags",
    ],
    f.options,
  );
  expect((await f.audit()).events.every((e) => e.actor === "fixture-owner")).toBe(true);
  expect((await f.audit()).events).toHaveLength(7);
});

it("interactive refusal and an empty reason leave holds unaudited and do not post an update", async () => {
  for (const answer of ["no", "yes"]) {
    const f = await fixture();
    const input = Object.assign(new PassThrough(), { isTTY: true }),
      output = new PassThrough();
    output.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("[y/N]")) setImmediate(() => input.write(`${answer}\n`));
      if (chunk.toString().includes("Reason for each")) setImmediate(() => input.write(" \n"));
    });
    expect(await runUpdateCli([], { ...f.options, stdout: output, input, isTTY: true })).toBe(1);
    expect((await f.audit()).events).toEqual([]);
    expect(f.requests).toEqual(["GET"]);
    input.destroy();
    output.destroy();
  }
});

it(
  "reports an already-current real release through HTTP and terminal as success without scheduling an update",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "clankie-update-current-release-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const install = join(root, "install"),
      releaseRoot = join(install, "releases", "v1.0.0"),
      commit = "a".repeat(40);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(join(releaseRoot, "VERSION"), "v1.0.0\n");
    await writeFile(
      join(releaseRoot, "release.json"),
      JSON.stringify({ schemaVersion: 1, version: "v1.0.0", revision: commit }),
    );
    await symlink(join("releases", "v1.0.0"), join(install, "current"));
    const app = new Hono();
    app.get("/api/releases/latest", (context) => context.json({ tag_name: "v1.0.0" }));
    app.get("/api/commits/v1.0.0", (context) => context.json({ sha: commit }));
    const responses: Array<{ method: string; status: number }> = [];
    app.use("/v1/runtime-update", async (context, next) => {
      await next();
      responses.push({ method: context.req.method, status: context.res.status });
    });
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }) as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    cleanup.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No release fixture listener");
    const host = `http://127.0.0.1:${address.port}`;
    const updater = createReleaseUpdater({
      releaseRoot,
      env: { HOME: root },
      source: { api: `${host}/api`, download: `${host}/download` },
    });
    const token = mintOperatorToken();
    const authenticate = createBearerAuthenticator(token, { operatorId: "release-owner" });
    app.route(
      "/",
      createRuntimeUpdateRoutes({
        updater,
        authorize: async (request) => {
          const identity = await authenticate(request);
          if (!identity) return undefined;
          return {
            initiator: { kind: "cli", operatorId: identity.operatorId },
            current: () => true,
            guard: async () => {
              if (!(await authenticate(request))) throw Error("operator_revoked");
            },
          };
        },
      }),
    );
    let text = "";
    const stdout = {
      write: (value: string) => {
        text += value;
      },
    };
    expect(await runUpdateCli([], { host, env: { CLANKIE_OPERATOR_TOKEN: token }, stdout, isTTY: true })).toBe(0);
    expect(text).toContain("Already running the requested official release. No update was scheduled.");
    expect(responses).toEqual([
      { method: "GET", status: 200 },
      { method: "POST", status: 200 },
    ]);
    expect(updater.status().pending).toBeUndefined();
    expect(updater.status().latest).toBeUndefined();
    expect(await readlink(join(install, "current"))).toBe(join("releases", "v1.0.0"));
  },
);
