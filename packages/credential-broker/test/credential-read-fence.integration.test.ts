import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { sharedCredentialStore } from "./fixtures/shared-credential-store.ts";

it.each(["file", "keychain"] as const)(
  "%s publication witnesses reject reconnect, disconnect, ABA and a held writer",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "credential-fence-"));
    vi.stubEnv("HOME", root);
    try {
      // Independent instances share real file/revision publication. The keychain
      // adapter uses the existing disk-backed security(1) fixture, never real secrets.
      const reader = sharedCredentialStore(kind, root);
      const writer = sharedCredentialStore(kind, root);
      const absent = reader.readFence("github");
      await writer.set("github", { type: "api", key: "account-a" });
      expect(() => absent.assertCurrent()).toThrow();
      const a = reader.readFence("github");
      expect(await reader.get("github")).toEqual({ type: "api", key: "account-a" });
      await writer.set("github", { type: "api", key: "account-b" });
      expect(() => a.assertCurrent()).toThrow();
      const b = reader.readFence("github");
      expect(await reader.get("github")).toEqual({ type: "api", key: "account-b" });
      b.assertCurrent();
      await writer.delete("github");
      expect(() => b.assertCurrent()).toThrow();
      const disconnected = reader.readFence("github");
      expect(await reader.get("github")).toBeUndefined();
      disconnected.assertCurrent();
      await writer.set("github", { type: "api", key: "account-a" });
      const aba = reader.readFence("github");
      await writer.set("github", { type: "api", key: "account-b" });
      await writer.set("github", { type: "api", key: "account-a" });
      expect(() => aba.assertCurrent()).toThrow();
      const pending = reader.readFence("github");
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((done) => {
        enter = done;
      });
      const gate = new Promise<void>((done) => {
        release = done;
      });
      const writing = writer.update("github", async (current) => {
        enter();
        await gate;
        return current;
      });
      try {
        await entered;
        expect(() => pending.assertCurrent()).toThrow("Credential change in progress");
      } finally {
        release();
        await writing;
      }
      reader.readFence("github").assertCurrent();
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
);
