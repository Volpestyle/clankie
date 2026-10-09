import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import type { HttpBindings, Http2Bindings } from "@hono/node-server";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import type { RemoteStream } from "./remote-project-proof.ts";
import { RemoteFleetRelay, RemoteObservationError } from "./remote-fleet-relay.ts";
import { windowsFleetRelayCommand } from "./windows-fleet-relay.ts";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FleetLinkFile } from "@clankie/protocol";
import {
  SSH_BASE_OPTIONS,
  SSH_CONTROL_MAX_AGE_MS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  remoteProgramCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "./herdr-fleet.ts";
import { decodeRemoteShellError } from "./remote-shell-error.ts";

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
const LINK_ROUTE =
  /^\/v1\/fleet\/(?:seats\/[^/]+\/(?:events|hook|messages|peers|peer-messages|tool-catalog)|mcp)$/u;
const LEAD_ROUTE = /^\/v1\/fleet\/lead\/(?:mcp|prompt|transcript|events(?:\/[^/]+\/(?:ack|reply))?)$/u;
const LINK_RECEIPT =
  /^\/v1\/fleet\/seats\/[^/]+\/(?:messages|peer-messages)\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const LINK_MESSAGE_STATUS =
  /^\/v1\/fleet\/seats\/[^/]+\/messages\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\/status$/iu;
const LINK_EVENT_ACK = /^\/v1\/fleet\/seats\/[^/]+\/events\/[^/]+\/ack$/u;

export function fleetLinkFetch<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) => {
    const path = new URL(request.url).pathname;
    return LINK_ROUTE.test(path) ||
      LEAD_ROUTE.test(path) ||
      (request.method === "GET" && (LINK_RECEIPT.test(path) || LINK_MESSAGE_STATUS.test(path))) ||
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
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private retired: (() => void) | undefined;
  readonly token = randomBytes(32).toString("base64url");
  readonly fleet: HerdrFleet;
  private readonly options: {
    readonly localPort: number;
    readonly shell: FleetShellRun;
    readonly stream?: (command: string) => ChildProcess;
    readonly spawn?: typeof spawn;
    readonly log?: (message: string) => void;
    readonly maxAgeMs?: number;
    readonly ready?: () => void;
    readonly refresh?: () => void;
    readonly disconnected?: () => void;
    readonly publish: (operation: () => Promise<void>) => Promise<void>;
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
      let failure: string | undefined;
      let port: number | undefined;
      const publish = (allocatedPort: number) => {
        if (port !== undefined) return;
        port = allocatedPort;
        void this.socket()
          .then((socket) => {
            if (this.closed || this.child !== child) return;
            const discovery = { fleet: this.fleet.id, socket, url: `http://127.0.0.1:${String(port)}` };
            const file: FleetLinkFile | ProcessLinkFile = trustedRelay
              ? { ...discovery, schemaVersion: 2, authentication: "local-process" }
              : { ...discovery, schemaVersion: 1, token: this.token };
            return this.options.publish(async () => {
              if (this.closed || this.child !== child) return;
              await this.options.shell(writeLinkFileCommand(this.fleet, file));
            });
          })
          .then(() => {
            if (this.child !== child) return;
            this.backoff = RESTART_MIN_MS;
            this.current = { state: "ready", since: new Date().toISOString(), port: port! };
            this.options.log?.(`fleet ${this.fleet.id}: link ready on its port ${String(port)}`);
            this.options.ready?.();
            // Only the resident relay inherits a login environment. Bare
            // reverse forwards carry no remote program to refresh.
            if (trustedRelay && !this.closed) {
              this.refreshTimer = setTimeout(() => {
                this.refreshTimer = undefined;
                this.options.refresh?.();
              }, this.options.maxAgeMs ?? SSH_CONTROL_MAX_AGE_MS);
              this.refreshTimer.unref?.();
            }
          })
          .catch((error: unknown) => {
            failure = `could not publish the link: ${decodeRemoteShellError(error instanceof Error ? error.message : String(error))}`;
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
        let relayStderr = "";
        relayChild.stderr?.setEncoding("utf8");
        relayChild.stderr?.on("data", (chunk: string) => {
          // Decode the complete bootstrap diagnostic before status truncates
          // it; progress records can otherwise hide the XML opening tag.
          relayStderr += chunk;
        });
        this.relay = new RemoteFleetRelay({
          child: relayChild,
          localPort: this.options.localPort,
          ready: publish,
          responseServer: responseServer!,
          log: (message) => this.options.log?.(`fleet ${this.fleet.id}: ${message}`),
        });
        relayChild.once("close", () => {
          if (this.child === child) {
            child.kill();
            this.lost(child, decodeRemoteShellError(relayStderr) || "Remote proof relay disconnected");
          }
        });
        relayChild.once("error", (error) => {
          if (this.child === child) {
            child.kill();
            this.lost(child, error.message || "Remote proof relay unavailable");
          }
        });
      });
      child.on("error", (error) => this.lost(child, error.message));
      child.on("exit", (code, signal) =>
        this.lost(
          child,
          failure ?? (decodeRemoteShellError(stderr) || `ssh exited (${String(code ?? signal)})`),
        ),
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
      : Promise.reject(new RemoteObservationError("remote_observer_unavailable"));
  }

  /** Replacement discovery is already live; accepted work keeps this relay alive. */
  retire(complete: () => void): void {
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.retired = () => {
      this.close();
      complete();
    };
    if (this.relay) this.relay.drain(() => this.finishRetirement());
    else this.finishRetirement();
  }

  private finishRetirement(): void {
    const complete = this.retired;
    this.retired = undefined;
    complete?.();
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
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.child?.kill();
    this.child = undefined;
  }

  private lost(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    if (this.retired) {
      this.finishRetirement();
      return;
    }
    this.child = undefined;
    if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.relay?.close();
    this.relay = undefined;
    this.relayChild?.kill();
    this.relayChild = undefined;
    this.responseServer?.close();
    this.responseServer = undefined;
    this.current = { state: "unreachable", since: new Date().toISOString(), error: error.slice(0, 500) };
    this.options.disconnected?.();
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
  private readonly replacements = new Map<FleetLink, FleetLink>();
  private readonly retiring = new Set<FleetLink>();
  private readonly lifetimes = new Map<string, { link: FleetLink; alive: () => boolean }>();
  private readonly publications = new Map<string, Promise<void>>();
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
    readonly maxAgeMs?: number;
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
        this.replacements.get(link)?.close();
        this.replacements.delete(link);
        this.links.delete(id);
        this.lifetimes.delete(id);
        for (const old of this.retiring) {
          if (old.fleet.id !== id) continue;
          old.close();
          this.retiring.delete(old);
        }
      }
    }
    for (const fleet of fleets) {
      if (this.links.has(fleet.id)) continue;
      const link = this.create(fleet, localPort);
      this.links.set(fleet.id, link);
      link.start();
    }
  }

  private create(fleet: HerdrFleet, localPort: number, ready?: () => void, refreshing = false): FleetLink {
    const link = new FleetLink(fleet, {
      localPort,
      shell: this.options.shell(fleet),
      ...(this.options.stream ? { stream: this.options.stream(fleet) } : {}),
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
      ...(this.options.log === undefined
        ? {}
        : {
            log: (message: string) =>
              this.options.log!(
                refreshing && this.links.get(fleet.id) !== link
                  ? message.replace("link down:", "link refresh pending:")
                  : message,
              ),
          }),
      ...(this.options.maxAgeMs === undefined ? {} : { maxAgeMs: this.options.maxAgeMs }),
      ready: () => {
        ready?.();
        if (this.links.get(fleet.id) !== link) return;
        const lifetime = this.lifetimes.get(fleet.id);
        if (lifetime) {
          lifetime.link = link;
          lifetime.alive = link.lifetime();
        } else this.lifetimes.set(fleet.id, { link, alive: link.lifetime() });
      },
      disconnected: () => {
        if (this.links.get(fleet.id) === link) this.lifetimes.delete(fleet.id);
      },
      // A retiring attempt's in-flight write must finish before a newer
      // discovery write, including after configuration changes or real loss.
      publish: (operation) => {
        const pending = (this.publications.get(fleet.id) ?? Promise.resolve()).then(operation);
        const settled = pending.then(
          () => {},
          () => {},
        );
        this.publications.set(fleet.id, settled);
        void settled.then(() => {
          if (this.publications.get(fleet.id) === settled) this.publications.delete(fleet.id);
        });
        return pending;
      },
      refresh: () => this.refresh(link, localPort),
    });
    return link;
  }

  private refresh(link: FleetLink, localPort: number): void {
    if (this.links.get(link.fleet.id) !== link || this.replacements.has(link)) return;
    const replacement = this.create(
      link.fleet,
      localPort,
      () => {
        // Once promoted, normal outage recovery belongs to this same link.
        if (this.links.get(link.fleet.id) === replacement) return;
        if (this.links.get(link.fleet.id) !== link || this.replacements.get(link) !== replacement) {
          replacement.close();
          return;
        }
        this.replacements.delete(link);
        this.links.set(link.fleet.id, replacement);
        this.retiring.add(link);
        link.retire(() => this.retiring.delete(link));
      },
      true,
    );
    this.replacements.set(link, replacement);
    replacement.start();
  }

  private current(link: FleetLink): boolean {
    return this.links.get(link.fleet.id) === link || this.retiring.has(link);
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
      for (const link of [...this.links.values(), ...this.retiring]) {
        const fleet = link.fleet.id;
        const stream = link.stream(env.incoming.socket);
        if (!stream) continue;
        // Share only simultaneous reads; every later tool/membership check observes afresh.
        let pending: Promise<ProjectProcessProof | undefined> | undefined;
        const current = () => stream.alive() && this.current(link) && link.status().state === "ready";
        const identity: LocalFleetIdentity = {
          fleet,
          pane,
          current,
          validate: async () => current(),
          projectProof: () => {
            if (!current()) return Promise.resolve(undefined);
            return (pending ??= Promise.resolve(this.options.projectProof?.(fleet, pane, stream)).finally(
              () => {
                pending = undefined;
              },
            ));
          },
        };
        this.admitted.set(request, identity);
        try {
          const response = await forward(request);
          if (!this.retiring.has(link)) return response;
          const headers = new Headers(response.headers);
          headers.set("connection", "close");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
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
    const lifetime = this.lifetimes.get(fleet.id);
    return () =>
      !!lifetime &&
      this.lifetimes.get(fleet.id) === lifetime &&
      JSON.stringify(lifetime.link.fleet) === JSON.stringify(fleet) &&
      lifetime.alive();
  }

  status(fleet: string): FleetLinkState | undefined {
    return this.links.get(fleet)?.status();
  }

  close(): void {
    this.lifetimes.clear();
    for (const link of this.replacements.values()) link.close();
    this.replacements.clear();
    for (const link of this.retiring) link.close();
    this.retiring.clear();
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }
}
