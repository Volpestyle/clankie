import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { RemoteStream } from "./remote-project-proof.ts";
import { RemoteFleetRelay } from "./remote-fleet-relay.ts";
import { windowsFleetRelayCommand } from "./windows-fleet-relay.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FleetLinkFile } from "@clankie/protocol";
import {
  SSH_BASE_OPTIONS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  remoteProgramCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "./herdr-fleet.ts";

/**
 * Windows fleets use a service-authored loopback relay over the configured SSH
 * connection. Authenticated stdout identifies each accepted TCP stream; the
 * existing reverse forward carries replies and fresh observation commands.
 * A one-use relay nonce binds that return channel and never leaves relay memory.
 * Discovery contains only the fleet, Herdr socket and loopback URL, not a bearer.
 * Legacy POSIX link tokens admit their fleet's connected tools, with no verified
 * pane, project or mailbox authority.
 */

/** The only paths the link listener answers (seat routes and the fleet's granted tools); everything else is 404. */
const LINK_ROUTE = /^\/v1\/fleet\/(?:seats\/[^/]+\/(?:events|hook|messages)|mcp)$/u;
const LINK_RECEIPT =
  /^\/v1\/fleet\/seats\/[^/]+\/messages\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const LINK_EVENT_ACK = /^\/v1\/fleet\/seats\/[^/]+\/events\/[^/]+\/ack$/u;

export function fleetLinkFetch<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) => {
    const path = new URL(request.url).pathname;
    return LINK_ROUTE.test(path) ||
      (request.method === "GET" && LINK_RECEIPT.test(path)) ||
      (request.method === "POST" && LINK_EVENT_ACK.test(path))
      ? fetch(request, ...rest)
      : Response.json({ error: "not_found" }, { status: 404 });
  };
}

export type FleetLinkState =
  | { readonly state: "starting"; readonly since: string }
  | { readonly state: "ready"; readonly since: string; readonly port: number }
  | { readonly state: "unreachable"; readonly since: string; readonly error: string };

const RESTART_MIN_MS = 2_000;
const RESTART_MAX_MS = 60_000;

/** The ssh argv for one fleet's link: its own connection, so the forward ends with it. */
export function linkSshArgs(fleet: HerdrFleet, localPort: number): string[] {
  return [
    ...SSH_BASE_OPTIONS,
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ExitOnForwardFailure=yes",
    // ssh reports the port it allocated for `-R 0` at INFO.
    "-o",
    "LogLevel=INFO",
    "-N",
    "-R",
    `127.0.0.1:0:127.0.0.1:${String(localPort)}`,
    "--",
    fleet.ssh.host,
  ];
}

/** The command that writes the link file on the fleet's machine, owner-readable only. */
type ProcessLinkFile = Omit<FleetLinkFile, "schemaVersion" | "token"> & {
  schemaVersion: 2;
  authentication: "local-process";
};
export function writeLinkFileCommand(fleet: HerdrFleet, file: FleetLinkFile | ProcessLinkFile): string {
  const json = JSON.stringify(file);
  if (fleet.ssh.shell === "powershell")
    return powershellScriptCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        "$dir = Join-Path $env:USERPROFILE '.clankie\\links'",
        "New-Item -ItemType Directory -Force $dir | Out-Null",
        `$path = Join-Path $dir ${powershellLiteral(`${file.fleet}.json`)}`,
        "$temp = $path + '.tmp'",
        // No BOM: the bridge reads it with JSON.parse.
        `[IO.File]::WriteAllText($temp, ${powershellLiteral(json)}, (New-Object Text.UTF8Encoding $false))`,
        'icacls.exe $temp /inheritance:r /grant:r "${env:USERNAME}:F" | Out-Null',
        "Move-Item -Force -LiteralPath $temp -Destination $path",
      ].join("; "),
    );
  return posixScriptCommand(
    [
      "set -e",
      "umask 077",
      'mkdir -p "$HOME/.clankie/links"',
      `printf '%s' ${posixQuote(json)} > "$HOME/.clankie/links/${file.fleet}.json.tmp"`,
      `mv -f "$HOME/.clankie/links/${file.fleet}.json.tmp" "$HOME/.clankie/links/${file.fleet}.json"`,
    ].join("\n"),
  );
}

/** One fleet's supervised link: the reverse forward, then the link file naming it. */
class FleetLink {
  private child: ChildProcess | undefined;
  private relay: RemoteFleetRelay | undefined;
  private responseServer: Server | undefined;
  private relayChild: ChildProcess | undefined;
  private current: FleetLinkState = { state: "starting", since: new Date().toISOString() };
  private closed = false;
  private backoff = RESTART_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly token = randomBytes(32).toString("base64url");
  readonly fleet: HerdrFleet;
  private readonly options: {
    readonly localPort: number;
    readonly shell: FleetShellRun;
    readonly stream?: (command: string) => ChildProcess;
    readonly spawn?: typeof spawn;
    readonly log?: (message: string) => void;
  };

  constructor(fleet: HerdrFleet, options: FleetLink["options"]) {
    this.fleet = fleet;
    this.options = options;
  }

  status(): FleetLinkState {
    return this.current;
  }

  start(): void {
    if (this.closed || this.child !== undefined || this.responseServer !== undefined) return;
    this.current = { state: "starting", since: new Date().toISOString() };
    const trustedRelay = this.fleet.ssh.shell === "powershell" && this.options.stream !== undefined;
    const launch = (forwardPort: number, responseServer?: Server) => {
      if (this.closed) {
        responseServer?.close();
        return;
      }
      const child = (this.options.spawn ?? spawn)("ssh", linkSshArgs(this.fleet, forwardPort), {
        stdio: ["ignore", "ignore", "pipe"],
      });
      this.child = child;
      let stderr = "";
      let port: number | undefined;
      const publish = (allocatedPort: number) => {
        if (port !== undefined) return;
        port = allocatedPort;
        void this.socket()
          .then((socket) => {
            const discovery = { fleet: this.fleet.id, socket, url: `http://127.0.0.1:${String(port)}` };
            const file: FleetLinkFile | ProcessLinkFile = trustedRelay
              ? { ...discovery, schemaVersion: 2, authentication: "local-process" }
              : { ...discovery, schemaVersion: 1, token: this.token };
            return this.options.shell(writeLinkFileCommand(this.fleet, file));
          })
          .then(() => {
            if (this.child !== child) return;
            this.backoff = RESTART_MIN_MS;
            this.current = { state: "ready", since: new Date().toISOString(), port: port! };
            this.options.log?.(`fleet ${this.fleet.id}: link ready on its port ${String(port)}`);
          })
          .catch((error: unknown) => {
            stderr = `could not write the link file: ${error instanceof Error ? error.message : String(error)}`;
            child.kill();
          });
      };
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-4096);
        const allocated = /Allocated port (\d+) for remote forward/u.exec(stderr);
        if (!allocated) return;
        if (!trustedRelay) {
          publish(Number(allocated[1]));
          return;
        }
        if (this.relayChild) return;
        const relayChild = this.options.stream!(windowsFleetRelayCommand(Number(allocated[1])));
        this.relayChild = relayChild;
        relayChild.stderr?.on("data", () => {});
        this.relay = new RemoteFleetRelay({
          child: relayChild,
          localPort: this.options.localPort,
          ready: publish,
          responseServer: responseServer!,
        });
        relayChild.once("exit", () => {
          if (this.child === child) {
            child.kill();
            this.lost(child, "Remote proof relay disconnected");
          }
        });
        relayChild.once("error", () => {
          if (this.child === child) {
            child.kill();
            this.lost(child, "Remote proof relay unavailable");
          }
        });
      });
      child.on("error", (error) => this.lost(child, error.message));
      child.on("exit", (code, signal) =>
        this.lost(child, stderr.trim().split("\n").at(-1) || `ssh exited (${String(code ?? signal)})`),
      );
    };
    if (!trustedRelay) {
      launch(this.options.localPort);
      return;
    }
    const server = createServer((socket) => {
      if (!this.relay) socket.destroy();
    });
    this.responseServer = server;
    server.once("error", () => {
      this.close();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address !== "string") launch(address.port, server);
    });
  }

  /** The fleet's Herdr socket on that machine: how its panes say which session they are in. */
  private async socket(): Promise<string> {
    const listed = JSON.parse(
      await this.options.shell(
        remoteProgramCommand(this.fleet.ssh.shell, "herdr", ["session", "list", "--json"]),
      ),
    ) as { sessions?: { name?: unknown; socket_path?: unknown }[] };
    const socket = listed.sessions?.find((session) => session.name === this.fleet.session)?.socket_path;
    if (typeof socket !== "string" || socket === "")
      throw new Error(`Herdr session ${this.fleet.session} is not running on ${this.fleet.id}`);
    return socket;
  }

  stream(socket: Socket): RemoteStream | undefined {
    return this.current.state === "ready" ? this.relay?.stream(socket) : undefined;
  }

  lifetime(): () => boolean {
    const relay = this.relay;
    return () => !!relay && this.relay === relay && this.current.state === "ready" && relay.alive();
  }

  observe(command: string, timeoutMs?: number): Promise<string> {
    return this.current.state === "ready" && this.relay
      ? this.relay.execute(command, timeoutMs)
      : Promise.reject(new Error("Remote proof relay unavailable"));
  }

  close(): void {
    this.closed = true;
    this.relay?.close();
    this.relay = undefined;
    this.relayChild?.kill();
    this.relayChild = undefined;
    this.responseServer?.close();
    this.responseServer = undefined;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
  }

  private lost(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.relay?.close();
    this.relay = undefined;
    this.relayChild?.kill();
    this.relayChild = undefined;
    this.responseServer?.close();
    this.responseServer = undefined;
    this.current = { state: "unreachable", since: new Date().toISOString(), error: error.slice(0, 500) };
    this.options.log?.(`fleet ${this.fleet.id}: link down: ${error}`);
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

/** Every ssh fleet's link, started with the service and closed with it. */
export class FleetLinks {
  private readonly links = new Map<string, FleetLink>();
  private readonly options: {
    readonly shell: (fleet: HerdrFleet) => FleetShellRun;
    readonly stream?: (fleet: HerdrFleet) => (command: string) => ChildProcess;
    readonly projectProof?: (
      fleet: string,
      pane: string,
      stream: RemoteStream,
    ) => Promise<ProjectProcessProof | undefined>;
    readonly spawn?: typeof spawn;
    readonly log?: (message: string) => void;
  };

  constructor(options: FleetLinks["options"]) {
    this.options = options;
  }

  /** Link each fleet to the restricted listener on `localPort`. */
  start(fleets: readonly HerdrFleet[], localPort: number): void {
    for (const [id, link] of this.links) {
      const fleet = fleets.find((entry) => entry.id === id);
      if (!fleet || JSON.stringify(fleet) !== JSON.stringify(link.fleet)) {
        link.close();
        this.links.delete(id);
      }
    }
    for (const fleet of fleets) {
      if (this.links.has(fleet.id)) continue;
      const link = new FleetLink(fleet, {
        localPort,
        shell: this.options.shell(fleet),
        ...(this.options.stream ? { stream: this.options.stream(fleet) } : {}),
        ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        ...(this.options.log === undefined ? {} : { log: this.options.log }),
      });
      this.links.set(fleet.id, link);
      link.start();
    }
  }

  private readonly admitted = new WeakMap<Request, LocalFleetIdentity>();

  identity(request: Request): LocalFleetIdentity | undefined {
    return this.admitted.get(request);
  }

  /** Only the trusted relay's exact accepted stream admits a remote identity. */
  fetch(forward: (request: Request) => Response | Promise<Response>) {
    return fleetLinkFetch(async (request: Request, env: HttpBindings | Http2Bindings) => {
      const pane = request.headers.get("x-clankie-pane") ?? "";
      if (!/^w[\w]+:p[\w]+$/u.test(pane))
        return Response.json({ error: "remote_pane_required" }, { status: 403 });
      for (const [fleet, link] of this.links) {
        const stream = link.stream(env.incoming.socket);
        if (!stream) continue;
        // Share only simultaneous reads; every later tool/membership check observes afresh.
        let pending: Promise<ProjectProcessProof | undefined> | undefined;
        const identity: LocalFleetIdentity = {
          fleet,
          pane,
          validate: async () =>
            stream.alive() && this.links.get(fleet) === link && link.status().state === "ready",
          projectProof: () => {
            if (!stream.alive() || this.links.get(fleet) !== link) return Promise.resolve(undefined);
            return (pending ??= Promise.resolve(this.options.projectProof?.(fleet, pane, stream)).finally(
              () => {
                pending = undefined;
              },
            ));
          },
        };
        this.admitted.set(request, identity);
        try {
          return await forward(request);
        } finally {
          this.admitted.delete(request);
        }
      }
      return Response.json({ error: "remote_process_membership_required" }, { status: 403 });
    });
  }

  /** The fleet a link token belongs to, compared in constant time. */
  authenticate(token: string): string | undefined {
    const presented = Buffer.from(token);
    for (const link of this.links.values()) {
      if (link.status().state !== "ready") continue;
      const expected = Buffer.from(link.token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) return link.fleet.id;
    }
    return undefined;
  }

  /** Fresh commands reuse the resident trusted relay; no process authority is cached. */
  observer(fleet: HerdrFleet): FleetShellRun | undefined {
    const link = this.links.get(fleet.id);
    return link && JSON.stringify(link.fleet) === JSON.stringify(fleet) && link.status().state === "ready"
      ? (command, timeoutMs) => link.observe(command, timeoutMs)
      : undefined;
  }

  lifetime(fleet: HerdrFleet): () => boolean {
    const link = this.links.get(fleet.id);
    const alive = link?.lifetime();
    return () =>
      !!link &&
      this.links.get(fleet.id) === link &&
      JSON.stringify(link.fleet) === JSON.stringify(fleet) &&
      !!alive?.();
  }

  status(fleet: string): FleetLinkState | undefined {
    return this.links.get(fleet)?.status();
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }
}
