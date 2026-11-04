/**
 * Which budget a connector call spends (clankie ADR 0358). The Mac authenticates
 * every call; this doorway cannot check a connector token itself. It can only
 * remember what the Mac already vouched for in its own replies, as in-memory
 * hashes, and let that work spend a budget anonymous callers cannot reach. A lane
 * decides who waits, never what anyone may do.
 *
 * This is best-effort fairness, not flood resistance. Anonymous callers share one
 * lane, so enough of them can still hold up a new sign-in. Everything here is lost
 * on a gateway restart, so a client's next call starts anonymous again until the
 * Mac vouches for it.
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
/** A client idle longer than this starts anonymous, then the Mac vouches for it again. */
const CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60_000;
const SIGN_IN_ENTRIES_MAX = 64;
const CREDENTIAL_ENTRIES_MAX = 256;

interface Budget {
  readonly capacity: number;
  readonly perSecond: number;
}

export type TakeConnectorBudget = (key: string, capacity: number, perSecond: number) => boolean;

/** The caller, as far as the doorway can tell before spending anything. */
export interface ConnectorCall {
  readonly hostId: string;
  /** The route without its query. */
  readonly path: string;
  readonly source: string;
  readonly authorization: string | undefined;
  /** The token request's form, read first because the credential is inside it. */
  readonly tokenBody: Buffer | undefined;
}

export interface ConnectorAdmission {
  /** Null when refused; otherwise reads the Mac's reply to this call. */
  admit(call: ConnectorCall): ConnectorReplyObserver | null;
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
}

export function createConnectorAdmission(
  takeHostBudget: TakeConnectorBudget,
  takeSourceBudget: TakeConnectorBudget,
  clock: () => number,
): ConnectorAdmission {
  const hosts = new Map<string, HostMemory>();

  function memoryFor(hostId: string): HostMemory {
    let memory = hosts.get(hostId);
    if (memory === undefined) {
      memory = { signInSources: new Map(), signInCodes: new Map(), credentials: new Map() };
      hosts.set(hostId, memory);
    }
    return memory;
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
    return bearer === undefined ? silentObserver : mcpObserver(call.hostId, bearer);
  }

  /** Only a success proves a token: anything else may come before the Mac checked it. */
  function mcpObserver(hostId: string, bearer: string): ConnectorReplyObserver {
    return {
      ...silentObserver,
      start(status) {
        if (status === 401 || status === 403) hosts.get(hostId)?.credentials.delete(bearer);
        else if (status >= 200 && status < 300)
          remember(memoryFor(hostId).credentials, bearer, CREDENTIAL_TTL_MS, CREDENTIAL_ENTRIES_MAX);
      },
    };
  }

  function admitToken(call: ConnectorCall, memory: HostMemory | undefined): ConnectorReplyObserver | null {
    const form = new URLSearchParams((call.tokenBody ?? Buffer.alloc(0)).toString("utf8"));
    const code = secretHash(form.get("code"));
    const refresh = secretHash(form.get("refresh_token"));
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
      for (const field of ["access_token", "refresh_token"]) {
        const hash = secretHash(tokens?.[field]);
        if (hash !== undefined) remember(credentials, hash, CREDENTIAL_TTL_MS, CREDENTIAL_ENTRIES_MAX);
      }
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
    sweep() {
      const now = clock();
      for (const [hostId, memory] of hosts) {
        for (const entries of [memory.signInSources, memory.signInCodes, memory.credentials]) {
          for (const [key, expiresAtMs] of entries) if (expiresAtMs <= now) entries.delete(key);
        }
        if (memory.signInSources.size + memory.signInCodes.size + memory.credentials.size === 0)
          hosts.delete(hostId);
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
