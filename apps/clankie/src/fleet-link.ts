import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FleetLinkFile } from "@clankie/protocol";
import {
  SSH_BASE_OPTIONS,
  posixQuote,
  posixScriptCommand,
  powershellLiteral,
  powershellScriptCommand,
  type FleetShellRun,
  type HerdrFleet,
} from "./herdr-fleet.ts";

/**
 * How a machine on an ssh fleet reaches Clankie (VUH-1527, ADR 0213 phase 2):
 * the Claude worker channel and hooks of a seat he hired there, and any agent
 * there writing to him. The link is the reverse of the Codex app-server
 * forward: one ssh connection per fleet carries a `-R` forward from that
 * machine's loopback to a listener here that answers the fleet seat routes and
 * nothing else, and a token that authorizes only those routes, only for panes
 * on that fleet. The token travels to the machine inside `~/.clankie/link.json`,
 * readable by its owner only; the operator credential never leaves this Mac.
 */

/** The only paths the link listener answers; everything else is 404. */
const LINK_ROUTE = /^\/v1\/fleet\/seats\/[^/]+\/(?:events|hook|messages)$/u;

export function fleetLinkFetch<Rest extends unknown[]>(
  fetch: (request: Request, ...rest: Rest) => Response | Promise<Response>,
): (request: Request, ...rest: Rest) => Response | Promise<Response> {
  return (request, ...rest) =>
    LINK_ROUTE.test(new URL(request.url).pathname)
      ? fetch(request, ...rest)
      : Response.json({ error: "not_found" }, { status: 404 });
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
export function writeLinkFileCommand(fleet: HerdrFleet, file: FleetLinkFile): string {
  const json = JSON.stringify(file);
  if (fleet.ssh.shell === "powershell")
    return powershellScriptCommand(
      [
        "$ErrorActionPreference = 'Stop'",
        "$dir = Join-Path $env:USERPROFILE '.clankie'",
        "New-Item -ItemType Directory -Force $dir | Out-Null",
        "$path = Join-Path $dir 'link.json'",
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
      'mkdir -p "$HOME/.clankie"',
      `printf '%s' ${posixQuote(json)} > "$HOME/.clankie/link.json.tmp"`,
      'mv -f "$HOME/.clankie/link.json.tmp" "$HOME/.clankie/link.json"',
    ].join("\n"),
  );
}

/** One fleet's supervised link: the reverse forward, then the link file naming it. */
class FleetLink {
  private child: ChildProcess | undefined;
  private current: FleetLinkState = { state: "starting", since: new Date().toISOString() };
  private closed = false;
  private backoff = RESTART_MIN_MS;
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly token = randomBytes(32).toString("base64url");
  readonly fleet: HerdrFleet;
  private readonly options: {
    readonly localPort: number;
    readonly shell: FleetShellRun;
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
    if (this.closed || this.child !== undefined) return;
    this.current = { state: "starting", since: new Date().toISOString() };
    const child = (this.options.spawn ?? spawn)("ssh", linkSshArgs(this.fleet, this.options.localPort), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    this.child = child;
    let stderr = "";
    let port: number | undefined;
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
      const allocated = /Allocated port (\d+) for remote forward/u.exec(stderr);
      if (port !== undefined || allocated === null) return;
      port = Number(allocated[1]);
      const file: FleetLinkFile = {
        schemaVersion: 1,
        fleet: this.fleet.id,
        url: `http://127.0.0.1:${String(port)}`,
        token: this.token,
      };
      void this.options
        .shell(writeLinkFileCommand(this.fleet, file))
        .then(() => {
          if (this.child !== child) return;
          this.backoff = RESTART_MIN_MS;
          this.current = { state: "ready", since: new Date().toISOString(), port: port! };
          this.options.log?.(`fleet ${this.fleet.id}: link ready on its port ${String(port)}`);
        })
        .catch((error: unknown) => {
          // A link nobody there can find is not a link; drop it and retry.
          stderr = `could not write the link file: ${error instanceof Error ? error.message : String(error)}`;
          child.kill();
        });
    });
    child.on("error", (error) => this.lost(child, error.message));
    child.on("exit", (code, signal) =>
      this.lost(child, stderr.trim().split("\n").at(-1) || `ssh exited (${String(code ?? signal)})`),
    );
  }

  close(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.child?.kill();
    this.child = undefined;
  }

  private lost(child: ChildProcess, error: string): void {
    if (this.child !== child) return;
    this.child = undefined;
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
    readonly spawn?: typeof spawn;
    readonly log?: (message: string) => void;
  };

  constructor(options: FleetLinks["options"]) {
    this.options = options;
  }

  /** Link each fleet to the restricted listener on `localPort`. */
  start(fleets: readonly HerdrFleet[], localPort: number): void {
    for (const fleet of fleets) {
      if (this.links.has(fleet.id)) continue;
      const link = new FleetLink(fleet, {
        localPort,
        shell: this.options.shell(fleet),
        ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
        ...(this.options.log === undefined ? {} : { log: this.options.log }),
      });
      this.links.set(fleet.id, link);
      link.start();
    }
  }

  /** The fleet a link token belongs to, compared in constant time. */
  authenticate(token: string): string | undefined {
    const presented = Buffer.from(token);
    for (const link of this.links.values()) {
      const expected = Buffer.from(link.token);
      if (expected.length === presented.length && timingSafeEqual(expected, presented)) return link.fleet.id;
    }
    return undefined;
  }

  status(fleet: string): FleetLinkState | undefined {
    return this.links.get(fleet)?.status();
  }

  close(): void {
    for (const link of this.links.values()) link.close();
    this.links.clear();
  }
}
