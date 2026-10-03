import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { parseInboxRead, runLinearCommand } from "../src/command/linear.ts";
import { runHerdrCommand } from "../src/command/herdr.ts";
import { runWorkdirCommand } from "../src/command/workdir.ts";

async function tempStore(): Promise<SettingsStore> {
  const directory = await mkdtemp(join(tmpdir(), "clankie-herdr-cli-"));
  return new SettingsStore(join(directory, "settings.json"));
}

describe("clankie herdr", () => {
  it("reads the default binding and sets a named session", async () => {
    const settings = await tempStore();
    const status = await runHerdrCommand([], { settings });
    expect(status.herdr).toEqual({ runtime: "auto", session: "default" });
    expect(status.restart).toBe("clankie restart captain");

    const updated = await runHerdrCommand(["set", "--session", "clankies"], { settings });
    expect(updated.herdr).toEqual({ runtime: "external", session: "clankies" });
    expect((await settings.load()).herdr.session).toBe("clankies");
    const bundled = await runHerdrCommand(["set", "--runtime", "bundled"], { settings });
    expect(bundled.herdr).toEqual({ runtime: "bundled", session: "clankies" });
    expect((await runHerdrCommand(["disable"], { settings })).herdr.runtime).toBe("disabled");
    expect((await runHerdrCommand(["use", "clankies"], { settings })).herdr.runtime).toBe("external");
    await expect(runHerdrCommand(["set", "--runtime", "unknown"], { settings })).rejects.toThrow("Usage:");
  });

  it("clears the saved socket for explicit reselection without losing it on an external-mode no-op", async () => {
    const settings = await tempStore();
    await settings.update((current) => ({
      ...current,
      herdr: { runtime: "external", session: "chosen", socketPath: "/tmp/chosen.sock" },
    }));
    expect((await runHerdrCommand(["set", "--runtime", "external"], { settings })).herdr.socketPath).toBe(
      "/tmp/chosen.sock",
    );
    expect((await runHerdrCommand(["set", "--runtime", "auto"], { settings })).herdr).toEqual({
      runtime: "auto",
      session: "default",
    });
    expect((await runHerdrCommand(["set", "--session", "next"], { settings })).herdr).toEqual({
      runtime: "external",
      session: "next",
    });
  });

  it("rejects a name the schema refuses and bad argument shapes", async () => {
    const settings = await tempStore();
    await expect(runHerdrCommand(["set", "--session", "no spaces"], { settings })).rejects.toThrow();
    await expect(runHerdrCommand(["set"], { settings })).rejects.toThrow("Usage: clankie herdr");
  });
});

describe("clankie workdir", () => {
  it("defaults to the home directory and round-trips set/clear", async () => {
    const settings = await tempStore();
    const status = await runWorkdirCommand([], { settings });
    expect(status.workingDirectory).toBeNull();
    expect(status.effective).toBe(homedir());

    const set = await runWorkdirCommand(["set", "~/dev"], { settings });
    expect(set.workingDirectory).toBe(join(homedir(), "dev"));
    expect(set.effective).toBe(join(homedir(), "dev"));
    expect((await settings.load()).captain.workingDirectory).toBe(join(homedir(), "dev"));

    const cleared = await runWorkdirCommand(["clear"], { settings });
    expect(cleared.workingDirectory).toBeNull();
    expect(cleared.effective).toBe(homedir());
  });

  it("rejects bad argument shapes", async () => {
    const settings = await tempStore();
    await expect(runWorkdirCommand(["set"], { settings })).rejects.toThrow("Usage: clankie workdir");
    await expect(runWorkdirCommand(["wipe"], { settings })).rejects.toThrow("Usage: clankie workdir");
  });
});

describe("clankie linear", () => {
  it("reads legacy bindings and scoped inboxes without sending retired mutations", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture");
      calls.push({
        path: new URL(url).pathname + new URL(url).search,
        method: init.method!,
        body: init.body ? JSON.parse(init.body as string) : undefined,
      });
      return Response.json({ ok: true });
    });
    const options = { env: { CLANKIE_OPERATOR_TOKEN: "fixture" } };
    try {
      await runLinearCommand(["work", "list"], options);
      await runLinearCommand(["inbox", "read", "--conversation", "project"], options);
      await runLinearCommand(["inbox", "ack", "000000000042", "--conversation", "project"], options);
      await expect(
        runLinearCommand(["work", "bind", "org", "issue", "project", "--from", "previous"], options),
      ).rejects.toThrow("bindings are retired");
      await expect(runLinearCommand(["work", "unbind", "org", "issue", "project"], options)).rejects.toThrow(
        "bindings are retired",
      );
      expect(calls).toEqual([
        { path: "/v1/linear/work", method: "GET", body: undefined },
        { path: "/v1/linear/inbox?conversationId=project", method: "GET", body: undefined },
        {
          path: "/v1/linear/inbox",
          method: "POST",
          body: { ackCursor: "000000000042", conversationId: "project" },
        },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("defaults off, persists live follow toggles, and rejects invalid commands", async () => {
    const settings = await tempStore();
    const credentials = { get: async () => ({ type: "api" as const, key: "test-secret" }) };
    const options = { settings, credentials };
    expect(await runLinearCommand([], options)).toMatchObject({
      following: false,
      conversationId: "linear-inbox",
      wakeConversationId: "global-default",
    });
    expect(await runLinearCommand(["follow", "on"], options)).toMatchObject({
      ok: false,
      error: "linear_webhook_required",
      missingWebhook: ["url"],
    });
    expect((await settings.load()).linearWebhook.following).toBe(false);
    await runLinearCommand(
      ["webhook", "set", "--url", "https://hooks.example.test/v1/hooks/linear"],
      options,
    );
    expect(await runLinearCommand(["follow", "on"], options)).toMatchObject({
      following: true,
      active: true,
    });
    expect((await settings.load()).linearWebhook.url).toBe("https://hooks.example.test/v1/hooks/linear");
    expect(
      await runLinearCommand(["status"], { settings, credentials: { get: async () => undefined } }),
    ).toMatchObject({
      following: true,
      active: false,
      reason: "linear_webhook_required",
      missingWebhook: ["secret"],
    });
    expect((await settings.load()).linearWebhook.following).toBe(true);
    expect(await runLinearCommand(["follow", "off"], options)).toMatchObject({ following: false });
    await runLinearCommand(["webhook", "clear"], options);
    expect(await runLinearCommand(["status"], options)).toMatchObject({
      webhookConfigured: false,
      missingWebhook: ["url"],
    });
    await expect(
      runLinearCommand(["webhook", "set", "--url", "file:///tmp/hook"], options),
    ).rejects.toThrow();
    await expect(runLinearCommand(["follow", "yes"], options)).rejects.toThrow("Usage:");
    await expect(runLinearCommand(["status", "on"], options)).rejects.toThrow("Usage:");
  });

  it("turns inbox read flags into the query the service expects", () => {
    expect(parseInboxRead([])).toBe("");
    expect(parseInboxRead(["--headlines", "--limit", "50", "--before", "000000000042"])).toBe(
      "?headlines=1&limit=50&before=000000000042",
    );
    expect(parseInboxRead(["--limit"])).toBeUndefined();
    expect(parseInboxRead(["--before", "42"])).toBeUndefined();
    expect(parseInboxRead(["--drain"])).toBeUndefined();
  });
});
