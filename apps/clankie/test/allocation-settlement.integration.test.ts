import { serve } from "@hono/node-server";
import { FileCredentialStore, mintOperatorToken } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createClankieApp } from "../src/app.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { runHireReceiptCommand } from "../../tui/src/command/hire-receipt.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

// Opt-in owned native inventory, like project-hire-precondition. No live owner pane,
// credential or worker is used; CLI, loopback HTTP, broker and controller files are real.
it
  .skipIf(process.env.NATIVE_HIRE_ALLOCATION_FIXTURES !== "1")
  .each(["stable", "replace", "disconnect", "aba", "environment", "principal", "no-witness"] as const)(
  "allocation settlement retains final authority inputs (%s)",
  async (mode) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "allocation-settlement-")));
    const native = await isolatedHerdr(join(root, "native"));
    let captain: ReturnType<typeof createCaptain> | undefined;
    let service: Awaited<ReturnType<typeof createClankieApp>> | undefined;
    let server: ReturnType<typeof serve> | undefined;
    try {
      const firstToken = mintOperatorToken(),
        secondToken = mintOperatorToken();
      const credentials = new FileCredentialStore(join(root, "operator.json"));
      const writer = new FileCredentialStore(join(root, "operator.json"));
      await credentials.set("clankie_operator", { type: "api", key: firstToken });
      const env: NodeJS.ProcessEnv = mode === "environment" ? { CLANKIE_OPERATOR_TOKEN: firstToken } : {};
      const identity = { operatorId: "fixture-owner" };
      const authenticate = createCredentialBackedOperatorAuthenticator({ store: credentials, env, identity });
      let armed = false,
        inventories = 0,
        changed = false;
      const runner = createHerdrWatchRunner(undefined, undefined, undefined, {
        localReadBinding: async () => ({
          runtime: "external",
          socketPath: native.socketPath,
          session: "default",
        }),
      });
      const stateDir = join(root, "state");
      captain = createCaptain({ herdrAvailable: () => true } as CaptainDeps, {
        repoRoot: root,
        stateDir,
        settings: new SettingsStore(join(root, "settings.json")),
        nativeHerdrRunner: {
          ...runner,
          list: async (fleet) => {
            const inventory = await runner.list!(fleet);
            if (armed && ++inventories === 2 && mode !== "stable" && mode !== "no-witness") {
              if (mode === "disconnect") await writer.delete("clankie_operator");
              else if (mode === "environment") env.CLANKIE_OPERATOR_TOKEN = secondToken;
              else if (mode === "principal") identity.operatorId = "replacement-owner";
              else {
                await writer.set("clankie_operator", { type: "api", key: secondToken });
                if (mode === "aba") await writer.set("clankie_operator", { type: "api", key: firstToken });
              }
              changed = true;
            }
            return inventory;
          },
        },
      });
      service = await createClankieApp({
        captain,
        authenticateOperator: mode === "no-witness" ? async (request) => authenticate(request) : authenticate,
      });
      const host = await new Promise<string>((resolve) => {
        server = serve({ fetch: service!.app.fetch, hostname: "127.0.0.1", port: 0 }, (info) =>
          resolve(`http://127.0.0.1:${info.port}`),
        );
      });
      const ledgerPath = join(stateDir, "herdr-watches.json.project-hires.json");
      const ledger = new ProjectHires(ledgerPath);
      const policy = ProjectsSettingsSchema.parse({ projects: [{ id: "fixture", name: "Fixture" }] });
      const allocation = ledger.reserve(policy, "fixture", {
        schemaVersion: 1,
        harness: "codex",
        title: "Fixture",
        workingDirectory: join(root, "absent-worker"),
      });
      ledger.launch(allocation.id, policy);
      const before = await readFile(ledgerPath, "utf8");
      armed = true;
      let output = "";
      const exit = await runHireReceiptCommand(["settle", allocation.id, "release-allocation"], {
        host,
        env: { CLANKIE_CAPTAIN_TOKEN: firstToken },
        stdout: {
          write: (text) => {
            output += text;
          },
        },
      });
      const result = JSON.parse(output);
      expect(inventories).toBe(2);
      expect(changed).toBe(mode !== "stable" && mode !== "no-witness");
      if (mode === "stable") {
        expect({ exit, result }).toMatchObject({
          exit: 0,
          result: { state: "allocation-released", receiptId: allocation.id },
        });
        expect(ledger.recoveryCandidate(allocation.id)).toMatchObject({
          gone: true,
          operatorRelease: {
            censusSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          },
        });
      } else {
        expect({ exit, result }).toMatchObject({ exit: 1, result: { state: "refused" } });
        expect(ledger.recoveryCandidate(allocation.id)?.gone).toBe(false);
        expect(await readFile(ledgerPath, "utf8")).toBe(before);
      }
      expect((await native.cli("pane", "list")).result.panes).toHaveLength(2);
    } finally {
      if (server) {
        if ("closeAllConnections" in server) server.closeAllConnections();
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      service?.close();
      await captain?.close();
      await native.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
