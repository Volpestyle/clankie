import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { EVIDENCE_STORAGE_SETTINGS_PATH } from "@clankie/protocol/owner-settings";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { AddressInfo } from "node:net";
import { afterAll, expect, it, vi } from "vitest";
import { createEvidenceStorageSettingsRoutes } from "../src/evidence-storage-settings-routes.ts";
import { EvidenceStore } from "../src/evidence-store.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { buildConsoleCommands } from "../../tui/src/commands.ts";
import { ClankieFaceShell } from "../../tui/src/shell/shell.ts";
import {
  InteractiveSelectPrompt,
  InteractiveTextPrompt,
} from "../../tui/src/face/clankie-interactive-flow.ts";
import {
  createCaptainRouteClient,
  type CaptainRouteFetcher,
} from "../../tui/src/session/operator-conversations.ts";

const cases: unknown[] = [];
const cleanup: unknown[] = [];
const clean = (value: string) => stripVTControlCharacters(value).replace(/\s+/gu, " ");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "evidence-tui-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, host: { ...current.host, autoUpdate: false } }));
  const broker = new FileCredentialStore(join(root, "broker.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: broker });
  const authenticate = createCredentialBackedOperatorAuthenticator({
    env: {},
    store: broker,
    identity: { operatorId: "private-tui-owner" },
  });
  const store = EvidenceStore.local(join(root, "evidence"));
  const app = new Hono();
  const requests: { method: string; body?: unknown }[] = [];
  app.use("*", async (context, next) => {
    requests.push({
      method: context.req.method,
      ...(context.req.method === "POST" ? { body: await context.req.raw.clone().json() } : {}),
    });
    await next();
  });
  app.route(
    "/",
    createEvidenceStorageSettingsRoutes(
      async (request) => {
        const actor = await authenticate(request);
        return actor ? true : "authentication_required";
      },
      settings,
      store,
    ),
  );
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let stopped = false;
  const stopServer = async () => {
    if (!stopped) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      stopped = true;
    }
  };
  const client = createCaptainRouteClient({ host, captainToken: credential.token });
  const attempts: string[] = [];
  const ownerFetcher: CaptainRouteFetcher = {
    fetch: (path, init) => {
      attempts.push(init?.method ?? "GET");
      return client.fetch(path, init);
    },
  };
  const commands = buildConsoleCommands({ ownerFetcher });
  const shell = new ClankieFaceShell({
    cwd: root,
    env: { HOME: root, PATH: "", XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state") },
    commands,
    bannerFields: { title: "Private headless fixture" },
  });
  // Passthrough spies observe the real flow's output; no prompt/HTTP/schema/store implementation is replaced.
  const lines = vi.spyOn(shell.setupFlow, "renderLine");
  const results = vi.spyOn(shell, "insertCommandResult");
  const prompts: string[] = [];
  let running: Promise<void> | undefined;
  const entry = commands.find((command) => command.name === "evidence-storage")!;
  const start = () => {
    running = Promise.resolve(entry.run("", shell));
    return running;
  };
  const finish = (name: string) =>
    cases.push({
      name,
      fixture: "real headless prompt + production owner HTTP/auth/SQLite/local",
      prompts,
      requests,
      attempts,
      lines: lines.mock.calls,
      results: results.mock.calls,
    });
  return {
    root,
    settings,
    store,
    broker,
    host,
    commands,
    shell,
    entry,
    lines,
    results,
    prompts,
    requests,
    attempts,
    start,
    stopServer,
    finish,
    async close() {
      await stopServer();
      shell.setupFlow.handleSubmit("/cancel");
      await running;
      store.close();
      await rm(root, { recursive: true, force: true });
      let closed = false;
      try {
        await fetch(host + EVIDENCE_STORAGE_SETTINGS_PATH);
      } catch {
        closed = true;
      }
      expect(closed).toBe(true);
      expect(existsSync(root)).toBe(false);
      cleanup.push({
        host,
        root,
        portClosed: closed,
        privateRootRemoved: !existsSync(root),
        setupPromptEnded: !shell.setupFlow.hasActivePrompt(),
      });
      lines.mockRestore();
      results.mockRestore();
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function prompt(f: Pick<Fixture, "shell" | "prompts">, text: string) {
  let current!: InteractiveSelectPrompt | InteractiveTextPrompt;
  await vi.waitFor(() => {
    const focused = f.shell.tui.getFocusedComponent();
    expect(focused instanceof InteractiveSelectPrompt || focused instanceof InteractiveTextPrompt).toBe(true);
    expect(clean(focused!.render(180).join("\n")).toLowerCase()).toContain(text.toLowerCase());
    current = focused as InteractiveSelectPrompt | InteractiveTextPrompt;
  });
  f.prompts.push(stripVTControlCharacters(current.render(180).join("\n")));
  return current;
}
async function choose(f: Fixture, text: string) {
  const current = await prompt(f, "Evidence storage");
  current.handleInput("\x15");
  for (const char of text) current.handleInput(char);
  current.handleInput("\r");
}
async function type(f: Fixture, question: string, text: string) {
  const current = await prompt(f, question);
  current.handleInput("\x15");
  for (const char of text) current.handleInput(char);
  current.handleInput("\r");
}
async function leave(f: Fixture) {
  (await prompt(f, "Evidence storage")).handleInput("\x1b");
}
const writes = (f: Fixture) => f.requests.filter((request) => request.method === "POST");
const successful = (f: Fixture) => f.lines.mock.calls.filter(([, tone]) => tone === "success");

it("reaches /evidence-storage from the actual registry/help and saves a read revision without applying", async () => {
  const f = await fixture();
  try {
    expect(f.commands.filter((command) => command.name === "evidence-storage")).toHaveLength(1);
    await f.commands.find((command) => command.name === "help")!.run("", f.shell);
    expect(clean(String(f.results.mock.calls.at(-1)?.[1]))).toContain("/evidence-storage");
    const run = f.start();
    const initial = await prompt(f, "Saved: On this Mac");
    expect(clean(initial.render(180).join("\n"))).toContain("Active: On this Mac");
    expect(clean(initial.render(180).join("\n"))).toContain("Amazon S3");
    await choose(f, "Amazon S3");
    await type(f, "S3 bucket", "fixture-evidence");
    await type(f, "AWS region", "us-east-1");
    await type(f, "Object prefix (optional)", "tui-proof");
    await prompt(f, "Saved: Amazon S3");
    expect(writes(f)).toHaveLength(1);
    expect(writes(f)[0]!.body).toMatchObject({
      schemaVersion: 1,
      expectedRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
      configured: { backend: "s3", bucket: "fixture-evidence", region: "us-east-1", prefix: "tui-proof" },
    });
    expect(successful(f).map(([text]) => text)).toEqual(["Saved, takes effect after restart"]);
    expect((await f.settings.load()).evidence.backend).toBe("s3");
    expect((await f.settings.load()).host.autoUpdate).toBe(false);
    expect(f.store.storage.activeDestination).toEqual({ backend: "local" });
    await leave(f);
    await run;
    expect(f.shell.setupFlow.hasActivePrompt()).toBe(false);
    f.finish("reachable registry/help + configured/active + revision save/no apply");
  } finally {
    await f.close();
  }
});
it("can clear an existing optional S3 prefix explicitly without changing the active store", async () => {
  const f = await fixture();
  try {
    await f.settings.update((current) => ({
      ...current,
      evidence: { backend: "s3", bucket: "fixture-evidence", region: "us-east-1", prefix: "old-prefix" },
    }));
    const run = f.start();
    await choose(f, "Amazon S3");
    (await prompt(f, "S3 bucket")).handleInput("\r");
    (await prompt(f, "AWS region")).handleInput("\r");
    await type(f, "Object prefix (optional)", "");
    await prompt(f, "Saved: Amazon S3");
    expect(writes(f)).toHaveLength(1);
    expect((await f.settings.load()).evidence).toEqual({
      backend: "s3",
      bucket: "fixture-evidence",
      region: "us-east-1",
      prefix: "",
    });
    expect(f.store.storage.activeDestination).toEqual({ backend: "local" });
    await leave(f);
    await run;
    f.finish("explicit empty optional prefix/no apply");
  } finally {
    await f.close();
  }
});
it("cancels the owner menu without a write", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await leave(f);
    await run;
    expect(writes(f)).toHaveLength(0);
    expect(successful(f)).toHaveLength(0);
    f.finish("cancel menu/no write");
  } finally {
    await f.close();
  }
});
it.each([0, 1, 2])("cancels S3 field %s before any write", async (index) => {
  const f = await fixture();
  try {
    const run = f.start();
    await choose(f, "Amazon S3");
    const questions = ["S3 bucket", "AWS region", "Object prefix (optional)"];
    const values = ["fixture-evidence", "us-east-1"];
    for (let i = 0; i < index; i++) await type(f, questions[i]!, values[i]!);
    (await prompt(f, questions[index]!)).handleInput("\x1b");
    await leave(f);
    await run;
    expect(writes(f)).toHaveLength(0);
    expect(successful(f)).toHaveLength(0);
    f.finish(`cancel field ${index}/no write`);
  } finally {
    await f.close();
  }
});
it("rereads a real stale409 for explicit review without a second write", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await prompt(f, "Evidence storage");
    await f.settings.update((current) => ({
      ...current,
      evidence: { backend: "s3", bucket: "other-owner-choice", region: "us-east-1", prefix: "current" },
    }));
    await choose(f, "On this Mac");
    await prompt(f, "Saved: Amazon S3");
    expect(writes(f)).toHaveLength(1);
    expect(f.attempts.filter((method) => method === "GET").length).toBeGreaterThanOrEqual(2);
    expect(
      f.lines.mock.calls.some(
        ([text, tone]) => text.includes("Settings changed elsewhere") && tone === "error",
      ),
    ).toBe(true);
    expect(successful(f)).toHaveLength(0);
    expect((await f.settings.load()).evidence.backend).toBe("s3");
    await leave(f);
    await run;
    f.finish("real409/current reread/no second write");
  } finally {
    await f.close();
  }
});
it("shows invalid settings503 clearly and preserves the unknown file without success", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await prompt(f, "Evidence storage");
    const raw = JSON.stringify({
      ...JSON.parse(await readFile(f.settings.path, "utf8")),
      futureUnknown: true,
    });
    await writeFile(f.settings.path, raw);
    await choose(f, "On this Mac");
    await run;
    expect(writes(f)).toHaveLength(1);
    expect(await readFile(f.settings.path, "utf8")).toBe(raw);
    expect(successful(f)).toHaveLength(0);
    expect(
      f.lines.mock.calls.some(
        ([text, tone]) => text.includes("settings file needs fixing") && tone === "error",
      ),
    ).toBe(true);
    f.finish("real503 invalid/no mutation/no success");
  } finally {
    await f.close();
  }
});
it("surfaces real broker revocation without saving or success", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await prompt(f, "Evidence storage");
    const raw = await readFile(f.settings.path, "utf8");
    await rm(join(f.root, "broker.json"));
    await choose(f, "On this Mac");
    await run;
    expect(await readFile(f.settings.path, "utf8")).toBe(raw);
    expect(successful(f)).toHaveLength(0);
    expect(f.lines.mock.calls.some(([text]) => text.includes("Owner access is required"))).toBe(true);
    f.finish("real auth revocation/no success");
  } finally {
    await f.close();
  }
});
it("does not report success or retry after losing its private HTTP service", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await prompt(f, "Evidence storage");
    const raw = await readFile(f.settings.path, "utf8");
    await f.stopServer();
    await choose(f, "On this Mac");
    await run;
    expect(f.attempts.filter((method) => method === "POST")).toHaveLength(1);
    expect(writes(f)).toHaveLength(0);
    expect(await readFile(f.settings.path, "utf8")).toBe(raw);
    expect(successful(f)).toHaveLength(0);
    expect(f.lines.mock.calls.some(([text]) => text.includes("Could not confirm the change"))).toBe(true);
    f.finish("real transport failure/no retry/no success");
  } finally {
    await f.close();
  }
});
it("refuses invalid S3 input before an HTTP write", async () => {
  const f = await fixture();
  try {
    const run = f.start();
    await choose(f, "Amazon S3");
    await type(f, "S3 bucket", "fixture-evidence");
    await type(f, "AWS region", "us-east-1");
    await type(f, "Object prefix (optional)", "../outside");
    await prompt(f, "Evidence storage");
    expect(writes(f)).toHaveLength(0);
    expect(successful(f)).toHaveLength(0);
    expect(f.lines.mock.calls.some(([text]) => text.includes("valid S3 bucket"))).toBe(true);
    await leave(f);
    await run;
    f.finish("invalid field/schema/no HTTP write");
  } finally {
    await f.close();
  }
});
it("rejects an authored malformed owner response before prompting or writing (schema boundary only)", async () => {
  const calls: string[] = [];
  const commands = buildConsoleCommands({
    ownerFetcher: {
      async fetch(_path, init) {
        calls.push(init?.method ?? "GET");
        return Response.json({ schemaVersion: 99 });
      },
    },
  });
  const shell = new ClankieFaceShell({
    cwd: tmpdir(),
    env: { HOME: tmpdir(), PATH: "" },
    commands,
    bannerFields: { title: "Authored schema fixture" },
  });
  const result = vi.spyOn(shell, "insertCommandResult");
  await commands.find((command) => command.name === "evidence-storage")!.run("", shell);
  expect(calls).toEqual(["GET"]);
  expect(result.mock.calls.at(-1)?.[2]).toBe("error");
  expect(String(result.mock.calls.at(-1)?.[1])).toContain("Could not read evidence storage");
  expect(shell.setupFlow.hasActivePrompt()).toBe(false);
  cases.push({
    name: "authored malformed owner response/schema refusal",
    fixture: "authored response only, not real service proof",
    calls,
    result: result.mock.calls,
  });
  result.mockRestore();
});
afterAll(async () => {
  if (process.env.EVIDENCE_TUI_PROOF_OUTPUT)
    await writeFile(
      process.env.EVIDENCE_TUI_PROOF_OUTPUT,
      JSON.stringify(
        {
          outcome: cases.length === 12 && cleanup.length === 11 ? "passed" : "incomplete",
          expectedCases: 12,
          cases,
          cleanup,
          qualifications:
            "Real headless prompts + component owner HTTP/auth/SQLite/local; one explicitly authored malformed-response boundary. No terminal start/native UI/full startup/installed client/hosted/activation.",
        },
        null,
        2,
      ) + "\n",
    );
});
