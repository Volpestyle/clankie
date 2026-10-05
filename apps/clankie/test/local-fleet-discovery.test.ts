import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HttpBindings } from "@hono/node-server";
import { expect, test, vi } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";

test.each(["normal close", "failure after publish", "failure during publish"])(
  "private-state discovery preserves production bytes and native reads through %s",
  async (cleanup) => {
    const { readLink } = (await import(
      new URL("../../../integrations/claude-plugin/worker/bin/link.mjs", import.meta.url).href
    )) as {
      readLink(socket: string, env: NodeJS.ProcessEnv): { url: string } | undefined;
    };
    const root = await mkdtemp(join(tmpdir(), "fleet-discovery-isolation-"));
    const productionState = join(root, "production");
    const privateState = join(root, "private");
    const binding = { runtime: "external" as const, socketPath: "/fixture/herdr.sock", session: "default" };
    const prove = vi.fn(async (_socket, pane: string) => pane === "w1:p1");
    const production = new LocalFleetLink({
      directory: join(productionState, "links"),
      binding: async () => binding,
      prove,
    });
    const scratch = new LocalFleetLink({
      directory: join(privateState, "links"),
      binding: async () => binding,
      prove: async () => false,
    });
    const productionFile = join(productionState, "links", "default-local.json");
    const productionRead = production.fetch(async (request) =>
      (await production.identity(request)?.validate())
        ? Response.json({ source: "production", issue: "fixture" })
        : Response.json({ error: "local_process_membership_required" }, { status: 403 }),
    );
    const readNative = async () => {
      const link = readLink(binding.socketPath, { CLANKIE_STATE: productionState });
      expect(link?.url).toBe("http://127.0.0.1:43101");
      const request = new Request(new URL("/v1/fleet/mcp", link!.url), {
        method: "POST",
        headers: { "x-clankie-pane": "w1:p1" },
      });
      const response = await productionRead(request, { incoming: { socket: {} } } as HttpBindings);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ source: "production", issue: "fixture" });
    };
    try {
      // Fixture ports are descriptor data; no service or native agent is launched.
      await production.publish(43101);
      const bytes = await readFile(productionFile);
      await readNative();
      if (cleanup === "failure during publish") {
        await writeFile(privateState, "not a directory");
        await expect(scratch.publish(43102)).rejects.toThrow();
      } else {
        await scratch.publish(43102);
        expect(readLink(binding.socketPath, { CLANKIE_STATE: privateState })?.url).toBe(
          "http://127.0.0.1:43102",
        );
      }
      expect(await readFile(productionFile)).toEqual(bytes);
      await readNative();
      if (cleanup === "failure after publish") {
        await expect(
          (async () => {
            try {
              throw new Error("Startup failed after discovery publication");
            } finally {
              await scratch.close();
            }
          })(),
        ).rejects.toThrow("Startup failed");
      } else {
        await scratch.close();
      }
      expect(readLink(binding.socketPath, { CLANKIE_STATE: privateState })).toBeUndefined();
      expect(await readFile(productionFile)).toEqual(bytes);
      await readNative();
      expect(prove).toHaveBeenCalledTimes(3);
    } finally {
      await scratch.close();
      await production.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
