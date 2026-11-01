import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { HerdrForegroundProcess } from "./codex-seat.ts";
import type { FleetSeatDelivery } from "./fleet-seat.ts";

// OpenCode 2's shared service (ADR 0337). A hand-opened OpenCode 2 TUI talks to
// one background server per user, registered in `service.json` with its URL,
// pid and a password for Basic auth. Herdr's OpenCode integration reports the
// pane's selected session, so a message to that pane is admitted straight into
// the session's own inbox, as steer or queue, under a client id that makes it
// idempotent. The admitted inbox item is the receipt. The password is used only
// as the request's Authorization header: it never enters a result, an error, a
// log line or a file.

const SESSION = /^ses_[A-Za-z0-9]{8,128}$/u;
const EXECUTABLES = new Set(["opencode", "opencode2", "opencode.exe"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REQUEST_MS = 5_000;

/** The id prefix of an uncertain admission, so rediscovery never sends it a second time. */
export const OPENCODE_SERVICE_ID = "opencode-service:";

export interface OpenCodeServiceRegistration {
  readonly url: URL;
  readonly pid: number;
  readonly password: string;
}

/** `$XDG_STATE_HOME/opencode/service.json`, as OpenCode's own client finds it. */
export function openCodeServicePath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(state, "opencode", "service.json");
}

/** The registration, when it names a live loopback service; undefined otherwise. */
export async function readOpenCodeService(path: string): Promise<OpenCodeServiceRegistration | undefined> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { url, pid, password } = raw as Record<string, unknown>;
  if (typeof url !== "string" || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0)
    return undefined;
  if (typeof password !== "string" || password.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  // The password only ever goes to this machine's own service.
  if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname) || parsed.username || parsed.password)
    return undefined;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined;
  }
  return { url: parsed, pid, password };
}

/**
 * The pane's OpenCode TUI when it runs on the shared service: not `--standalone`
 * and not pointed at another server with `--server`.
 */
export function sharedOpenCodeProcess(
  processes: readonly HerdrForegroundProcess[],
): HerdrForegroundProcess | undefined {
  const candidates = processes.filter((process) =>
    [process.name, process.argv0, process.argv?.[0]].some(
      (value) => value !== undefined && EXECUTABLES.has(basename(value)),
    ),
  );
  if (candidates.length !== 1) return undefined;
  const [tui] = candidates;
  const private_ = tui!.argv?.some(
    (arg) => arg === "--standalone" || arg === "--server" || arg.startsWith("--server="),
  );
  return private_ ? undefined : tui;
}

/** True when `lsof -Fn` shows the process holding a connection to the service's port. */
export function connectedToService(openFiles: string, service: OpenCodeServiceRegistration): boolean {
  const port = service.url.port || "80";
  return openFiles.split("\n").some((line) => {
    const match = /^n\S+?:\d+->(\S+):(\d+)$/u.exec(line.trim());
    return match !== null && LOOPBACK.has(match[1]!) && match[2] === port;
  });
}

export function isOpenCodeSession(value: string | undefined): value is string {
  return value !== undefined && SESSION.test(value);
}

function newMessageId(): string {
  // OpenCode's message ids are `msg_` and 8 to 128 letters or digits.
  return `msg_clankie${randomBytes(12).toString("hex")}`;
}

async function call(
  service: OpenCodeServiceRegistration,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly json: unknown }> {
  const response = await fetch(new URL(path, service.url), {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`opencode:${service.password}`).toString("base64")}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json };
}

const unavailable = (detail: string): FleetSeatDelivery => ({
  outcome: "undelivered",
  deliveryStage: "unavailable",
  detail,
});

/** Proves the registered service is the process it names, before anything is sent. */
async function serviceAnswers(service: OpenCodeServiceRegistration): Promise<boolean> {
  try {
    const info = await call(service, "GET", "/api/info");
    return info.status === 200 && (info.json as { pid?: unknown } | undefined)?.pid === service.pid;
  } catch {
    return false;
  }
}

/**
 * Admits one message into a session's inbox on the shared service. Steer is
 * OpenCode's own default. A refusal before admission sent nothing; a lost or
 * malformed answer leaves admission unknown.
 */
export async function promptOpenCodeSession(
  service: OpenCodeServiceRegistration,
  sessionId: string,
  text: string,
  delivery: "steer" | "queue" | undefined,
  beforeDispatch?: () => Promise<boolean>,
): Promise<FleetSeatDelivery> {
  if (!isOpenCodeSession(sessionId))
    return unavailable("Herdr reported no exact OpenCode session; nothing was sent.");
  if (!(await serviceAnswers(service)))
    return unavailable(
      "OpenCode's shared service didn't answer as the registered process; nothing was sent.",
    );
  let running = false;
  try {
    const active = await call(service, "GET", "/api/session/active");
    const entry = (active.json as { data?: Record<string, { type?: unknown }> } | undefined)?.data?.[
      sessionId
    ];
    running = entry !== undefined && entry.type !== "idle";
  } catch {
    // Whether a turn is running only names the receipt's state.
  }
  if (beforeDispatch && !(await beforeDispatch()))
    return {
      outcome: "undelivered",
      deliveryStage: "rejected",
      detail: "Authority changed before dispatch; nothing was sent.",
    };
  const id = newMessageId();
  let answer: Awaited<ReturnType<typeof call>>;
  try {
    answer = await call(service, "POST", `/api/session/${sessionId}/prompt`, {
      id,
      text,
      ...(delivery === undefined ? {} : { delivery }),
    });
  } catch (error) {
    const code = (error as { cause?: { code?: unknown } }).cause?.code;
    if (code === "ECONNREFUSED")
      return unavailable("OpenCode's shared service refused the connection; nothing was sent.");
    return {
      outcome: "unconfirmed",
      messageId: `${OPENCODE_SERVICE_ID}${id}`,
      detail: `OpenCode's shared service didn't answer the send (${error instanceof Error ? error.name : "error"}). Read the agent before sending it again.`,
    };
  }
  if (answer.status === 404)
    return unavailable("OpenCode's shared service doesn't hold this session; nothing was sent.");
  if (answer.status >= 400 && answer.status < 500)
    return unavailable(`OpenCode refused the message (HTTP ${String(answer.status)}); nothing was sent.`);
  const item = (
    answer.json as { data?: { id?: unknown; sessionID?: unknown; delivery?: unknown } } | undefined
  )?.data;
  if (answer.status !== 200 || item?.id !== id || item.sessionID !== sessionId)
    return {
      outcome: "unconfirmed",
      messageId: `${OPENCODE_SERVICE_ID}${id}`,
      detail: `OpenCode's shared service gave no admission receipt (HTTP ${String(answer.status)}). Read the agent before sending it again.`,
    };
  const admitted = item.delivery === "queue" ? "queue" : "steer";
  return {
    outcome: "delivered",
    messageId: id,
    state: !running ? "started" : admitted === "queue" ? "queued" : "steered",
    detail: !running
      ? "OpenCode admitted the message and started a turn."
      : admitted === "queue"
        ? "OpenCode queued the message until its current turn ends."
        : "OpenCode admitted the message into its running turn.",
  };
}
