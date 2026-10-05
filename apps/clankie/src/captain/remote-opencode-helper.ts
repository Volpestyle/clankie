/**
 * Service-authored SSH helper. This is not an agent or an OpenCode server:
 * the visible TUI remains the only model/session writer. Operations use this
 * remote user's filesystem, Herdr socket and dedicated native profiles.
 */
import { createInterface } from "node:readline";
import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { OpenCodeProfiles, type OpenCodeWorkerProfile } from "../opencode-profiles.ts";
import { probeOpenCodeVersion } from "./opencode-seat-adapter.ts";

const execute = promisify(execFile);
const MAX_FRAME = 8 * 1024 * 1024;
const Frame = z
  .object({
    id: z.string().uuid(),
    method: z.enum([
      "initialize",
      "discover",
      "canonical",
      "binding",
      "request",
      "observe",
      "allocate",
      "configure",
      "retire",
      "register",
      "list",
      "resolve",
      "read",
      "socket",
    ]),
    input: z.unknown(),
  })
  .strict();
const Binding = z
  .object({
    socketPath: z.string().startsWith("/"),
    session: z.string().min(1),
    runtime: z.enum(["external", "bundled"]),
  })
  .strict();
const Path = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine((value) => !value.includes("\0"));
const Session = z.string().regex(/^ses_[A-Za-z0-9]{8,128}$/u);
const ReadOptions = z
  .object({
    tail: z.number().int().min(1).max(500).optional(),
    after: z.string().max(4096).optional(),
    subagentsOnly: z.boolean().optional(),
  })
  .strict();

export function createRemoteOpenCodeHelper(
  options: {
    run?: (file: string, args: readonly string[]) => Promise<string>;
    probeVersion?: typeof probeOpenCodeVersion;
    assetsRoot?: string;
  } = {},
) {
  let stateDir: string | undefined;
  let session: string | undefined;
  let profiles: OpenCodeProfiles | undefined;
  const allocated = new Map<string, OpenCodeWorkerProfile>();
  const configurations = new Set<string>();
  const unavailable = () => new Error("Remote native OpenCode observation unavailable");
  const assetsRoot = options.assetsRoot ?? import.meta.dirname;
  const run =
    options.run ??
    (async (file: string, args: readonly string[]) =>
      (await execute(file, [...args], { timeout: 5000, maxBuffer: MAX_FRAME })).stdout);
  const binding = async () => {
    const result = z
      .object({
        sessions: z.array(
          z.object({
            name: z.string(),
            socket_path: Path,
          }),
        ),
      })
      .parse(JSON.parse(await run("herdr", ["session", "list", "--json"])));
    const matches = result.sessions.filter((value) => value.name === session);
    if (matches.length !== 1) throw unavailable();
    return {
      runtime: "external" as const,
      socketPath: await realpath(matches[0]!.socket_path),
      session: session!,
    };
  };
  const request = async (original: z.infer<typeof Binding>, method: string, params: unknown) => {
    if (!isDeepStrictEqual(await binding(), original)) throw unavailable();
    return new Promise<unknown>((resolve, reject) => {
      const socket = createConnection(original.socketPath);
      const id = randomUUID();
      let text = "";
      const timer = setTimeout(() => {
        socket.destroy();
        reject(unavailable());
      }, 10_000);
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      socket.once("error", () => finish(unavailable()));
      socket.once("close", () => finish(unavailable()));
      socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.length > MAX_FRAME) return finish(unavailable());
        const newline = text.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(text.slice(0, newline));
          if (value.id !== id || value.error) return finish(unavailable());
          finish(undefined, value);
        } catch {
          finish(unavailable());
        }
      });
    });
  };
  return async (method: z.infer<typeof Frame>["method"], input: unknown): Promise<unknown> => {
    if (method === "initialize") {
      if (profiles || process.platform !== "darwin") throw unavailable();
      const value = z
        .object({ stateDir: Path, session: z.string().min(1) })
        .strict()
        .parse(input);
      await mkdir(value.stateDir, { recursive: true, mode: 0o700 });
      const stat = await lstat(value.stateDir);
      if (
        (await realpath(value.stateDir)) !== value.stateDir ||
        !stat.isDirectory() ||
        stat.uid !== process.getuid!() ||
        (stat.mode & 0o077) !== 0
      )
        throw unavailable();
      stateDir = value.stateDir;
      session = value.session;
      profiles = new OpenCodeProfiles(stateDir);
      return { uid: process.getuid!(), platform: process.platform, binding: await binding() };
    }
    if (!profiles || !stateDir) throw unavailable();
    switch (method) {
      case "canonical":
        return realpath(Path.parse(input));
      case "binding":
        return binding();
      case "discover": {
        const value = z.object({ cwd: Path }).strict().parse(input);
        const executable = await realpath((await run("/usr/bin/which", ["opencode"])).trim());
        await access(executable, constants.X_OK);
        const handle = await open(executable, "r");
        const bytes = Buffer.alloc(2);
        try {
          await handle.read(bytes, 0, 2, 0);
        } finally {
          await handle.close();
        }
        if (bytes.toString() === "#!") throw unavailable();
        return {
          executable,
          version: await (options.probeVersion ?? probeOpenCodeVersion)(executable),
          cwd: await realpath(value.cwd),
        };
      }
      case "request": {
        const value = z
          .object({
            binding: Binding,
            method: z.enum([
              "layout.apply",
              "pane.process_info",
              "pane.get",
              "pane.report_agent",
              "agent.rename",
            ]),
            params: z.unknown(),
          })
          .strict()
          .parse(input);
        return request(value.binding, value.method, value.params);
      }
      case "observe": {
        const value = z
          .object({ file: z.enum(["/usr/bin/python3", "/usr/sbin/lsof"]), args: z.array(z.string()).max(16) })
          .strict()
          .parse(input);
        if (value.file === "/usr/bin/python3") {
          if (
            value.args.length !== 3 ||
            value.args[0] !== "-I" ||
            value.args[1] !== join(assetsRoot, "process-birth.py") ||
            !/^[1-9]\d*$/u.test(value.args[2]!)
          )
            throw unavailable();
        } else if (
          !(
            value.args.length === 6 &&
            value.args[0] === "-a" &&
            value.args[1] === "-p" &&
            /^[1-9]\d*$/u.test(value.args[2]!) &&
            value.args.slice(3).join(" ") === "-d cwd -Fn"
          )
        )
          throw unavailable();
        return run(value.file, value.args);
      }
      case "socket": {
        const port = z.number().int().min(1).max(65535).parse(input);
        return run("/usr/sbin/lsof", ["-nP", "-a", "-iTCP:" + port, "-sTCP:ESTABLISHED", "-Fpn"]);
      }
      case "allocate": {
        const profile = await profiles.allocate();
        allocated.set(profile.profileId, profile);
        return profile;
      }
      case "configure": {
        const value = z
          .object({
            profileId: z.string(),
            env: z.record(z.string(), z.string()).default({}),
            endpoint: z.string().regex(/^ws:\/\/127\.0\.0\.1:\d+\/worker$/u),
            token: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict()
          .parse(input);
        const profile = allocated.get(value.profileId);
        if (!profile) throw unavailable();
        const env = { ...process.env, ...value.env };
        const config = z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(env.OPENCODE_CONFIG_CONTENT || "{}"));
        const tui = env.OPENCODE_TUI_CONFIG
          ? z
              .record(z.string(), z.unknown())
              .parse(JSON.parse(await readFile(env.OPENCODE_TUI_CONFIG, "utf8")))
          : {};
        const directory = await mkdtemp(join(profile.directory, "launch-"));
        configurations.add(directory);
        const plugins = z.array(z.unknown()).parse(config.plugin ?? []);
        const tuiPlugins = z.array(z.unknown()).parse(tui.plugin ?? []);
        const tuiPath = join(directory, "tui.json");
        await writeFile(
          tuiPath,
          JSON.stringify({
            ...tui,
            plugin: [
              ...tuiPlugins,
              [
                pathToFileURL(join(assetsRoot, "worker-tui.mjs")).href,
                { endpoint: value.endpoint, token: value.token },
              ],
            ],
          }),
          { mode: 0o600, flag: "wx" },
        );
        return {
          directory,
          env: {
            ...value.env,
            OPENCODE_TUI_CONFIG: tuiPath,
            OPENCODE_DB: profile.database,
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              ...config,
              autoupdate: false,
              plugin: [...plugins, pathToFileURL(join(assetsRoot, "worker-server.mjs")).href],
            }),
            OPENCODE_ROUTE: "",
            OPENCODE_FAST_BOOT: "",
          },
        };
      }
      case "retire": {
        const directory = Path.parse(input);
        if (!configurations.delete(directory)) throw unavailable();
        await rm(directory, { recursive: true, force: true });
        return true;
      }
      case "register": {
        const value = z
          .object({ profileId: z.string(), sessionId: Session, cwd: Path })
          .strict()
          .parse(input);
        const profile = allocated.get(value.profileId);
        if (!profile) throw unavailable();
        // Caller fences the SSH request on both sides; the shared reader also
        // rechecks profile/DB identity around each native SQLite transaction.
        await profiles.register(profile, value.sessionId, value.cwd, async () => {});
        allocated.delete(profile.profileId);
        return profiles.resolve(value.sessionId);
      }
      case "list":
        return profiles.list(
          z
            .number()
            .int()
            .min(1)
            .max(100)
            .parse(input ?? 20),
        );
      case "resolve":
        return profiles.resolve(Session.parse(input));
      case "read": {
        const value = z.object({ sessionId: Session, options: ReadOptions }).strict().parse(input);
        return profiles.read(value.sessionId, {
          ...(value.options.tail === undefined ? {} : { tail: value.options.tail }),
          ...(value.options.after === undefined ? {} : { after: value.options.after }),
          ...(value.options.subagentsOnly === undefined
            ? {}
            : { subagentsOnly: value.options.subagentsOnly }),
        });
      }
    }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const handle = createRemoteOpenCodeHelper();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = Promise.resolve();
  lines.on("line", (line) => {
    if (Buffer.byteLength(line) > MAX_FRAME) {
      process.exitCode = 1;
      lines.close();
      return;
    }
    pending = pending
      .then(async () => {
        const frame = Frame.parse(JSON.parse(line));
        try {
          const result = await handle(frame.method, frame.input);
          process.stdout.write(JSON.stringify({ id: frame.id, result }) + "\n");
        } catch {
          // Paths, tokens, environment and provider errors stay on this machine.
          process.stdout.write(
            JSON.stringify({ id: frame.id, error: "Remote native operation unavailable" }) + "\n",
          );
        }
      })
      .catch(() => {
        process.exitCode = 1;
        lines.close();
      });
  });
}
