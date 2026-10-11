import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import {
  KeychainCredentialStore,
  mintOperatorToken,
  resolveOperatorCredential,
} from "@clankie/credential-broker";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { inspectInstall } from "../../tui/src/install-doctor.ts";
import { formatDoctorSummary } from "../../tui/src/command/doctor.ts";
import { runIntegrationCommand } from "../../tui/src/command/integrate.ts";

const execute = promisify(execFile);
// Manual native boundary proof only; never operates on the owner's login keychain.
it.skipIf(process.platform !== "darwin" || process.env.CLANKIE_KEYCHAIN_TESTS !== "1")(
  "cached service reads, cross-process rotation, and locked scratch keychain fail without parallel dialogs",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "clankie-keychain-proof-"));
    const keychain = join(home, "scratch.keychain-db");
    const previousHome = process.env.HOME;
    const env = { ...process.env, HOME: home };
    const service = `clankie-proof-${randomUUID()}`;
    const token = mintOperatorToken();
    const replacement = mintOperatorToken();
    const commands: { command: string; phase: string; pid: number }[] = [];
    const phases: Record<string, unknown> = {};
    let server: ReturnType<typeof serve> | undefined;
    let created = false;
    const counts = () => {
      const starts = commands.filter((event) => event.phase === "start");
      const active = new Set<number>();
      let peak = 0;
      for (const event of commands) {
        if (event.phase === "start") active.add(event.pid);
        else active.delete(event.pid);
        peak = Math.max(peak, active.size);
      }
      return {
        nativeChecks: starts.filter((event) => event.command === "lock-check").length,
        securityReads: starts.filter((event) => event.command === "read").length,
        securityWrites: starts.filter((event) => event.command === "write").length,
        peakProcesses: peak,
        pids: starts.map((event) => event.pid),
      };
    };
    try {
      process.env.HOME = home;
      await execute("/usr/bin/security", ["create-keychain", "-p", "synthetic-proof-password", keychain], {
        env,
        timeout: 3000,
      });
      created = true;
      await execute(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-s",
          service,
          "-a",
          "clankie_operator",
          "-w",
          JSON.stringify({ type: "api", key: token }),
          keychain,
        ],
        { env, timeout: 3000 },
      );
      const store = new KeychainCredentialStore({
        service,
        keychain,
        observeCommand: (event) => commands.push(event),
      });
      const peers = Array.from(
        { length: 10 },
        () =>
          new KeychainCredentialStore({ service, keychain, observeCommand: (event) => commands.push(event) }),
      );
      const resolved = await Promise.all(
        peers.map((peer) => resolveOperatorCredential({ env: {}, store: peer })),
      );
      expect(resolved.every((credential) => credential?.token === token)).toBe(true);
      phases.coldConcurrent = counts();
      expect(counts().securityReads).toBe(1);
      expect(counts().peakProcesses).toBe(1);
      // All peers share one successful read, measured with actual spawned process PIDs.
      // No-op Google/OAuth-style checks also use the authoritative cached value.
      commands.length = 0;
      await store.update("clankie_operator", async (current) => current);
      await store.updateMany(["clankie_operator"], async (group) => group);
      phases.unchangedUpdates = counts();
      expect(counts().securityReads).toBe(0);
      // Clear to measure subsequent real service requests on the observed store.
      commands.length = 0;
      const { app } = await createClankieApp({
        captain: createStubCaptain(),
        credentialStoreHealth: () => store.health(),
        authenticateOperator: createCredentialBackedOperatorAuthenticator({
          env: {},
          store,
          identity: { operatorId: "scratch-owner", steerSourceLane: "tui" },
        }),
      });
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
      if (!server.listening) await new Promise<void>((resolve) => server!.once("listening", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No fixture listener");
      const url = `http://127.0.0.1:${address.port}`;
      let authenticatedRequests = 0;
      const read = (bearer: string) => {
        authenticatedRequests++;
        return fetch(`${url}/v1/devices`, { headers: { authorization: `Bearer ${bearer}` } });
      };
      const responses = await Promise.all(Array.from({ length: 20 }, () => read(token)));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      phases.cachedService = counts();
      expect(counts().securityReads).toBe(0);
      // A real second process writes through the broker; the running HTTP server must observe it.
      const source = fileURLToPath(
        new URL("../../../packages/credential-broker/src/credential-store.ts", import.meta.url),
      );
      const mutate = (account = "clankie_operator", remove = false) => {
        const child = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          import { readFileSync } from 'node:fs';
          const request = JSON.parse(readFileSync(0, 'utf8'));
          const { KeychainCredentialStore } = await import(request.source);
          const store = new KeychainCredentialStore({ service: request.service, keychain: request.keychain });
          if (request.remove) await store.delete(request.account);
          else await store.set(request.account, {type:'api', key:request.token});
          console.log('settled');
        `,
          ],
          {
            env,
            input: JSON.stringify({ source, service, keychain, token: replacement, account, remove }),
            encoding: "utf8",
            timeout: 15000,
          },
        );
        expect(child.status, child.stderr).toBe(0);
      };
      mutate();
      expect((await read(token)).status).toBe(401);
      expect((await read(replacement)).status).toBe(200);
      expect(counts().securityReads).toBe(1);
      phases.rotation = counts();
      commands.length = 0;
      mutate("unrelated-provider");
      expect((await read(replacement)).status).toBe(200);
      phases.unrelatedChange = counts();
      expect(counts().securityReads).toBe(0);
      await store.list(); // warm index so the failed mutation reaches the write boundary
      await execute("/usr/bin/security", ["lock-keychain", keychain], { env, timeout: 3000 });
      commands.length = 0;
      expect((await read(replacement)).status).toBe(200); // warm cached credentials still work
      expect(counts().nativeChecks).toBe(0);
      const notices: string[] = [];
      store.observeHealth((health) => {
        if (health.state !== "ready") notices.push(health.state);
      });
      const started = performance.now();
      await expect(store.set("clankie_operator", { type: "api", key: mintOperatorToken() })).rejects.toThrow(
        /keychain locked/i,
      );
      expect((await read(replacement)).status).toBe(200); // failed rotation preserves the unchanged bearer
      phases.failedLockedRotation = counts();
      expect(counts().securityWrites).toBe(0);
      const failures = await Promise.allSettled(
        Array.from({ length: 20 }, (_, n) => store.get(`cold-${n % 4}`)),
      );
      expect(
        failures.every(
          (result) => result.status === "rejected" && /keychain locked/i.test(String(result.reason)),
        ),
      ).toBe(true);
      const cliCommands: typeof commands = [];
      const cliStarted = performance.now();
      await expect(
        runIntegrationCommand(["status", randomUUID()], {
          env: {},
          operatorCredentialStore: new KeychainCredentialStore({
            service: `${service}-cold`,
            keychain,
            observeCommand: (event) => cliCommands.push(event),
          }),
        }),
      ).rejects.toThrow(/keychain locked/i);
      phases.cliLocked = {
        elapsedMs: Math.round(performance.now() - cliStarted),
        nativeChecks: cliCommands.filter((event) => event.phase === "start" && event.command === "lock-check")
          .length,
        securityReads: cliCommands.filter((event) => event.phase === "start" && event.command === "read")
          .length,
      };
      expect(cliCommands.filter((event) => event.phase === "start" && event.command === "read")).toHaveLength(
        0,
      );
      expect(performance.now() - started).toBeLessThan(3000);
      expect(notices).toEqual(["locked"]);
      const health = await (await fetch(`${url}/health`)).json();
      expect(health.credentialStoreHealth.state).toBe("locked");
      expect(health.credentialStoreHealth.message).toMatch(/keychain locked/i);
      phases.locked = {
        ...counts(),
        elapsedMs: Math.round(performance.now() - started),
        ownerStateChanges: notices.length,
      };
      expect(counts().nativeChecks).toBe(1);
      expect(counts().securityReads).toBe(0);
      expect(counts().peakProcesses).toBe(1);
      commands.length = 0;
      await Promise.allSettled(Array.from({ length: 20 }, () => store.get("cold-again")));
      const doctor = await inspectInstall({
        repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
        env: process.env,
        credentialStore: store,
        execFileImpl: async () => ({ stdout: "fixture tool", stderr: "" }),
        fetchImpl: async () => new Response("{}", { status: 503 }),
      });
      expect(doctor.credentialStoreHealth?.state).toBe("locked");
      expect(formatDoctorSummary(doctor)).toMatch(/keychain locked/i);
      phases.backoff = { ...counts(), doctorState: doctor.credentialStoreHealth?.state };
      expect(counts().nativeChecks).toBe(0);
      await execute("/usr/bin/security", ["unlock-keychain", "-p", "synthetic-proof-password", keychain], {
        env,
        timeout: 3000,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(store.health().retryAt!) - Date.now() + 50)),
      );
      expect(await store.get("cold-again")).toBeUndefined();
      expect(store.health().state).toBe("ready");
      phases.recovery = counts();
      expect(counts().securityReads).toBe(1);
      commands.length = 0;
      mutate("clankie_operator", true);
      expect((await read(replacement)).status).toBe(401);
      phases.revocation = counts();
      expect(counts().securityReads).toBe(1);
      if (process.env.KEYCHAIN_PROOF_OUTPUT)
        await writeFile(
          process.env.KEYCHAIN_PROOF_OUTPUT,
          JSON.stringify({ scratchOnly: true, authenticatedRequests, phases }, null, 2),
        );
    } finally {
      if (server)
        await new Promise<void>((resolve, reject) =>
          server!.close((error) => (error ? reject(error) : resolve())),
        );
      if (created) await execute("/usr/bin/security", ["delete-keychain", keychain], { env, timeout: 3000 });
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(home, { recursive: true, force: true });
    }
  },
  60000,
);
