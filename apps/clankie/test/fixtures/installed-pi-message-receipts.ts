import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, vi } from "vitest";

/** Real installed Pi CLI/TUI, real Herdr/kernel identity checks; recorded loopback model only. */
export async function installedPiReceiptFixture(cleanup: (close: () => unknown | Promise<unknown>) => void) {
  const closes = { push: cleanup };
  const { discoverPiNativeCapability } = await import("../../src/captain/pi-native-capability.ts");
  const { createPiSeatAdapter } = await import("../../src/captain/pi-seat-adapter.ts");
  const { createPreparedNativeHost } = await import("../../src/captain/prepared-native-host.ts");
  const { isolatedHerdr } = await import("./local-fleet-proof/herdr-fixture.ts");
  const { pathToFileURL } = await import("node:url");
  const { dirname } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "receipt-installed-pi-176-"));
  closes.push(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile");
  await mkdir(profile);
  vi.stubEnv("PI_CODING_AGENT_DIR", profile);
  let requests = 0;
  let releaseAnswer = () => {};
  const answerGate = new Promise<void>((resolve) => {
    releaseAnswer = resolve;
  });
  const provider = createServer(async (request, response) => {
    expect(request.url).toBe("/v1/chat/completions");
    for await (const _ of request) {
    }
    requests++;
    if (requests > 1) await answerGate;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      'data: {"id":"receipt-native-176","object":"chat.completion.chunk","created":1,"model":"native","choices":[{"index":0,"delta":{"role":"assistant","content":"native receipt answer"},"finish_reason":null}]}\n\ndata: {"id":"receipt-native-176","object":"chat.completion.chunk","created":1,"model":"native","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  closes.push(() => {
    releaseAnswer();
    provider.closeAllConnections();
    return new Promise<void>((done) => provider.close(() => done()));
  });
  const baseUrl = "http://127.0.0.1:" + (provider.address() as { port: number }).port + "/v1";
  await writeFile(
    join(profile, "models.json"),
    JSON.stringify({
      providers: {
        "receipt-proof": {
          api: "openai-completions",
          baseUrl,
          apiKey: "local-recorded-response",
          models: [
            {
              id: "native",
              name: "Recorded loopback answer",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 128,
            },
          ],
        },
      },
    }),
  );
  const launch = {
    harness: "pi" as const,
    cwd: root,
    brief: "Bootstrap the local receipt proof.",
    model: "receipt-proof/native",
    effort: "off",
  };
  const capability = await discoverPiNativeCapability(launch);
  // allow-no-sandbox -- loads Pi's own installed package by path for scratch SettingsManager, not Playwright
  const sdk = await import(
    /* @vite-ignore */ pathToFileURL(join(dirname(dirname(dirname(capability.cli))), "dist/index.js")).href
  );
  sdk.SettingsManager.create(root, profile).setProjectTrusted(true);
  const herdr = await isolatedHerdr(join(root, "herdr-logs"));
  closes.push(() => herdr.close());
  const host = createPreparedNativeHost({
    harness: "pi",
    binding: async () => ({ runtime: "external", socketPath: herdr.socketPath, session: "default" }),
    processHelper: resolve(import.meta.dirname, "../../../../integrations/opencode-plugin/process-birth.py"),
  });
  const adapter = createPiSeatAdapter({
    repoRoot: resolve(import.meta.dirname, "../../../.."),
    stateDir: root,
    native: host,
    timeoutMs: 10000,
  });
  const prepared = await adapter.prepare!(launch);
  closes.push(() => prepared.dispose());
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const script = join(root, "launch-pi.sh");
  const env = {
    PATH: process.env.PATH!,
    HOME: root,
    PI_CODING_AGENT_DIR: profile,
    TERM: "xterm-256color",
    NODE_ENV: "test",
    VITEST: "true",
    CLANKIE_LAUNCHER_PATH: "/usr/bin/false",
    ...prepared.env,
  };
  await writeFile(
    script,
    "#!/bin/sh\nexec /usr/bin/env -i " +
      Object.entries(env)
        .map(([k, v]) => quote(k + "=" + v))
        .join(" ") +
      ' HERDR_ENV="$HERDR_ENV" HERDR_PANE_ID="$HERDR_PANE_ID" HERDR_SOCKET_PATH="$HERDR_SOCKET_PATH" ' +
      prepared.command.map(quote).join(" ") +
      "\n",
  );
  const pane = await host.createCommandTab({
    cwd: root,
    label: "Owned receipt proof 176",
    command: ["/bin/sh", script],
    env: {},
  });
  const started = await prepared.start({
    paneId: pane,
    name: "Owned native receipt proof",
    run: async () => {},
    guard: async () => {},
  });
  if (started.outcome !== "started") {
    throw new Error(JSON.stringify(started));
  }
  const boot = await started.control.settled(AbortSignal.timeout(10000));
  expect(boot.type).toBe("turn_completed");
  const nativeAgent = await herdr.cli("agent", "get", pane);
  const sessionFile =
    nativeAgent.result?.agent?.session?.value ?? nativeAgent.result?.agent?.agent_session?.value;
  if (!sessionFile) throw new Error("Owned Pi native session file unavailable");
  return { control: started.control, file: sessionFile, requests: () => requests, releaseAnswer, capability };
}
