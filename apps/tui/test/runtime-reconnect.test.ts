import { expect, it } from "vitest";
import { runRuntimeCommand } from "../src/command/runtime.ts";

it.each([
  {
    id: "local-work",
    machine: "local",
    session: "work",
    socketPath: "/tmp/pinned.sock",
    capacity: 4,
    capacitySource: "owner",
  },
  {
    id: "pc-work",
    machine: "pc",
    session: "work",
    ssh: { host: "owner@pc", shell: "powershell" },
    capacity: 16,
    capacitySource: "default",
  },
])("reconnects $id with its pinned transport, grants and capacity provenance", async (connection) => {
  const writes: unknown[] = [];
  const workspaces = [{ kind: "directory", path: "/code" }];
  await runRuntimeCommand(["reconnect", connection.id], {
    env: { CLANKIE_OPERATOR_TOKEN: "fixture" },
    host: "http://fixture",
    fetchImpl: (async (_url, init) => {
      if (init?.method === "GET")
        return Response.json({
          connections: [
            {
              ...connection,
              kind: "herdr",
              enabled: false,
              state: "disabled",
              workspaces,
              capabilities: ["code"],
            },
          ],
        });
      writes.push(JSON.parse(init!.body as string));
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  const { capacitySource, ...expected } = connection;
  if (capacitySource === "default") delete (expected as { capacity?: number }).capacity;
  expect(writes).toEqual([{ ...expected, kind: "herdr", capabilities: ["code"], workspaces }]);
});
it("refuses default reconnect before any request", async () => {
  await expect(
    runRuntimeCommand(["reconnect", "default"], {
      fetchImpl: (() => {
        throw new Error("must not fetch");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("default workspace");
});
