import { expect, test } from "vitest";
import { ExtensionSupervisor, type ClankieExtension } from "../src/index.ts";

interface Ports {
  post(text: string): void;
  secret(): string;
}

type Projection = { tools: readonly string[] };

const settings = { key: "x", schema: { parse: (input: unknown) => input as { on: boolean } } };

function extension(
  id: string,
  behaviour: {
    start?: (signal: AbortSignal) => Promise<void>;
    health?: () => { state: "ready" } | { state: "degraded"; reason: string };
    create?: (host: Readonly<Pick<Ports, "post">>) => void;
  } = {},
): ClankieExtension<{ on: boolean }, Ports, "post", Projection> {
  return {
    contractVersion: 1,
    id,
    settings,
    needs: ["post"],
    create(host) {
      behaviour.create?.(host);
      return {
        start: behaviour.start ?? (async () => {}),
        stop: async () => {},
        health: behaviour.health ?? (() => ({ state: "ready" })),
        projection: () => ({ tools: [`${id}_tool`] }),
      };
    },
  };
}

test("a failing extension leaves the core and the other extensions running", async () => {
  const posted: string[] = [];
  const degraded: string[] = [];
  let personaHealth: { state: "ready" } | { state: "degraded"; reason: string } = { state: "ready" };
  let seen: object | undefined;
  const supervisor = new ExtensionSupervisor<Ports, Projection>({
    ports: { post: (text) => posted.push(text), secret: () => "core only" },
    onDegraded: (id, reason) => degraded.push(`${id}:${reason}`),
  });

  supervisor.add(
    extension("persona", {
      create: (host) => {
        seen = host;
        host.post("persona ready");
      },
      health: () => personaHealth,
    }),
    { enabled: true, settings: { on: true } },
  );
  supervisor.add(
    extension("relay", {
      start: async () => {
        throw new Error("gateway refused");
      },
    }),
    { enabled: true, settings: {} },
  );
  supervisor.add(
    extension("watch", {
      create: () => {
        throw new Error("no watch paired");
      },
    }),
    { enabled: true, settings: {} },
  );
  supervisor.add(extension("tracker-linear"), { enabled: false, settings: {} });
  const signals: Record<string, AbortSignal> = {};
  supervisor.add(extension("browser", { start: async (signal) => void (signals.browser = signal) }), {
    enabled: true,
    settings: {},
  });

  const started = await supervisor.start();

  expect(started).toEqual([
    { id: "persona", state: "running" },
    { id: "relay", state: "degraded", reason: "start_failed" },
    { id: "watch", state: "degraded", reason: "create_failed" },
    { id: "tracker-linear", state: "off" },
    { id: "browser", state: "running" },
  ]);
  expect(supervisor.projections()).toEqual([{ tools: ["persona_tool"] }, { tools: ["browser_tool"] }]);
  expect(posted).toEqual(["persona ready"]);
  expect(Object.keys(seen ?? {})).toEqual(["post"]);
  expect(Object.isFrozen(seen)).toBe(true);

  personaHealth = { state: "degraded", reason: "discord_token_rejected" };
  const later = await supervisor.report();
  expect(later[0]).toEqual({ id: "persona", state: "degraded", reason: "discord_token_rejected" });
  expect(supervisor.projections()).toEqual([{ tools: ["browser_tool"] }]);
  expect(degraded).toEqual(["watch:create_failed", "relay:start_failed", "persona:discord_token_rejected"]);

  // The composition root can stop one extension in its own place in shutdown.
  await supervisor.stop(["browser"]);
  expect(signals.browser?.aborted).toBe(true);
  expect(supervisor.projections()).toEqual([]);
  await supervisor.stop();
  expect((await supervisor.report()).map((report) => report.state)).toEqual([
    "degraded",
    "degraded",
    "degraded",
    "off",
    "stopped",
  ]);
});
