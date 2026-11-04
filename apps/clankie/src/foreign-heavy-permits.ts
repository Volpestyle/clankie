import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import type { FleetResourceGovernor } from "@clankie/fleet-resources";
import type {
  ForeignHeavyPermitsSettings,
  ForeignHeavyPermitsSnapshot,
} from "@clankie/protocol/owner-settings";
import { logger } from "./app/log.ts";

/**
 * Foreign heavy permits (#562): another local account (the CI runner user)
 * asks this machine's governor for a full-lane permit over a unix socket, so
 * its builds queue with the fleet's instead of beside them. The socket grants
 * one thing, a held slot, and nothing else: no command runs for the caller,
 * no state is read back, and the label it sends is only a name in the journal.
 *
 * Off by default; only the owner turns it on (owner-only route, never fleet
 * settings). macOS only, the platform the runners use.
 */

const DEFAULT_PERMITS_DIRECTORY = "/Users/Shared/clankie-permits";
const SOCKET_NAME = "heavy.sock";
const REQUEST_LINE_BYTES = 1024;
const REQUEST_DEADLINE_MS = 5_000;
const LANES = new Set(["full"]);
/** Authenticated callers wait locally for one of `maxLeases`; past this, refused. */
const QUEUE_PER_LEASE = 4;

const run = promisify(execFile);

/** A label is a name in the journal and logs, never markup or control text. */
function sanitizePermitLabel(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  const clean = text
    .replace(/[^A-Za-z0-9._:/ -]/gu, "_")
    .trim()
    .slice(0, 64);
  return clean || "ci";
}

interface Permit {
  socket: Socket;
  abort: AbortController;
  label: string;
  started: boolean;
}

export interface ForeignHeavyPermits {
  apply(settings: ForeignHeavyPermitsSettings | undefined): Promise<ForeignHeavyPermitsSnapshot>;
  snapshot(): ForeignHeavyPermitsSnapshot;
  close(): Promise<void>;
}

export function createForeignHeavyPermits(options: {
  governor: Pick<FleetResourceGovernor, "runHeavy">;
  /** The native helper with `--peer-uid` (fleetProcessHelper()). */
  helper: string;
  directory?: string;
  platform?: NodeJS.Platform;
  /** Length of one `maxHoldMinutes` unit; tests shorten it. */
  minuteMs?: number;
}): ForeignHeavyPermits {
  const directory = options.directory ?? DEFAULT_PERMITS_DIRECTORY;
  const socketPath = join(directory, SOCKET_NAME);
  const platform = options.platform ?? process.platform;
  let settings: ForeignHeavyPermitsSettings | undefined;
  let server: Server | undefined;
  let unavailable: string | undefined;
  let peerUid: number | undefined;
  const permits = new Set<Permit>();
  const sockets = new Set<Socket>();
  let applying = Promise.resolve();

  const snapshot = (): ForeignHeavyPermitsSnapshot => ({
    schemaVersion: 1,
    enabled: settings !== undefined,
    ...(settings ? { settings } : {}),
    listening: server !== undefined,
    ...(unavailable ? { unavailable } : {}),
    ...(server ? { socketPath } : {}),
  });

  async function stop(): Promise<void> {
    const closing = server;
    server = undefined;
    peerUid = undefined;
    for (const permit of permits) {
      // Tell a holder before the connection goes, so it stops its build.
      if (permit.started) reply(permit.socket, { state: "lost", reason: "disabled" });
      permit.abort.abort("disabled");
    }
    for (const socket of sockets) socket.end();
    for (const socket of sockets) socket.destroy();
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
    await removeOwnSocket(socketPath).catch(() => undefined);
  }

  async function start(next: ForeignHeavyPermitsSettings): Promise<void> {
    if (platform !== "darwin") throw new PermitSetupError("darwin_only");
    const uid = await resolveUid(next.user);
    await ownPrivateDirectory(directory);
    await setAcl(directory, `user:${next.user} allow search`);
    await removeOwnSocket(socketPath);
    const listening = createServer({ allowHalfOpen: false }, (socket) => accept(socket));
    listening.maxConnections = next.maxLeases * (1 + QUEUE_PER_LEASE);
    await new Promise<void>((resolve, reject) => {
      listening.once("error", reject);
      listening.listen(socketPath, () => {
        listening.removeListener("error", reject);
        resolve();
      });
    });
    try {
      await chmodNoFollow(socketPath, "0700");
      await setSocketAcl(socketPath, `user:${next.user} allow write`);
    } catch (error) {
      await new Promise<void>((resolve) => listening.close(() => resolve()));
      await removeOwnSocket(socketPath).catch(() => undefined);
      throw error;
    }
    listening.on("error", (error) =>
      logger.warn({ event: "foreign_permits.server_error", err: error }, "Foreign permit socket error"),
    );
    server = listening;
    peerUid = uid;
  }

  function accept(socket: Socket): void {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setNoDelay(true);
    const expected = peerUid;
    const limits = settings;
    if (expected === undefined || limits === undefined) return void socket.destroy();
    const refuse = (reason: string) => {
      reply(socket, { state: "refused", reason });
      socket.end();
      setTimeout(() => socket.destroy(), 1_000).unref();
    };
    let handled = false;
    const deadline = setTimeout(() => {
      handled = true;
      refuse("request_deadline");
    }, REQUEST_DEADLINE_MS);
    socket.once("close", () => clearTimeout(deadline));
    // Who is on the other end, from the kernel, before reading a byte. Handing
    // the socket to the helper makes Node stop reading it; the request waits in
    // the kernel and reading resumes once the peer is known.
    let buffered = "";
    let pid = 0;
    const onData = (chunk: Buffer) => {
      if (handled) return;
      buffered += chunk.toString("latin1");
      const newline = buffered.indexOf("\n");
      if (newline === -1) {
        if (buffered.length > REQUEST_LINE_BYTES) {
          handled = true;
          clearTimeout(deadline);
          refuse("request_too_large");
        }
        return;
      }
      handled = true;
      clearTimeout(deadline);
      const line = buffered.slice(0, newline);
      if (line.length > REQUEST_LINE_BYTES) return refuse("request_too_large");
      const request = parseRequest(line);
      if (typeof request === "string") return refuse(request);
      admit(socket, request.label, pid, limits);
    };
    peerCredentials(options.helper, socket).then(
      (credentials) => {
        if (socket.destroyed || handled) return;
        if (credentials.uid !== expected) {
          handled = true;
          clearTimeout(deadline);
          logger.warn(
            { event: "foreign_permits.peer_refused", uid: credentials.uid, pid: credentials.pid },
            "Foreign permit refused a peer that is not the permitted user",
          );
          return refuse("peer_not_permitted");
        }
        pid = credentials.pid;
        socket.on("data", onData);
        socket.resume();
      },
      () => {
        if (socket.destroyed || handled) return;
        handled = true;
        clearTimeout(deadline);
        refuse("peer_unverified");
      },
    );
  }

  function admit(socket: Socket, label: string, pid: number, limits: ForeignHeavyPermitsSettings): void {
    if (socket.destroyed) return;
    if (permits.size >= limits.maxLeases * (1 + QUEUE_PER_LEASE)) {
      reply(socket, { state: "refused", reason: "queue_full" });
      return void socket.end();
    }
    const permit: Permit = { socket, abort: new AbortController(), label, started: false };
    permits.add(permit);
    socket.once("close", () => permit.abort.abort("connection_closed"));
    logger.info({ event: "foreign_permits.requested", label, pid }, "Foreign heavy permit requested");
    pump();
  }

  /** At most `maxLeases` foreign requests reach the governor; the rest wait here in order. */
  function pump(): void {
    const limits = settings;
    if (!limits) return;
    const active = [...permits].filter((permit) => permit.started).length;
    let room = limits.maxLeases - active;
    for (const permit of permits) {
      if (room <= 0) break;
      if (permit.started) continue;
      if (permit.abort.signal.aborted) {
        permits.delete(permit);
        continue;
      }
      permit.started = true;
      room--;
      void hold(permit, limits).finally(() => {
        permits.delete(permit);
        pump();
      });
    }
    for (const permit of permits)
      if (!permit.started) reply(permit.socket, { state: "waiting", reason: "foreign_cap" });
  }

  async function hold(permit: Permit, limits: ForeignHeavyPermitsSettings): Promise<void> {
    const { socket, abort, label } = permit;
    let granted = false;
    let lastReason: string | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    const holderOutput = new LineSink((line) => {
      if (line !== "granted" || granted) return;
      granted = true;
      reply(socket, { state: "granted" });
      logger.info({ event: "foreign_permits.granted", label }, "Foreign heavy permit granted");
      holdTimer = setTimeout(
        () => abort.abort("max_hold"),
        limits.maxHoldMinutes * (options.minuteMs ?? 60_000),
      );
    });
    try {
      await options.governor.runHeavy(process.execPath, ["-e", HOLDER], {
        holderId: `ci-permit:${label}`,
        seatId: "ci-permit",
        signal: abort.signal,
        stdout: holderOutput,
        env: { PATH: "/usr/bin:/bin" },
        onWait: (state) => {
          const reason = state.pressure.reason ?? "queued";
          if (reason === lastReason) return;
          lastReason = reason;
          reply(socket, { state: "waiting", reason });
        },
      });
    } catch (error) {
      logger.warn({ event: "foreign_permits.failed", label, err: error }, "Foreign heavy permit failed");
    } finally {
      if (holdTimer) clearTimeout(holdTimer);
    }
    const reason = abort.signal.aborted ? String(abort.signal.reason) : "holder_exited";
    if (reason === "connection_closed") {
      logger.info({ event: "foreign_permits.released", label }, "Foreign heavy permit released");
      return;
    }
    // Anything but the caller hanging up takes the slot away while it may
    // still be building: tell it, so it stops instead of running ungoverned.
    if (granted)
      logger.warn({ event: "foreign_permits.lease_lost", label, reason }, "Foreign heavy permit lease lost");
    reply(socket, { state: "lost", reason });
    socket.end();
  }

  return {
    snapshot,
    apply(next) {
      const result = applying.then(async () => {
        if (sameSettings(settings, next) && (next === undefined || server)) return snapshot();
        await stop();
        settings = next;
        unavailable = undefined;
        if (!next) return snapshot();
        try {
          await start(next);
          logger.warn(
            { event: "foreign_permits.listening", user: next.user, maxLeases: next.maxLeases },
            "Foreign heavy permits listening",
          );
        } catch (error) {
          unavailable = error instanceof PermitSetupError ? error.message : "setup_failed";
          logger.warn(
            { event: "foreign_permits.unavailable", reason: unavailable, err: error },
            "Foreign heavy permits unavailable",
          );
          await stop();
        }
        return snapshot();
      });
      applying = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    async close() {
      await applying;
      settings = undefined;
      await stop();
    },
  };
}

/** Prints `granted` once the governor runs it, then holds until signalled. */
const HOLDER = "process.stdout.write('granted\\n');setInterval(()=>{},1<<30)";

class PermitSetupError extends Error {}

function sameSettings(a?: ForeignHeavyPermitsSettings, b?: ForeignHeavyPermitsSettings): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function reply(socket: Socket, message: Record<string, string>): void {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}

function parseRequest(line: string): { label: string } | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "malformed";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "malformed";
  const { op, lane, label, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length > 0 || op !== "acquire") return "malformed";
  if (typeof lane !== "string" || !LANES.has(lane)) return "lane_not_allowed";
  return { label: sanitizePermitLabel(label) };
}

async function resolveUid(user: string): Promise<number> {
  const { stdout } = await run("/usr/bin/id", ["-u", user], { timeout: 5_000 }).catch(() => {
    throw new PermitSetupError("unknown_user");
  });
  const uid = Number(stdout.trim());
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new PermitSetupError("user_not_permitted");
  return uid;
}

/**
 * /Users/Shared is world-writable and sticky: create our directory with an
 * exclusive mkdir, or accept an existing one only if it is a real directory
 * (never a symlink) that we own with no group or other bits. The sticky bit
 * then keeps anyone else from renaming or replacing it.
 */
async function ownPrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new PermitSetupError("directory_failed");
  }
  const seen = await lstat(directory);
  if (!seen.isDirectory() || seen.isSymbolicLink()) throw new PermitSetupError("directory_not_owned");
  if (seen.uid !== process.getuid!()) throw new PermitSetupError("directory_not_owned");
  if ((seen.mode & 0o077) !== 0) throw new PermitSetupError("directory_mode");
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new PermitSetupError("directory_not_owned");
  });
  try {
    const opened = await handle.stat();
    if (opened.ino !== seen.ino || opened.dev !== seen.dev) throw new PermitSetupError("directory_changed");
  } finally {
    await handle.close();
  }
}

/** Only ever removes a socket we own in our own directory. */
async function removeOwnSocket(path: string): Promise<void> {
  const seen = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!seen) return;
  if (!seen.isSocket() || seen.uid !== process.getuid!()) throw new PermitSetupError("socket_path_taken");
  await unlink(path);
}

async function chmodNoFollow(path: string, mode: string): Promise<void> {
  await run("/bin/chmod", ["-h", mode, path], { timeout: 5_000 });
}

/** Replace every ACL entry with exactly one; `-h` never follows a link. */
async function setAcl(path: string, entry: string, noFollow = true): Promise<void> {
  const flags = noFollow ? ["-h"] : [];
  try {
    await run("/bin/chmod", [...flags, "-N", path], { timeout: 5_000 });
    await run("/bin/chmod", [...flags, "+a", entry, path], { timeout: 5_000 });
  } catch {
    throw new PermitSetupError("acl_failed");
  }
}

/**
 * macOS cannot set an ACL on a socket through `chmod -h` ("Operation not
 * supported on socket": it opens the path itself). The socket lives in our own
 * 0700 directory, where no one else can create or swap an entry, so check that
 * it is still our socket and set the ACL by path.
 */
async function setSocketAcl(path: string, entry: string): Promise<void> {
  const seen = await lstat(path);
  if (!seen.isSocket() || seen.uid !== process.getuid!()) throw new PermitSetupError("socket_path_taken");
  await setAcl(path, entry, false);
}

/** The kernel's peer, via the native helper (getpeereid + LOCAL_PEERPID on fd 3). */
async function peerCredentials(helper: string, socket: Socket): Promise<{ uid: number; pid: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(helper, ["--peer-uid"], {
      stdio: ["ignore", "pipe", "ignore", socket],
      timeout: 5_000,
    });
    let output = "";
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      if (output.length < 256) output += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        const parsed = JSON.parse(output) as { uid?: unknown; pid?: unknown };
        if (code !== 0 || !Number.isSafeInteger(parsed.uid) || !Number.isSafeInteger(parsed.pid))
          return reject(new Error("peer unverified"));
        resolve({ uid: parsed.uid as number, pid: parsed.pid as number });
      } catch {
        reject(new Error("peer unverified"));
      }
    });
  });
}

class LineSink extends Writable {
  #buffer = "";
  constructor(onLine: (line: string) => void) {
    super({
      write: (chunk: Buffer, _encoding, callback) => {
        this.#buffer = (this.#buffer + chunk.toString("utf8")).slice(-4096);
        let newline: number;
        while ((newline = this.#buffer.indexOf("\n")) !== -1) {
          onLine(this.#buffer.slice(0, newline).trim());
          this.#buffer = this.#buffer.slice(newline + 1);
        }
        callback();
      },
    });
  }
}
