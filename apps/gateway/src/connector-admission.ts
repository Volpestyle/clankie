/**
 * Which budget a connector call spends (clankie ADR 0358). The Mac authenticates
 * every call; this doorway cannot check a connector token itself. It can only
 * remember what the Mac already vouched for in its own replies, as in-memory
 * hashes, and let that work spend a budget anonymous callers cannot reach. A lane
 * decides who waits, never what anyone may do.
 *
 * This is best-effort fairness, not flood resistance. Anonymous callers share one
 * lane, so enough of them can still hold up a new sign-in. Everything here is lost
 * on a gateway restart or when a host's connection ends, so a client's next call
 * starts anonymous again until the Mac vouches for it.
 */
import { createHash } from "node:crypto";
import {
  CONNECTOR_AUTHORIZE_PATH,
  CONNECTOR_AUTHORIZE_STATUS_PATH,
  CONNECTOR_MCP_PATH,
  CONNECTOR_TOKEN_PATH,
} from "@clankie/protocol/connector";

/** Calls the Mac has not vouched for, summed across every caller of one host. */
const ANONYMOUS_HOST_BUDGET = { capacity: 120, perSecond: 4 } as const;
/** One source's share of those calls, per host: Claude's shared addresses serve many hosts. */
const ANONYMOUS_SOURCE_BUDGET = { capacity: 60, perSecond: 2 } as const;
/** Sign-ins the Mac has opened, and the code exchange that finishes one. */
const SIGN_IN_HOST_BUDGET = { capacity: 120, perSecond: 4 } as const;
/** The sign-in page polls every two seconds. */
const SIGN_IN_SOURCE_BUDGET = { capacity: 10, perSecond: 1 } as const;
/** Tool calls and refreshes with a credential the Mac issued or accepted. */
const ESTABLISHED_HOST_BUDGET = { capacity: 240, perSecond: 8 } as const;

/** The Mac's own limit on a token request, so nothing it would accept is refused here. */
export const CONNECTOR_TOKEN_BODY_BYTES_MAX = 8 * 1024;
/** More than a status or token reply carries; a longer one teaches nothing. */
const REPLY_BYTES_MAX = 16 * 1024;
/** Outlives a sign-in page's ten minutes. */
const SIGN_IN_SOURCE_TTL_MS = 11 * 60_000;
/** Outlives an authorization code's sixty seconds. */
const SIGN_IN_CODE_TTL_MS = 2 * 60_000;
/** Outlives an access token's hour. */
const ACCESS_TOKEN_TTL_MS = 2 * 60 * 60_000;
/** A client idle longer than this starts anonymous, then the Mac vouches for it again. */
const CLIENT_TTL_MS = 7 * 24 * 60 * 60_000;
const SIGN_IN_ENTRIES_MAX = 64;
const CREDENTIAL_ENTRIES_MAX = 128;
const CLIENT_SOURCE_ENTRIES_MAX = 64;
/** The least recently taught host is forgotten first, and its calls start anonymous. */
const HOSTS_REMEMBERED_MAX = 512;

/** One held read, not delivery end to end: a caller can wait behind others and retry. */
export const CONNECTOR_TOKEN_READ_DEADLINE_MS = 3_000;
/** Token forms being read at once, across every host, before the reserve below. */
const TOKEN_READS_MAX = 64;
/** More reads, only for sources the Mac vouched for: their refreshes come this way. */
const TOKEN_READS_RESERVED = 16;
const TOKEN_READS_PER_SOURCE = 4;
/** Starting a read, for a source the Mac has not vouched for. */
const TOKEN_READ_SOURCE_BUDGET = { capacity: 20, perSecond: 1 } as const;

interface Budget {
  readonly capacity: number;
  readonly perSecond: number;
}

type TakeConnectorBudget = (key: string, capacity: number, perSecond: number) => boolean;

/** The caller, as far as the doorway can tell before spending anything. */
interface ConnectorCall {
  readonly hostId: string;
  /** The route without its query. */
  readonly path: string;
  /** The client's address block, so one IPv6 /64 is one source. */
  readonly source: string;
  readonly authorization: string | undefined;
  /** The token request's form, read first because the credential is inside it. */
  readonly tokenBody: Buffer | undefined;
  readonly contentType: string | undefined;
}

interface ConnectorAdmission {
  /** Null when refused; otherwise reads the Mac's reply to this call. */
  admit(call: ConnectorCall): ConnectorReplyObserver | null;
  /**
   * Room to read a token form before any lane can be chosen, or null. The caller
   * calls the returned function once the read ends, however it ends.
   */
  beginTokenRead(hostId: string, source: string): (() => void) | null;
  /** The host's connection ended. Its clients start anonymous; the Mac is unaffected. */
  forgetHost(hostId: string): void;
  /** Drops what has expired. */
  sweep(): void;
}

export interface ConnectorReplyObserver {
  start(status: number): void;
  chunk(buffer: Buffer): void;
  end(): void;
}

interface HostMemory {
  /** Sources the Mac opened a sign-in page for, by address. */
  readonly signInSources: Map<string, number>;
  /** Authorization codes the Mac released to a sign-in page, by hash. */
  readonly signInCodes: Map<string, number>;
  /** Access and refresh tokens the Mac issued or accepted, by hash. */
  readonly credentials: Map<string, number>;
  /** Sources that presented or received those, by address. */
  readonly clientSources: Map<string, number>;
}

export function createConnectorAdmission(
  takeHostBudget: TakeConnectorBudget,
  takeSourceBudget: TakeConnectorBudget,
  clock: () => number,
): ConnectorAdmission {
  const hosts = new Map<string, HostMemory>();
  const readsBySource = new Map<string, number>();
  let tokenReads = 0;

  /** For learning only, so a call the Mac vouched for nothing about adds no host. */
  function memoryFor(hostId: string): HostMemory {
    const memory = hosts.get(hostId) ?? {
      signInSources: new Map(),
      signInCodes: new Map(),
      credentials: new Map(),
      clientSources: new Map(),
    };
    hosts.delete(hostId);
    hosts.set(hostId, memory);
    if (hosts.size > HOSTS_REMEMBERED_MAX) hosts.delete(hosts.keys().next().value!);
    return memory;
  }

  function rememberClient(hostId: string, source: string): void {
    remember(memoryFor(hostId).clientSources, source, CLIENT_TTL_MS, CLIENT_SOURCE_ENTRIES_MAX);
  }

  function known(entries: Map<string, number> | undefined, key: string | undefined): boolean {
    return key !== undefined && (entries?.get(key) ?? 0) > clock();
  }

  /** The oldest goes first: only what the Mac vouched for ever gets in. */
  function remember(entries: Map<string, number>, key: string, ttlMs: number, max: number): void {
    entries.delete(key);
    entries.set(key, clock() + ttlMs);
    if (entries.size > max) entries.delete(entries.keys().next().value!);
  }

  function takeLane(hostId: string, lane: string, budget: Budget): boolean {
    return takeHostBudget(`${lane}:${hostId}`, budget.capacity, budget.perSecond);
  }

  /**
   * The source pays first, so a call its own budget refuses spends nothing shared.
   * One key per source: a sign-in's polls reuse the entry its page made, so they
   * keep working when a flood of new sources has filled the table.
   */
  function takeSource(call: ConnectorCall, budget: Budget): boolean {
    return takeSourceBudget(`${call.hostId}:${call.source}`, budget.capacity, budget.perSecond);
  }

  function takeAnonymous(call: ConnectorCall): boolean {
    return (
      takeSource(call, ANONYMOUS_SOURCE_BUDGET) && takeLane(call.hostId, "anonymous", ANONYMOUS_HOST_BUDGET)
    );
  }

  function admitMcp(call: ConnectorCall, memory: HostMemory | undefined): ConnectorReplyObserver | null {
    const bearer = bearerHash(call.authorization);
    const admitted = known(memory?.credentials, bearer)
      ? takeLane(call.hostId, "established", ESTABLISHED_HOST_BUDGET)
      : takeAnonymous(call);
    if (!admitted) return null;
    return bearer === undefined ? silentObserver : mcpObserver(call, bearer);
  }

  /**
   * A contract with the relay: `/mcp` answers 2xx only after authenticating the
   * bearer. Anything else may come before the Mac checked it, so it proves nothing.
   */
  function mcpObserver({ hostId, source }: ConnectorCall, bearer: string): ConnectorReplyObserver {
    return {
      ...silentObserver,
      start(status) {
        if (status === 401 || status === 403) hosts.get(hostId)?.credentials.delete(bearer);
        else if (status >= 200 && status < 300) {
          remember(memoryFor(hostId).credentials, bearer, ACCESS_TOKEN_TTL_MS, CREDENTIAL_ENTRIES_MAX);
          rememberClient(hostId, source);
        }
      },
    };
  }

  function admitToken(call: ConnectorCall, memory: HostMemory | undefined): ConnectorReplyObserver | null {
    const form = tokenForm(call.tokenBody, call.contentType);
    const code = secretHash(form?.get("code"));
    const refresh = secretHash(form?.get("refresh_token"));
    const admitted = known(memory?.signInCodes, code)
      ? takeLane(call.hostId, "sign-in", SIGN_IN_HOST_BUDGET)
      : known(memory?.credentials, refresh)
        ? takeLane(call.hostId, "established", ESTABLISHED_HOST_BUDGET)
        : takeAnonymous(call);
    if (!admitted) return null;
    return replyReader((status, reply) => {
      // Codes are single use and refresh tokens rotate, so any verdict retires
      // them. A 5xx is no verdict, and the client may retry the same one.
      if (status >= 500) return;
      const presented = hosts.get(call.hostId);
      if (code !== undefined) presented?.signInCodes.delete(code);
      if (refresh !== undefined) presented?.credentials.delete(refresh);
      if (status !== 200) return;
      const tokens = jsonObject(reply);
      const credentials = memoryFor(call.hostId).credentials;
      const access = secretHash(tokens?.access_token);
      const next = secretHash(tokens?.refresh_token);
      if (access !== undefined) remember(credentials, access, ACCESS_TOKEN_TTL_MS, CREDENTIAL_ENTRIES_MAX);
      if (next !== undefined) remember(credentials, next, CLIENT_TTL_MS, CREDENTIAL_ENTRIES_MAX);
      if (access !== undefined || next !== undefined) rememberClient(call.hostId, call.source);
    });
  }

  function admitStatus(call: ConnectorCall, memory: HostMemory | undefined): ConnectorReplyObserver | null {
    const admitted = known(memory?.signInSources, call.source)
      ? takeSource(call, SIGN_IN_SOURCE_BUDGET) && takeLane(call.hostId, "sign-in", SIGN_IN_HOST_BUDGET)
      : takeAnonymous(call);
    if (!admitted) return null;
    return replyReader((status, reply) => {
      if (status !== 200) return;
      const decision = jsonObject(reply);
      if (decision?.status !== "approved" || typeof decision.redirect !== "string") return;
      const code = secretHash(redirectCode(decision.redirect));
      if (code === undefined) return;
      remember(memoryFor(call.hostId).signInCodes, code, SIGN_IN_CODE_TTL_MS, SIGN_IN_ENTRIES_MAX);
    });
  }

  function admitAuthorize(call: ConnectorCall): ConnectorReplyObserver | null {
    if (!takeAnonymous(call)) return null;
    return {
      ...silentObserver,
      start(status) {
        if (status !== 200) return;
        const sources = memoryFor(call.hostId).signInSources;
        remember(sources, call.source, SIGN_IN_SOURCE_TTL_MS, SIGN_IN_ENTRIES_MAX);
      },
    };
  }

  return {
    admit(call) {
      const memory = hosts.get(call.hostId);
      if (call.path === CONNECTOR_MCP_PATH) return admitMcp(call, memory);
      if (call.path === CONNECTOR_TOKEN_PATH) return admitToken(call, memory);
      if (call.path === CONNECTOR_AUTHORIZE_STATUS_PATH) return admitStatus(call, memory);
      if (call.path === CONNECTOR_AUTHORIZE_PATH) return admitAuthorize(call);
      return takeAnonymous(call) ? silentObserver : null;
    },
    beginTokenRead(hostId, source) {
      const key = `${hostId}:${source}`;
      const vouched = known(hosts.get(hostId)?.clientSources, source);
      const reading = readsBySource.get(key) ?? 0;
      if (reading >= TOKEN_READS_PER_SOURCE) return null;
      if (tokenReads >= TOKEN_READS_MAX + (vouched ? TOKEN_READS_RESERVED : 0)) return null;
      const { capacity, perSecond } = TOKEN_READ_SOURCE_BUDGET;
      if (!vouched && !takeSourceBudget(`read:${key}`, capacity, perSecond)) return null;
      tokenReads += 1;
      readsBySource.set(key, reading + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        tokenReads -= 1;
        const left = (readsBySource.get(key) ?? 1) - 1;
        if (left === 0) readsBySource.delete(key);
        else readsBySource.set(key, left);
      };
    },
    forgetHost(hostId) {
      hosts.delete(hostId);
    },
    sweep() {
      const now = clock();
      for (const [hostId, memory] of hosts) {
        const tables = [memory.signInSources, memory.signInCodes, memory.credentials, memory.clientSources];
        for (const entries of tables) {
          for (const [key, expiresAtMs] of entries) if (expiresAtMs <= now) entries.delete(key);
        }
        if (tables.every((entries) => entries.size === 0)) hosts.delete(hostId);
      }
    },
  };
}

const silentObserver: ConnectorReplyObserver = {
  start: () => undefined,
  chunk: () => undefined,
  end: () => undefined,
};

/** Keeps a bounded copy of a small reply; the caller's stream is unaffected. */
function replyReader(read: (status: number, reply: Buffer) => void): ConnectorReplyObserver {
  let status = 0;
  let length = 0;
  const chunks: Buffer[] = [];
  return {
    start(value) {
      status = value;
    },
    chunk(buffer) {
      length += buffer.byteLength;
      if (length <= REPLY_BYTES_MAX) chunks.push(buffer);
    },
    end() {
      if (length <= REPLY_BYTES_MAX) read(status, Buffer.concat(chunks));
    },
  };
}

function jsonObject(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** As the Mac reads it: an unknown type or a malformed form names no credential. */
function tokenForm(body: Buffer | undefined, type = ""): URLSearchParams | undefined {
  // Not Buffer.toString, which keeps a leading byte order mark that the Mac's parsers drop.
  const text = new TextDecoder().decode(body);
  if (type.startsWith("application/x-www-form-urlencoded")) return new URLSearchParams(text);
  if (!type.startsWith("application/json")) return undefined;
  const fields = jsonObject(Buffer.from(text));
  if (fields === undefined) return undefined;
  return new URLSearchParams(
    Object.entries(fields).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
  );
}

function redirectCode(redirect: string): string | null {
  try {
    return new URL(redirect).searchParams.get("code");
  } catch {
    return null;
  }
}

function bearerHash(header: string | undefined): string | undefined {
  return header?.startsWith("Bearer ") === true ? secretHash(header.slice(7).trim()) : undefined;
}

/** Only a hash is held, so this memory can't be replayed as a credential. */
function secretHash(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return createHash("sha256").update(value).digest("base64url");
}
