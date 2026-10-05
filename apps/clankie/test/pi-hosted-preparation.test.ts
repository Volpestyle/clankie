import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { HerdrWatchStore, type PiSeatModel } from "../src/captain/herdr-watch.ts";

const included: PiSeatModel = {
  model: "clankie/default",
  provider: {
    id: "clankie",
    config: { baseUrl: "http://127.0.0.1:1/not-called", apiKey: "synthetic-not-a-credential" },
  },
};
const scenarios: readonly {
  name: string;
  requested?: string;
  hosted?: PiSeatModel;
  expected?: string;
  lookupError?: string;
  configureError?: string;
  chrome?: boolean;
}[] = [
  {
    name: "off-hosted preserves explicit native model control",
    requested: "fixture/keyless",
    expected: "fixture/keyless",
  },
  {
    name: "included billing selects forwarder model before native preparation",
    requested: "fixture/keyless",
    hosted: included,
    expected: "clankie/default",
  },
  {
    name: "customer credential defaults to selected model before native preparation",
    hosted: { model: "fixture/customer-selected" },
    expected: "fixture/customer-selected",
  },
  {
    name: "included billing keeps an explicitly selected included alias",
    requested: "clankie/routine",
    hosted: included,
    expected: "clankie/routine",
  },
  {
    name: "customer model policy preserves an explicit native selection",
    requested: "fixture/explicit",
    hosted: { model: "fixture/customer-selected" },
    expected: "fixture/explicit",
  },
  {
    name: "hosted lookup refusal stops before native preparation or allocation",
    requested: "fixture/keyless",
    lookupError: "synthetic hosted policy refusal",
  },
  {
    name: "forwarder declaration failure stops before native preparation or allocation",
    requested: "fixture/keyless",
    hosted: included,
    configureError: "synthetic declaration refusal",
  },
  {
    name: "unsupported Chrome refuses before hosted configuration or native preparation",
    requested: "fixture/keyless",
    hosted: included,
    chrome: true,
  },
];
for (const scenario of scenarios) {
  test(scenario.name, async () => {
    const dir = await mkdtemp(join(tmpdir(), "clankie-native-hosted-probe-"));
    const prepares: Array<{ model?: string }> = [];
    const lookup = vi.fn(async () => {
      if (scenario.lookupError) throw new Error(scenario.lookupError);
      return scenario.hosted;
    });
    const runner = {
      createTab: vi.fn(async () => {
        throw new Error("forbidden: no pane may be allocated by this probe");
      }),
      startAgent: vi.fn(async () => {
        throw new Error("forbidden: no native launch");
      }),
      runInPane: vi.fn(async () => {
        throw new Error("forbidden: no terminal input");
      }),
      get: vi.fn(async () => {
        throw new Error("forbidden: no native pane observation");
      }),
      resolveTerminal: vi.fn(async () => {
        throw new Error("forbidden: no native terminal observation");
      }),
      list: vi.fn(async () => []),
      wait: vi.fn(async () => {
        throw new Error("forbidden wait");
      }),
      closePane: vi.fn(async () => {}),
      configurePiProvider: vi.fn(async () => {
        if (scenario.configureError) throw new Error(scenario.configureError);
      }),
    };
    const adapter = {
      harness: "pi" as const,
      async prepare(launch: { model?: string }) {
        prepares.push(launch.model === undefined ? {} : { model: launch.model });
        throw new Error("DIAGNOSTIC_PREPARATION_BOUNDARY: stop before allocation");
      },
      async start() {
        throw new Error("forbidden: no adapter start");
      },
      async attach() {
        return undefined;
      },
    };
    const store = new HerdrWatchStore(join(dir, "watches.json"), {
      runner,
      seatAdapters: [adapter],
      piSeatModel: lookup,
    });
    try {
      const result = await store.spawnSeat(
        {
          schemaVersion: 1,
          harness: "pi",
          title: "Mira",
          workingDirectory: dir,
          ...(scenario.requested === undefined ? {} : { model: scenario.requested }),
          ...(scenario.chrome ? { chrome: true } : {}),
        },
        undefined,
        "Synthetic bounded diagnostic brief.",
      );
      const refusal = scenario.chrome
        ? "pi has no supported Chrome launch option"
        : (scenario.lookupError ?? scenario.configureError);
      expect(prepares).toHaveLength(refusal ? 0 : 1);
      expect(lookup).toHaveBeenCalledTimes(scenario.chrome ? 0 : 1);
      if (scenario.hosted?.provider && !scenario.chrome) {
        expect(runner.configurePiProvider).toHaveBeenCalledWith(
          scenario.hosted.provider.id,
          scenario.hosted.provider.config,
        );
      } else expect(runner.configurePiProvider).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        outcome: "failed",
        detail: expect.stringContaining(refusal ?? "DIAGNOSTIC_PREPARATION_BOUNDARY"),
      });
      expect(runner.createTab).not.toHaveBeenCalled();
      expect(runner.startAgent).not.toHaveBeenCalled();
      expect(runner.runInPane).not.toHaveBeenCalled();
      expect(prepares[0]?.model).toBe(scenario.expected);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
