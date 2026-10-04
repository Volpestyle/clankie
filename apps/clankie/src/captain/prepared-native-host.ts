import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { HerdrBinding } from "@clankie/protocol";
import { z } from "zod";
import { clientPid } from "../local-fleet-proof.ts";
import type { SeatProcessIdentity } from "@clankie/agent-hosts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";

const execute = promisify(execFile);
const Birth = z.object({
  pid: z.number().int().min(2),
  uid: z.number().int().nonnegative(),
  birth: z.tuple([z.string().regex(/^[1-9]\d*$/u), z.string().regex(/^\d{1,6}$/u)]),
  executable: z.string().startsWith("/"),
});
const NativeSession = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("herdr:opencode"),
    kind: z.literal("id"),
    value: z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u),
  }),
  z.object({
    source: z.literal("herdr:pi"),
    kind: z.literal("path"),
    value: z
      .string()
      .min(2)
      .max(4096)
      .startsWith("/")
      .refine(
        (path) => !path.includes("\0") && !path.split("/").some((part) => part === "." || part === ".."),
      ),
  }),
]);
export interface PreparedCommandTab {
  readonly cwd: string;
  readonly label: string;
  readonly command: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}
/** Created only by a trusted prepared adapter after its native session agreement.
 * This descriptor is not a caller credential or hand-started adoption mechanism.
 * A path producer verifies canonical native header/path agreement; a fresh native
 * session need not have flushed its file. Saved-history validation is separate. */
export type PreparedNativeSession =
  | { readonly source: "herdr:opencode"; readonly kind: "id"; readonly value: string }
  | { readonly source: "herdr:pi"; readonly kind: "path"; readonly value: string };

export interface PreparedNativeRoot {
  readonly paneId: string;
  readonly terminalId: string;
  check(socket: Socket): Promise<boolean>;
  proof(session: PreparedNativeSession): Promise<SeatProcessIdentity>;
  report(session: PreparedNativeSession, state: "idle" | "working" | "blocked" | "unknown"): Promise<void>;
}

/** Narrow local control transport. No generic method or caller-selected socket is exposed. */
export interface PreparedNativeHostOptions {
  readonly harness: "opencode" | "pi";
  readonly binding: () => Promise<HerdrBinding | undefined>;
  readonly processHelper: string;
  readonly platform?: string;
  readonly run?: (file: string, args: readonly string[]) => Promise<string>;
  readonly request?: (binding: HerdrBinding, method: string, params: unknown) => Promise<unknown>;
}

export function createPreparedNativeHost(input: PreparedNativeHostOptions) {
  const harness = input.harness;
  const descriptor = (value: PreparedNativeSession): PreparedNativeSession => {
    const parsed = NativeSession.parse(value);
    if (parsed.source !== `herdr:${harness}`) throw new Error("Native descriptor harness mismatch");
    return parsed;
  };
  const run =
    input.run ??
    (async (file, args) =>
      (await execute(file, [...args], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" })).stdout);
  const request = input.request ?? nativeRequest;
  const binding = async () => {
    if ((input.platform ?? process.platform) !== "darwin")
      throw new Error("Prepared native control is currently macOS-only");
    const value = await input.binding();
    if (!value) throw new Error("Native Herdr binding unavailable");
    return structuredClone(value);
  };
  return {
    async createCommandTab(options: PreparedCommandTab): Promise<string> {
      const current = await binding();
      // Exactly one new-tab request. Unknown creation is never retried and no
      // existing tab_id is accepted; no shell command or terminal input exists.
      const result = await request(current, "layout.apply", {
        tab_label: options.label,
        focus: false,
        root: { type: "pane", cwd: options.cwd, command: options.command, env: options.env ?? {} },
      });
      const response = z
        .object({
          result: z.object({
            layout: z.object({
              root: z.object({ type: z.literal("pane"), pane_id: z.string().regex(/^w[\w]+:p[\w]+$/u) }),
            }),
          }),
        })
        .safeParse(result);
      if (!response.success || JSON.stringify(await binding()) !== JSON.stringify(current))
        throw new Error("Native pane creation unconfirmed; inspect Herdr before retrying");
      return response.data.result.layout.root.pane_id;
    },
    async capture(paneId: string, executable: string, cwd: string): Promise<PreparedNativeRoot> {
      const original = await binding();
      // The controller selected the initial argv. For script runtimes this proves
      // the original interpreter root, not an independently observed script argv.
      const canonicalExecutable = await realpath(executable);
      const canonicalCwd = await realpath(cwd);
      const info = async () =>
        z
          .object({
            result: z.object({
              process_info: z.object({
                pane_id: z.literal(paneId),
                shell_pid: z.number().int().min(2),
                foreground_process_group_id: z.number().int().min(2),
              }),
            }),
          })
          .parse(await request(original, "pane.process_info", { pane_id: paneId })).result.process_info;
      // A prepared native argv may still be loading before Herdr recognizes its
      // TUI. Capture the pane allocation, not an already recognized agent.
      const allocation = async () =>
        z
          .object({
            result: z.object({
              pane: z.object({
                pane_id: z.literal(paneId),
                terminal_id: z.string().min(1),
                agent: z.string().nullish(),
                agent_session: z
                  .object({ source: z.string(), kind: z.string(), value: z.string() })
                  .nullish(),
              }),
            }),
          })
          .parse(await request(original, "pane.get", { pane_id: paneId })).result.pane;
      const initial = await info();
      if (initial.shell_pid !== initial.foreground_process_group_id)
        throw new Error("Original native command is not the foreground root");
      const pid = initial.shell_pid;
      const facts = async () => {
        const before = Birth.parse(
          JSON.parse(await run("/usr/bin/python3", ["-I", input.processHelper, String(pid)])),
        );
        const directory = (await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]))
          .split("\n")
          .filter((line) => line.startsWith("n"))
          .map((line) => line.slice(1));
        if (
          before.pid !== pid ||
          before.uid !== process.getuid?.() ||
          directory.length !== 1 ||
          (await realpath(directory[0]!)) !== canonicalCwd ||
          (await realpath(before.executable)) !== canonicalExecutable
        )
          throw new Error("Native root executable or cwd changed");
        const after = Birth.parse(
          JSON.parse(await run("/usr/bin/python3", ["-I", input.processHelper, String(pid)])),
        );
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("Native lifetime changed");
        return before;
      };
      const birth = await facts();
      const originalAllocation = await allocation();
      let reportedSession: PreparedNativeSession | undefined;
      const current = async () => {
        const latestAllocation = await allocation();
        if (
          JSON.stringify(await binding()) !== JSON.stringify(original) ||
          JSON.stringify(await info()) !== JSON.stringify(initial) ||
          latestAllocation.terminal_id !== originalAllocation.terminal_id ||
          (reportedSession !== undefined &&
            (latestAllocation.agent !== harness ||
              latestAllocation.agent_session?.kind !== reportedSession.kind ||
              latestAllocation.agent_session.source !== reportedSession.source ||
              latestAllocation.agent_session.value !== reportedSession.value)) ||
          JSON.stringify(await facts()) !== JSON.stringify(birth)
        )
          throw new Error("Original native allocation changed");
      };
      await current();
      return {
        paneId,
        terminalId: originalAllocation.terminal_id,
        async check(socket) {
          const clientPort = socket.remotePort;
          const serverPort = socket.localPort;
          const alive = () =>
            !socket.destroyed &&
            socket.readable &&
            socket.writable &&
            socket.remoteAddress === "127.0.0.1" &&
            socket.localAddress === "127.0.0.1" &&
            socket.remotePort === clientPort &&
            socket.localPort === serverPort;
          if (!alive() || !clientPort || !serverPort) return false;
          const owner = async () =>
            clientPid(
              await run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP:${serverPort}`, "-sTCP:ESTABLISHED", "-Fpn"]),
              clientPort,
              serverPort,
            );
          try {
            await current();
            if (!alive() || (await owner()) !== pid) return false;
            await current();
            return alive() && (await owner()) === pid && alive();
          } catch {
            return false;
          }
        },
        async report(value, state) {
          const session = descriptor(value);
          await current();
          if (reportedSession !== undefined && JSON.stringify(reportedSession) !== JSON.stringify(session))
            throw new Error("Cannot retarget native root");
          await request(original, "pane.report_agent", {
            pane_id: paneId,
            source: session.source,
            agent: harness,
            state,
            ...(session.kind === "id"
              ? { agent_session_id: session.value }
              : { agent_session_path: session.value }),
          });
          reportedSession = session;
          await current();
        },
        async proof(value) {
          const session = descriptor(value);
          if (JSON.stringify(reportedSession) !== JSON.stringify(session))
            throw new Error("Native session has not been bound");
          await current();
          const process = { pid, startTime: `${birth.birth[0]}.${birth.birth[1].padStart(6, "0")}` };
          return {
            fleet: "default",
            pane: paneId,
            nativeOccupantId: occupantIdForHerdrSession(session),
            binding: {
              socketPath: original.socketPath,
              ...(original.session === undefined ? {} : { session: original.session }),
            },
            processes: [process],
            shell: process,
          };
        },
      };
    },
  };
}

function nativeRequest(binding: HerdrBinding, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(binding.socketPath);
    const id = randomUUID();
    let text = "";
    let finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            `${method === "layout.apply" ? "Native pane creation unconfirmed" : "Native control unavailable"}; no automatic retry`,
          ),
        ),
      10_000,
    );
    socket.on("error", () =>
      finish(new Error("Native control socket unavailable; allocation may be unconfirmed")),
    );
    socket.on("close", () => finish(new Error("Native control reply unavailable; no retry")));
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 1024 * 1024) return finish(new Error("Native control response too large"));
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        const value = JSON.parse(text.slice(0, newline));
        if (value.id !== id || value.error) return finish(new Error("Native control refused request"));
        finish(undefined, value);
      } catch {
        finish(new Error("Invalid native control response"));
      }
    });
  });
}
