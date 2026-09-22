import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  FileCredentialStore,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  mintOperatorToken,
} from "@clankie/credential-broker";
import { runRivalsCommand } from "../src/command/rivals.ts";

it("connects without storing a token in settings and dispatches the same typed commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rivals-command-"));
  try {
    const settings = new SettingsStore(join(dir, "settings.json"));
    const store = new FileCredentialStore(join(dir, "auth.json"));
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: mintOperatorToken() });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ outcome: "ok" }));
    const options = { settings, operatorCredentialStore: store, env: {}, fetchImpl };
    const connected = await runRivalsCommand(["connect", "http://127.0.0.1:4330", "--token-stdin"], {
      ...options,
      stdin: Readable.from(["k".repeat(43)]),
    });
    expect(await store.get("rivals-agent")).toEqual({ type: "api", key: "k".repeat(43) });
    expect(JSON.stringify(connected)).not.toContain("k".repeat(43));
    expect((await settings.load()).gameplay.rivalsUrl).toBe("http://127.0.0.1:4330");
    await runRivalsCommand(["start", "combat", "work on aiming"], options);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "start",
      objective: { mode: "combat", note: "work on aiming" },
      maxSeconds: 300,
    });
    await expect(runRivalsCommand(["start", "matchmaking"], options)).rejects.toThrow("Usage");
    await runRivalsCommand(["disconnect"], options);
    expect((await settings.load()).gameplay.rivalsUrl).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
