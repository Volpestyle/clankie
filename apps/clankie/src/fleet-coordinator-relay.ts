import { spawn, type ChildProcess } from "node:child_process";
import { SSH_BASE_OPTIONS, remoteProgramCommand, type HerdrFleet } from "./herdr-fleet.ts";

/**
 * The remote half of the coordinator relay (VUH-1381). It runs under `node -e`
 * on the fleet's machine, so nothing is installed there. It reads one JSON line
 * from stdin (the loopback port ssh allocated for its reverse forward), serves
 * a local endpoint the stock swarm-mcp client can dial (a named pipe on
 * Windows, a user-only Unix socket elsewhere), and splices each connection to
 * that port byte for byte. The coordinator authenticates every session by its
 * capability; the relay carries bytes and holds no credential.
 *
 * It exits when its stdin closes, which is when the Mac's ssh connection goes,
 * so the endpoint exists exactly as long as the link does.
 */
const RELAY_SCRIPT = String.raw`
const net = require("node:net"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const fleet = process.argv[1];
if (!/^[a-z][a-z0-9-]{0,63}$/.test(fleet || "")) { console.error("relay: bad fleet"); process.exit(2); }
const endpoint = process.platform === "win32"
  ? "\\\\.\\pipe\\clankie-swarm-" + fleet
  : path.join(os.homedir(), ".clankie", "swarm-relay-" + fleet + ".sock");
let port, server, buffered = "";
function start() {
  if (process.platform !== "win32") {
    fs.mkdirSync(path.dirname(endpoint), { recursive: true, mode: 0o700 });
    try { fs.unlinkSync(endpoint); } catch {}
  }
  server = net.createServer((client) => {
    const upstream = net.connect({ host: "127.0.0.1", port });
    client.pipe(upstream).pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close); upstream.on("error", close);
    client.on("close", close); upstream.on("close", close);
  });
  server.on("error", (error) => { console.error("relay: " + error.message); process.exit(1); });
  server.listen(endpoint, () => {
    if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
    process.stdout.write(JSON.stringify({ ready: endpoint }) + "\n");
  });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (port !== undefined) return;
  buffered += chunk;
  const newline = buffered.indexOf("\n");
  if (newline < 0) return;
  const value = JSON.parse(buffered.slice(0, newline)).port;
  if (!Number.isInteger(value) || value < 1 || value > 65535) { console.error("relay: bad port"); process.exit(2); }
  port = value;
  start();
});
const stop = () => { try { server && server.close(); } catch {} process.exit(0); };
process.stdin.on("end", stop);
process.stdin.on("close", stop);
`;

export function relayArgv(fleet: string): string[] {
  return [
    "-e",
    `eval(Buffer.from('${Buffer.from(RELAY_SCRIPT, "utf8").toString("base64")}','base64').toString())`,
    fleet,
  ];
}

/** The endpoint a peer on that machine dials; the relay reports the same path when ready. */
export function relayEndpoint(fleet: HerdrFleet): string {
  return fleet.ssh.shell === "powershell"
    ? `\\\\.\\pipe\\clankie-swarm-${fleet.id}`
    : `~/.clankie/swarm-relay-${fleet.id}.sock`;
}

/**
 * The ssh argv for one relay connection. It has its own connection, not the
 * fleet's multiplexed one: ssh reports the port it allocated for `-R 0` on
 * this connection's stderr, and the forward must end when the relay ends. The
 * forward binds the remote loopback only (`127.0.0.1`), never a network
 * address, and targets the owner's local Unix socket.
 */
export function relaySshArgs(fleet: HerdrFleet, ownerEndpoint: string): string[] {
  return [
    ...SSH_BASE_OPTIONS,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "LogLevel=INFO",
    "-R",
    `127.0.0.1:0:${ownerEndpoint}`,
    "--",
    fleet.ssh.host,
    remoteProgramCommand(fleet.ssh.shell, "node", relayArgv(fleet.id)),
  ];
}

export type RelayState =
  | { readonly state: "starting"; readonly since: string }
  | { readonly state: "ready"; readonly since: string; readonly endpoint: string; readonly port: number }
  | { readonly state: "unreachable"; readonly since: string; readonly error: string };

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;

/**
 * One supervised relay per fleet: the reverse forward plus its remote endpoint.
 * A lost link is a state; the supervisor reconnects with backoff, and a peer's
 * unacknowledged mail simply waits in the coordinator until it can fetch again.
 */
export class FleetCoordinatorRelay {
  private child: ChildProcess | undefined;
  private current: RelayState = { state: "starting", since: new Date().toISOString() };
  private closed = false;
  private backoff = RESTART_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters = new Set<(state: RelayState) => void>();

  readonly fleet: HerdrFleet;
  readonly ownerEndpoint: string;
  private readonly options: { readonly spawn?: typeof spawn; readonly log?: (message: string) => void };

  constructor(
    fleet: HerdrFleet,
    ownerEndpoint: string,
    options: { readonly spawn?: typeof spawn; readonly log?: (message: string) => void } = {},
  ) {
    this.fleet = fleet;
    this.ownerEndpoint = ownerEndpoint;
    this.options = options;
  }

  status(): RelayState {
    return this.current;
  }

  start(): void {
    if (this.closed || this.child !== undefined) return;
    this.set({ state: "starting", since: new Date().toISOString() });
    const child = (this.options.spawn ?? spawn)("ssh", relaySshArgs(this.fleet, this.ownerEndpoint), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    let stderr = "";
    let stdout = "";
    let port: number | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
      const allocated = /Allocated port (\d+) for remote forward/u.exec(stderr);
      if (port === undefined && allocated !== null) {
        port = Number(allocated[1]);
        child.stdin?.write(`${JSON.stringify({ port })}\n`);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0 || port === undefined) return;
      try {
        const ready = (JSON.parse(stdout.slice(0, newline)) as { ready?: unknown }).ready;
        if (typeof ready === "string") {
          this.backoff = RESTART_MIN_MS;
          this.set({ state: "ready", since: new Date().toISOString(), endpoint: ready, port });
          this.options.log?.(`fleet ${this.fleet.id}: coordinator relay ready at ${ready}`);
        }
      } catch {
        // Not the ready line; the relay prints nothing else on stdout.
      }
      stdout = stdout.slice(newline + 1);
    });
    child.on("error", (error) => this.lost(child, error.message));
    child.on("exit", (code, signal) =>
      this.lost(child, stderr.trim().split("\n").at(-1) || `ssh exited (${String(code ?? signal)})`),
    );
  }

  /** The ready endpoint, or the unreachable state once the attempt fails or times out. */
  async ready(timeoutMs = 20_000): Promise<RelayState> {
    this.start();
    if (this.current.state !== "starting") return this.current;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(this.current);
      }, timeoutMs);
      timer.unref?.();
      const done = (state: RelayState) => {
        clearTimeout(timer);
        resolve(state);
      };
      this.waiters.add(done);
    });
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
  }

  private set(state: RelayState): void {
    this.current = state;
    if (state.state === "starting") return;
    for (const waiter of this.waiters) waiter(state);
    this.waiters.clear();
  }

  private lost(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.set({ state: "unreachable", since: new Date().toISOString(), error: error.slice(0, 500) });
    this.options.log?.(`fleet ${this.fleet.id}: coordinator relay down: ${error}`);
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RESTART_MAX_MS);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, wait);
    this.timer.unref?.();
  }
}

/**
 * The relays the owner has chosen, one per ssh fleet, restored at service
 * start and started on first enrollment. Each forwards to the embedded
 * coordinator of the conversation the fleet was pinned to.
 */
export class FleetRelays {
  private readonly relays = new Map<string, FleetCoordinatorRelay>();

  private readonly options: {
    readonly fleets: () => Promise<readonly HerdrFleet[]>;
    readonly relayConversation: (fleet: string) => Promise<string | undefined>;
    readonly ownerEndpoint: (conversationId: string) => Promise<string>;
    readonly log?: (message: string) => void;
    readonly spawn?: typeof spawn;
  };

  constructor(options: FleetRelays["options"]) {
    this.options = options;
  }

  async restore(): Promise<void> {
    for (const fleet of await this.options.fleets()) {
      const conversationId = await this.options.relayConversation(fleet.id);
      if (conversationId === undefined) continue;
      await this.ensure(fleet, conversationId).catch((error: unknown) =>
        this.options.log?.(`fleet ${fleet.id}: coordinator relay not restored: ${String(error)}`),
      );
    }
  }

  async ensure(fleet: HerdrFleet, conversationId: string): Promise<FleetCoordinatorRelay> {
    const endpoint = await this.options.ownerEndpoint(conversationId);
    const existing = this.relays.get(fleet.id);
    if (existing !== undefined && existing.ownerEndpoint === endpoint && sameFleet(existing.fleet, fleet))
      return existing;
    existing?.close();
    const relay = new FleetCoordinatorRelay(fleet, endpoint, {
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
    });
    this.relays.set(fleet.id, relay);
    relay.start();
    return relay;
  }

  status(fleet: string): RelayState | undefined {
    return this.relays.get(fleet)?.status();
  }

  close(): void {
    for (const relay of this.relays.values()) relay.close();
    this.relays.clear();
  }
}

function sameFleet(left: HerdrFleet, right: HerdrFleet): boolean {
  return (
    left.id === right.id &&
    left.session === right.session &&
    left.ssh.host === right.ssh.host &&
    left.ssh.shell === right.ssh.shell
  );
}
