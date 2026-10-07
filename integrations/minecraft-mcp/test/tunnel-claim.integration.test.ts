import { FileCredentialStore } from "@clankie/credential-broker";
import { MinecraftTunnelClaimStatusSchema } from "@clankie/protocol";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { MinecraftTunnel } from "../src/tunnel.ts";

// Real HTTP serialization and broker persistence; only the remote provider is a fixture.
for (const outcome of [
  "accepted",
  "rejected",
  "expired",
  "deadline",
  "closed",
  "retry",
  "broker-retry",
] as const) {
  test(`integration-owned claim: ${outcome}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "playit-claim-job-"));
    const broker = new FileCredentialStore(join(dir, "broker", "credentials.json"));
    if (outcome === "broker-retry") await writeFile(join(dir, "broker"), "blocked");
    const secret = "abcdef0123456789".repeat(4);
    const requests: { path: string; input: unknown }[] = [];
    let setups = 0;
    let exchanges = 0;
    let code: string | undefined;
    let now = Date.now();
    const provider = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ path: request.url!, input });
      code ??= input.code;
      let body: unknown;
      if (request.url === "/claim/setup") {
        setups++;
        body =
          setups === 1
            ? { status: "success", data: "WaitingForUserVisit" }
            : outcome === "expired"
              ? { status: "fail", data: "CodeExpired" }
              : outcome === "retry" && setups === 2
                ? { status: "error", data: "temporary outage" }
                : { status: "success", data: outcome === "rejected" ? "UserRejected" : "UserAccepted" };
      } else {
        exchanges++;
        body = { status: "success", data: { secret_key: secret } };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("fixture unavailable");
    const tunnel = new MinecraftTunnel({
      dataDir: dir,
      originPort: 25684,
      authReady: () => false,
      now: () => now,
      install: async () => "/unused/provisioned-playit",
      apiBase: `http://127.0.0.1:${address.port}`,
      credentials: {
        get: async () => null,
        set: async (key) => {
          try {
            await broker.set("clankie_minecraft_playit", { type: "api", key });
          } catch (error) {
            if (outcome === "broker-retry") await rm(join(dir, "broker"), { force: true });
            throw error;
          }
        },
      },
    });
    try {
      // Drive the owned poll clock while HTTP and broker persistence stay real.
      // Install it before the job schedules its first poll, so cancellation is
      // exercised by advancing a full cycle after each terminal outcome.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      expect((await tunnel.prepareClaim()).phase).toBe("preparing");
      await vi.waitFor(() => expect(setups).toBe(1));
      await vi.waitFor(() => expect(tunnel.claimStatus().phase).toBe("pending"));
      const pending = tunnel.claimStatus();
      expect(MinecraftTunnelClaimStatusSchema.parse(pending)).toEqual(pending);
      // Repeated client reads/completion cannot drive requests or duplicate exchange.
      await Promise.all(Array.from({ length: 10 }, () => tunnel.completeClaim()));
      await tunnel.prepareClaim();
      expect(setups).toBe(1);
      if (outcome === "closed") await tunnel.close();
      if (outcome === "deadline") {
        now += 10 * 60_000;
        await vi.advanceTimersByTimeAsync(3200);
      }
      const phase =
        outcome === "closed"
          ? "idle"
          : outcome === "expired" || outcome === "deadline"
            ? "expired"
            : outcome === "rejected"
              ? "rejected"
              : "claimed";
      // No completion calls after the simulated browser decision: the job owns polling.
      await vi.waitFor(
        async () => {
          await vi.advanceTimersByTimeAsync(3000);
          expect(tunnel.claimStatus().phase).toBe(phase);
        },
        { timeout: 8000 },
      );
      await vi.advanceTimersByTimeAsync(3200);
      const expectedSetups = outcome === "closed" || outcome === "deadline" ? 1 : outcome === "retry" ? 3 : 2;
      expect(setups).toBe(expectedSetups);
      for (const entry of requests) {
        expect(entry.input).toEqual(
          entry.path === "/claim/setup"
            ? { code, agent_type: "self-managed", version: "playit-cli 0.17.1" }
            : { code },
        );
      }
      expect(exchanges).toBe(phase === "claimed" ? 1 : 0);
      expect(await broker.get("clankie_minecraft_playit")).toEqual(
        phase === "claimed" ? { type: "api", key: secret } : undefined,
      );
      expect(JSON.stringify([pending, tunnel.claimStatus()])).not.toContain(secret);
    } finally {
      await tunnel.close();
      vi.useRealTimers();
      await new Promise<void>((resolve, reject) =>
        provider.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
}
