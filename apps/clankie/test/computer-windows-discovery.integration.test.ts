import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { describe, expect, it } from "vitest";
import { runBrowserCommand, type BrowserHarnessesResult } from "../../tui/src/command/browser.ts";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { renderComputerUseReach } from "../src/computer-use-harnesses.ts";
import { detectWindowsComputerUseHarnesses } from "../src/computer-windows-discovery.ts";

// Constructed replies of the read-only native PowerShell probe, never a fleet
// connection. The ready projection matches the retained 2026-10-04 discovery
// record (VUH-1620/windows-discovery.json); unavailable states are fixture cases,
// not claims about the owner's current PC. No native SDK or model is invoked.
const replies = [
  {
    name: "configured native desktop",
    state: { installed: true, signedIn: true, enabled: true, disabled: false, plugin: true },
    surfaces: ["desktop"],
    card: "pc/codex: Windows apps",
  },
  {
    name: "signed out",
    state: { installed: true, signedIn: false, enabled: true, disabled: false, plugin: true },
    surfaces: ["desktop"],
    card: "pc/codex: not signed in: the owner runs `codex login`",
  },
  {
    name: "plugin disabled by its owner",
    state: { installed: true, signedIn: true, enabled: true, disabled: true, plugin: true },
    surfaces: [],
    card: "pc/codex: Windows computer use is off",
  },
  {
    name: "native Windows plugin missing",
    state: { installed: true, signedIn: true, enabled: true, disabled: false, plugin: false },
    surfaces: [],
    card: "pc/codex: the native Windows computer-use plugin is not installed",
  },
  {
    name: "Codex uninstalled",
    state: { installed: false },
    surfaces: [],
    card: "",
  },
] as const;

describe("Windows discovery through owner HTTP, CLI and the machine-qualified reach card", () => {
  it.each(replies)("reports $name without starting a driver", async ({ state, surfaces, card }) => {
    const directory = await mkdtemp(join(tmpdir(), "clankie-windows-discovery-"));
    let probes = 0;
    let detected: Awaited<ReturnType<typeof detectWindowsComputerUseHarnesses>> = [];
    const service = await createClankieApp({
      captain: createStubCaptain(),
      authenticateOperator: createBearerAuthenticator("fixture-owner", { operatorId: "owner" }),
      computerUseHarnesses: {
        async refresh() {
          detected = await detectWindowsComputerUseHarnesses(async (command, timeoutMs) => {
            probes += 1;
            // Replay only. This callback never spawns PowerShell, SSH or a harness.
            expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -EncodedCommand /u);
            expect(timeoutMs).toBe(15_000);
            return JSON.stringify(state);
          }, "pc");
          return detected;
        },
      },
    });
    const server = serve({ fetch: service.app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing discovery fixture address");
    const host = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${host}/v1/browser/harnesses`)).status).toBe(401);
      expect(
        (await fetch(`${host}/v1/browser/harnesses`, { headers: { authorization: "Bearer model" } })).status,
      ).toBe(401);
      expect(probes).toBe(0);
      const result = (await runBrowserCommand(["harnesses"], {
        host,
        settings: new SettingsStore(join(directory, "settings.json")),
        env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      })) as BrowserHarnessesResult;
      expect(result).toMatchObject({ ok: true, schemaVersion: 1, detected: true, harnessDelegation: true });
      expect(result.harnesses).toEqual(detected);
      expect(probes).toBe(1);
      if (state.installed) {
        expect(result.harnesses).toEqual([
          {
            harness: "codex",
            signedIn: state.signedIn,
            surfaces,
            chromeNeedsHireFlag: false,
            platform: "win32",
            machineId: "pc",
            ...(detected[0]?.missing === undefined ? {} : { missing: detected[0].missing }),
          },
        ]);
        expect(renderComputerUseReach(detected)).toContain(card);
        expect(renderComputerUseReach(detected)).toContain("don't drive while they are using the machine");
        expect(renderComputerUseReach(detected)).toContain("sign-ins, codes, payments");
        if (state.signedIn && surfaces.length > 0) {
          expect(renderComputerUseReach(detected)).toContain("app grants and input still need live proof");
        }
      } else {
        expect(result.harnesses).toEqual([]);
        expect(renderComputerUseReach(detected)).toBe("");
      }
      expect(JSON.stringify(result)).not.toContain("fixture-owner");
      expect(JSON.stringify(result)).not.toContain("C:\\desk");
    } finally {
      await service.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    }
  });
});
