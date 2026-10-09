import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as socketServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
const hook = join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-hook.mjs");
const channel = "plugin:clankie-worker@clankie";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(
  options: {
    linked?: boolean;
    missingPane?: boolean;
    ambiguous?: boolean;
    offline?: boolean;
    unknownParent?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "claude-startup-")),
    state = join(root, "state"),
    socket = join(root, "herdr.sock"),
    pane = "w8:p3",
    sessionId = randomUUID();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const native = socketServer((connection) =>
    connection.on("data", (data) => {
      const request = JSON.parse(String(data));
      connection.end(
        JSON.stringify({
          id: request.id,
          ...(options.missingPane
            ? { error: { code: "pane_not_found" } }
            : { result: { process_info: { pane_id: pane } } }),
        }) + "\n",
      );
    }),
  );
  native.listen(socket);
  await once(native, "listening");
  cleanups.push(() => new Promise<void>((resolve) => native.close(() => resolve())));
  const requests: unknown[] = [];
  const server = httpServer((request, response) => {
    let body = "";
    request.on("data", (data) => (body += String(data)));
    request.on("end", () => {
      requests.push(JSON.parse(body));
      response.writeHead(options.offline ? 503 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ recorded: !options.offline }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  await mkdir(join(state, "links"), { recursive: true });
  if (options.linked !== false) {
    const link = {
      schemaVersion: 1,
      fleet: "pc",
      socket,
      url: `http://127.0.0.1:${address.port}`,
      token: "t".repeat(43),
    };
    await writeFile(join(state, "links", "pc.json"), JSON.stringify(link));
    if (options.ambiguous) await writeFile(join(state, "links", "duplicate.json"), JSON.stringify(link));
  }
  const localBin = join(root, "bin");
  await mkdir(localBin);
  await writeFile(
    join(localBin, "clankie"),
    "#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit(0));",
    { mode: 0o755 },
  );
  const parent = join(root, "parent.mjs");
  // Recorded native launch argv; a real intermediary shell prevents exec folding.
  await writeFile(
    parent,
    `import {spawn} from 'node:child_process';
const child=spawn('/bin/sh',['-c','"$@" <&0 & wait "$!"','fixture',process.execPath,${JSON.stringify(hook)},...JSON.parse(process.env.HOOK_ARGS)],{stdio:['pipe','inherit','inherit']});
child.stdin.end(process.env.HOOK_INPUT);child.on('exit',code=>process.exit(code??0));`,
  );
  async function run(
    args: string[] = [],
    settings: { event?: string; session?: string; pane?: string; codex?: boolean } = {},
  ) {
    const child = spawn(process.execPath, [parent, ...args], {
      argv0: options.unknownParent ? "node" : "claude",
      env: {
        PATH: `${localBin}:${process.env.PATH}`,
        CLANKIE_STATE: state,
        HERDR_PANE_ID: settings.pane ?? pane,
        HERDR_SOCKET_PATH: socket,
        CLANKIE_CODEX_CATALOG_OBSERVED: "1",
        HOOK_ARGS: JSON.stringify(settings.codex ? ["--codex"] : []),
        HOOK_INPUT: JSON.stringify({
          hook_event_name: settings.event ?? "SessionStart",
          session_id: settings.session ?? sessionId,
          source: "startup",
        }),
      },
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => (stdout += String(data)));
    child.stderr.on("data", (data) => (stderr += String(data)));
    const [code] = await once(child, "exit");
    expect(code, stderr).toBe(0);
    return stdout.trim()
      ? stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { systemMessage?: string })
      : [];
  }
  return { root, state, pane, sessionId, requests, run };
}
it("shows the exact safe session restart at startup through a linked pane's real command hook and shell ancestry", async () => {
  const f = await fixture();
  const output = await f.run();
  expect(output).toEqual([
    {
      systemMessage: `Clankie's live messages are off in this pane. Restart this session with: claude --resume ${f.sessionId} --channels ${channel}`,
    },
  ]);
  expect(f.requests).toMatchObject([{ event: "SessionStart", sessionId: f.sessionId }]);
});
it.each(
  [
    ["--channels", channel],
    [`--channels=${channel}`],
    ["--channels", "plugin:other@market", channel],
    ["--dangerously-load-development-channels", channel],
  ].map((args) => ({ args })),
)("does not show a fix for explicit exact channel opt-in $args", async ({ args }) => {
  const f = await fixture();
  expect(await f.run(args)).toEqual([]);
  expect(f.requests).toHaveLength(1);
});
it("shows the fix for a different plugin's opt-in", async () => {
  const f = await fixture();
  expect((await f.run(["--channels", "plugin:other@market"]))[0]?.systemMessage).toContain(
    `--resume ${f.sessionId}`,
  );
});
it("still shows the startup fix when Clankie's service refuses the lifecycle report", async () => {
  const f = await fixture({ offline: true });
  expect((await f.run())[0]?.systemMessage).toContain(channel);
});
it.each([{ linked: false }, { missingPane: true }, { ambiguous: true }])(
  "does not claim unmanaged or absent panes %j",
  async (options) => {
    const f = await fixture(options);
    expect(await f.run()).toEqual([]);
    expect(f.requests).toEqual([]);
  },
);
it.each([{ event: "Stop" }, { session: "bad; touch /tmp/not-authorized" }, { pane: "" }, { codex: true }])(
  "keeps the warning out of unrelated or unsafe hook contexts %j",
  async (settings) => {
    const f = await fixture();
    expect(await f.run([], settings)).toEqual([]);
  },
);
it("keeps print mode out of the interactive startup fix", async () => {
  const f = await fixture();
  expect(await f.run(["--print"])).toEqual([]);
});

it("shows a conservative exact-session fix when the native launch cannot be observed", async () => {
  const f = await fixture({ unknownParent: true });
  expect((await f.run())[0]?.systemMessage).toBe(
    `Clankie cannot confirm live messages in this pane. Restart this session with: claude --resume ${f.sessionId} --channels ${channel}`,
  );
});
