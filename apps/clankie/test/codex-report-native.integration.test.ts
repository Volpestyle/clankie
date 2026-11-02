// Manual only: real Codex TUI, private core, process ancestry and listener.
// The offline Responses server supplies deterministic tool calls; no accounts or spend.
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { CodexAppServerClient, openCodexSocket } from "../src/captain/codex-app-server.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";

const exec = promisify(execFile);
const checkout = resolve(import.meta.dirname, "../../..");
type Hire = { serverPid: number; paneId: string; threadId: string; view: { pid: number; argv: string[] } };
type Reports = { requests: number; reports: { deliveryId: string; binding: string; text: string }[] };
const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.CODEX_REPORT_NATIVE_TEST !== "1");
nativeIt(
  "reports from the same real Codex TUI and bridge after refusal and disposable service restart",
  async () => {
    const root = await realpath(await mkdtemp("/tmp/codex-report-"));
    const evidence = join(checkout, ".local", "codex-report-proof");
    await mkdir(evidence, { recursive: true });
    const environment = {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_ENV: "test",
      VITEST: "true",
      HC_SOCKET: join(root, "core.sock"),
      CODEX_HOME: join(root, "codex"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_RUNTIME_DIR: join(root, "runtime"),
    };
    for (const path of [environment.CODEX_HOME, environment.XDG_CONFIG_HOME, environment.XDG_RUNTIME_DIR])
      await mkdir(path, { recursive: true });
    await mkdir(join(root, "config", "herdr-core"), { recursive: true });
    await writeFile(join(root, "config", "herdr-core", "config.toml"), "notes = false\n");
    let service: ChildProcess | undefined;
    let client: CodexAppServerClient | undefined;
    let coreStarted = false;
    let serverPid: number | undefined;
    let reportPort: number;
    const modelRequests: unknown[] = [];
    const toolOutputs: unknown[] = [];
    let reportText = "Before restart";
    let issueTool = true;
    const provider = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        modelRequests.push(body);
        await writeFile(join(evidence, "model-request.json"), JSON.stringify(body, null, 2));
        const tools = (body.tools ?? []).flatMap((tool: { type: string; tools?: unknown[] }) =>
          tool.type === "namespace"
            ? (tool.tools ?? []).map((child) => ({
                ...(child as object),
                namespace: (tool as { name?: string }).name,
              }))
            : [tool],
        );
        const report = tools.find((tool: { name?: string }) => tool.name?.endsWith("message_clankie"));
        const outputs = (body.input ?? []).filter(
          (item: { type: string }) => item.type === "function_call_output",
        );
        toolOutputs.push(...outputs);
        const id = `proof-${modelRequests.length}`;
        let item: unknown;
        if (issueTool && report) {
          issueTool = false;
          item = {
            type: "function_call",
            id: `${id}-tool`,
            call_id: id,
            name: report.name,
            namespace: report.namespace,
            arguments: JSON.stringify({ text: reportText }),
          };
        } else {
          item = {
            type: "message",
            role: "assistant",
            id: `${id}-message`,
            content: [{ type: "output_text", text: "Proof turn complete." }],
          };
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
          { type: "response.created", response: { id } },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
          },
        ])
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
      })().catch((error) => {
        response.writeHead(500).end(String(error));
      });
    });
    try {
      await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
      const modelPort = (provider.address() as { port: number }).port;
      await writeFile(
        join(root, "codex", "config.toml"),
        `model="proof"\nmodel_provider="proof"\ncheck_for_update_on_startup=false\n[mcp_servers.clankie]\ncommand="node"\nargs=[]\nenabled=false\n[model_providers.proof]\nname="Offline proof"\nbase_url="http://127.0.0.1:${modelPort}"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(root)}]\ntrust_level="trusted"\n`,
      );
      await exec(process.execPath, [join(checkout, "scripts/build-fleet-proof.mjs")]);
      // This bundle's depth keeps the native helper's default checkout root exact.
      const entry = join(checkout, ".local", "native-report", "build", "service.mjs");
      await mkdir(resolve(entry, ".."), { recursive: true });
      await build({
        entryPoints: [join(import.meta.dirname, "fixtures/codex-report-native-service.ts")],
        outfile: entry,
        bundle: true,
        platform: "node",
        format: "esm",
        banner: {
          js: "import {createRequire as proofRequire} from 'node:module'; const require=proofRequire(import.meta.url);",
        },
      });
      await exec("hc", ["server", "start"], { env: environment });
      coreStarted = true;
      expect(
        JSON.parse((await exec("hc", ["ls", "--json"], { env: environment })).stdout).terminals ?? [],
      ).toEqual([]);
      const startService = async () => {
        const child = spawn(process.execPath, [entry, root, fleetProcessHelper(checkout)], {
          env: environment,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        });
        service = child;
        let stderr = "";
        child.stderr!.on("data", (bytes) => {
          stderr += String(bytes);
        });
        child.on("exit", () => {
          void writeFile(join(evidence, `service-${child.pid}.log`), stderr);
        });
        const ready = await Promise.race([
          once(child, "message"),
          once(child, "exit").then(() => {
            throw new Error(stderr);
          }),
        ]);
        expect(ready[0]).toMatchObject({ ready: true });
        reportPort = (ready[0] as { port: number }).port;
        let id = 0;
        return async <T = unknown>(action: string): Promise<T> => {
          const current = ++id;
          const reply = new Promise<{ id: number; error?: string; result: T }>((done) => {
            const receive = (raw: unknown) => {
              const value = raw as { id: number; error?: string; result: T };
              if (value.id === current) {
                child.off("message", receive);
                done(value);
              }
            };
            child.on("message", receive);
          });
          child.send({ id: current, action });
          const value = await reply;
          if (value.error) throw new Error(value.error);
          return value.result;
        };
      };
      let call = await startService();
      const hire = await call<Hire>("hire");
      serverPid = hire.serverPid;
      await writeFile(join(evidence, "hire.json"), JSON.stringify(hire, null, 2));
      const endpoint = hire.view.argv.at(-1) as string;
      const socket = await openCodexSocket(`ws+unix://${endpoint.slice(7)}:/`);
      if (!socket) throw new Error("No hired Codex socket");
      client = new CodexAppServerClient(socket, () => {}, 20_000);
      await client.initialize(true);
      await expect
        .poll(
          async () => {
            const catalog = await client!.request("mcpServerStatus/list", {
              threadId: hire.threadId,
              detail: "toolsAndAuthOnly",
            });
            await writeFile(join(evidence, "catalog.json"), JSON.stringify(catalog, null, 2));
            return JSON.stringify(catalog).includes('"message_clankie"');
          },
          { timeout: 15_000 },
        )
        .toBe(true);
      const bridgePid = async () => {
        const { stdout } = await exec("/bin/ps", ["-axo", "pid=,ppid=,command="]);
        return stdout.split("\n").flatMap((line) => {
          const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
          return match && Number(match[2]) === serverPid && match[3]!.includes("/bin/fleet-mcp.mjs")
            ? [Number(match[1])]
            : [];
        });
      };
      const originalBridge = await bridgePid();
      expect(originalBridge).toHaveLength(1);
      const turn = async (text: string) => {
        reportText = text;
        issueTool = true;
        const started = (await client!.request("turn/start", {
          threadId: hire.threadId,
          input: [{ type: "text", text: "Run the proof report.", text_elements: [] }],
        })) as { turn: { id: string } };
        await expect
          .poll(
            async () => {
              const result = (await client!.request("thread/read", {
                threadId: hire.threadId,
                includeTurns: true,
              })) as { thread: { turns: { id: string; status: string }[] } };
              return result.thread.turns.find((turn) => turn.id === started.turn.id)?.status;
            },
            { timeout: 30_000 },
          )
          .toBe("completed");
        expect(issueTool, "Offline provider must dispatch the real message_clankie tool").toBe(false);
        await writeFile(join(evidence, "tool-outputs.json"), JSON.stringify(toolOutputs, null, 2));
      };
      await turn("Before restart");
      expect((await call<Reports>("reports")).reports).toHaveLength(1);
      await call("refuse");
      await turn("While refused");
      expect((await call<Reports>("reports")).reports).toHaveLength(1);
      const oldPid = service!.pid;
      const exited = once(service!, "exit");
      service!.kill("SIGKILL");
      await exited;
      call = await startService();
      await turn("After restart");
      const final = await call<Reports>("reports");
      expect(final.reports).toHaveLength(2);
      expect(await bridgePid()).toEqual(originalBridge);
      const replay = await fetch(
        `http://127.0.0.1:${reportPort!}/v1/fleet/seats/${encodeURIComponent(hire.paneId)}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-clankie-pane": hire.paneId },
          body: JSON.stringify({
            schemaVersion: 1,
            text: final.reports[1]!.text,
            delivery: { id: final.reports[1]!.deliveryId, binding: final.reports[1]!.binding },
          }),
        },
      );
      expect(replay.status).toBe(403);
      expect((await call<Reports>("reports")).reports).toHaveLength(2);
      const view = JSON.parse(
        (await exec("hc", ["get", hire.paneId.slice(11), "--json"], { env: environment })).stdout,
      );
      expect(JSON.stringify(view)).toContain(String(hire.view.pid));
      await writeFile(
        join(evidence, "receipt.json"),
        JSON.stringify(
          {
            oldServicePid: oldPid,
            newServicePid: service!.pid,
            hire,
            originalBridge,
            foreignReplayStatus: replay.status,
            final,
            toolOutputs,
            modelRequests: modelRequests.length,
          },
          null,
          2,
        ),
      );
    } finally {
      client?.close();
      if (service && service.exitCode === null && service.signalCode === null) {
        const exited = once(service, "exit");
        service.kill("SIGKILL");
        await exited;
      }
      if (coreStarted) await exec("hc", ["server", "stop"], { env: environment });
      provider.closeAllConnections();
      await new Promise<void>((done) => provider.close(() => done()));
      // A dedicated app-server survives its controller; stop only this proof's PID.
      if (serverPid) {
        try {
          process.kill(-serverPid, "SIGTERM");
        } catch {
          /* Already stopped with the TUI. */
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  120_000,
);
