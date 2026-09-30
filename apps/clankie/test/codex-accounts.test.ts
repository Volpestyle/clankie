import { readHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createAccountRoutes } from "../src/account-routes.ts";
import { runAccountsCommand } from "../../tui/src/command/accounts.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("CLI and owner-authorized API register the same path-only accounts without reading auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-codex-registry-"));
  roots.push(root);
  const home = join(root, "second");
  await mkdir(home);
  await writeFile(join(home, "auth.json"), "deliberately invalid credential fixture");
  vi.stubEnv("CODEX_HOME", join(root, "default"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const app = createAccountRoutes(
    undefined,
    async (request) => (request.headers.get("authorization") === "owner" ? true : "forbidden"),
    settings,
  );
  expect((await app.request("/v1/accounts/codex")).status).toBe(403);
  const send = (body: unknown) =>
    app.request("/v1/accounts/codex", {
      method: "POST",
      headers: { authorization: "owner", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await send({ op: "add", home, label: "second", credentials: "not allowed" })).status).toBe(400);
  expect((await send({ op: "add", home, label: "second" })).status).toBe(200);
  expect(await runAccountsCommand(["codex", "list"], { settings })).toMatchObject({
    accounts: [{ label: "default" }, { label: "second", authPresent: true, headroom: null }],
  });
  expect((await send({ op: "add", home, label: "duplicate" })).status).toBe(400);
  await runAccountsCommand(["codex", "remove", "second"], { settings });
  expect((await settings.load()).codexAccounts).toEqual([]);
  await runAccountsCommand(["codex", "add", home, "--label", "restored"], { settings });
  const response = await app.request("/v1/accounts/codex", { headers: { authorization: "owner" } });
  expect(await response.json()).toMatchObject({ accounts: [{ label: "default" }, { label: "restored" }] });
});

test("session-id transcript lookup searches the registered account home", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-codex-transcript-"));
  roots.push(root);
  const home = join(root, "second");
  await mkdir(join(home, "sessions"), { recursive: true });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((value) => ({ ...value, codexAccounts: [{ label: "second", home }] }));
  vi.stubEnv("CODEX_HOME", join(root, "default"));
  vi.stubEnv("CLANKIE_SETTINGS_FILE", settings.path);
  const sessionId = "01a0740e-ea76-7aa2-8795-524c00368e71";
  const path = join(home, "sessions", `rollout-test-${sessionId}.jsonl`);
  await writeFile(
    path,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second account receipt" }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
      },
    }) + "\n",
  );
  expect(
    readHerdrSeatTranscript("codex", { source: "herdr:codex", kind: "id", value: sessionId })?.entries,
  ).toContainEqual(
    expect.objectContaining({ type: "message", role: "operator", text: "Second account receipt" }),
  );
});
