import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createRivalsClient } from "../src/rivals.ts";
import { rivalsTools } from "../src/captain/rivals-tools.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const ID = "a".repeat(32);
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function setup(fetchImpl: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "clankie-rivals-"));
  dirs.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const client = createRivalsClient({
    settings,
    credentials,
    fetchImpl,
    env: { CLANKIE_DISCORD_ACTIVE_BODY: "user_session" },
  });
  return { settings, credentials, client };
}

it("fails closed until configured and sends the broker bearer only to the configured origin", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      schemaVersion: 1,
      execution: "replay",
      session: null,
      modes: ["autonomous"],
      noteApplied: false,
    }),
  );
  const { settings, credentials, client } = await setup(fetchImpl);
  expect(await client.call({ action: "status" })).toMatchObject({ reason: "rivals_not_configured" });
  await settings.update((s) => ({ ...s, gameplay: { ...s.gameplay, rivalsUrl: "http://127.0.0.1:4330" } }));
  expect(await client.call({ action: "status" })).toMatchObject({ reason: "rivals_credential_missing" });
  await credentials.set("rivals-agent", { type: "api", key: "private-control" });
  expect(await client.call({ action: "status" })).toMatchObject({ outcome: "ok", execution: "replay" });
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
    redirect: "error",
    headers: { authorization: "Bearer private-control" },
  });
  await expect(
    settings.update((s) => ({ ...s, gameplay: { ...s.gameplay, rivalsUrl: "http://user:secret@host/" } })),
  ).rejects.toThrow();
});

it("returns image content to the captain and refuses malformed or oversized frames", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  const { settings, credentials, client } = await setup(fetchImpl);
  await settings.update((s) => ({ ...s, gameplay: { ...s.gameplay, rivalsUrl: "http://127.0.0.1:4330" } }));
  await credentials.set("rivals-agent", { type: "api", key: "private-control" });
  const result = await rivalsTools(client)[0]!.execute(
    "call",
    { action: "observe", sessionId: ID },
    undefined,
    undefined,
    {} as never,
  );
  expect(result.content).toContainEqual({
    type: "image",
    data: PNG.toString("base64"),
    mimeType: "image/png",
  });
  fetchImpl.mockResolvedValueOnce(new Response("not png", { headers: { "content-type": "image/png" } }));
  expect(await client.call({ action: "observe", sessionId: ID })).toMatchObject({ outcome: "refused" });
  fetchImpl.mockResolvedValueOnce(new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
  expect(await client.call({ action: "observe", sessionId: ID })).toMatchObject({ outcome: "refused" });
});

it("shares only the session's read-only frame URL and never reports requested publishing as live", async () => {
  const key = "k".repeat(43);
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({ watchPath: `/watch?key=${key}`, framePath: `/frame.png?key=${key}` }),
    )
    .mockResolvedValueOnce(Response.json({ ok: true }, { status: 202 }));
  const { settings, credentials, client } = await setup(fetchImpl);
  await settings.update((s) => ({ ...s, gameplay: { ...s.gameplay, rivalsUrl: "http://127.0.0.1:4330" } }));
  await credentials.set("rivals-agent", { type: "api", key: "private-control" });
  expect(await client.call({ action: "share", sessionId: ID, guildId: "1", channelId: "2" })).toMatchObject({
    outcome: "watch",
    publishing: "requested",
  });
  expect(fetchImpl.mock.calls[1]?.[1]?.body).toContain(`/frame.png?key=${key}`);
  expect(JSON.stringify(fetchImpl.mock.calls[1])).not.toContain("private-control");
  fetchImpl.mockResolvedValueOnce(
    Response.json({ watchPath: "//evil/watch", framePath: "//evil/frame.png" }),
  );
  expect(await client.call({ action: "share", sessionId: ID })).toMatchObject({ outcome: "refused" });
});

it("the HTTP route requires operator authority and validates before dispatch", async () => {
  const call = vi.fn().mockResolvedValue({ outcome: "ok" });
  const service = await createClankieApp({
    captain: createStubCaptain(),
    rivals: { call },
    authenticateOperator: async (req) =>
      req.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  try {
    const post = (body: unknown, auth = false) =>
      service.app.request("/v1/rivals", {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: "Bearer owner" } : {}) },
        body: JSON.stringify(body),
      });
    expect((await post({ action: "status" })).status).toBe(401);
    expect((await post({ action: "stop", sessionId: "wrong" }, true)).status).toBe(400);
    expect(call).not.toHaveBeenCalled();
    expect((await post({ action: "status" }, true)).status).toBe(200);
    expect(call).toHaveBeenCalledWith({ action: "status" });
  } finally {
    service.close();
  }
});
