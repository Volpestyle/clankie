import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
  OPERATOR_CONVERSATION_REF_MAX,
  type OperatorTerminalObservationUnavailable,
  type OperatorTerminalSession,
} from "@clankie/protocol";
import { DESKTOP_SEAT_FLEET } from "../herdr-fleet.ts";
import type { HerdrPaneGrid } from "./herdr-census.ts";
import { SEAT_LABEL, desktopTerminalAgent, herdrCoreCall } from "./herdr-core.ts";
import type { HerdrTerminalObserver } from "./herdr-terminal.ts";

// The Herdr desktop app's terminals (herdr-core, ADR 0319) as the operator terminal
// catalog lists them, beside the terminal Herdr's panes: its spaces, tabs and terminals
// as workspaces, tabs and panes, named as the app names them. Observing one attaches to
// the core as a watch-only viewer (`observe`: it never types or resizes), so the owner's
// phone sees it the way it sees a Herdr pane. The desktop app keeps its layout in the
// core's `herdr-app` document and writes each terminal's place in words as its `where`
// label (`<space> / <tab>`); both are read, never written.

/** The runtime the catalog names the desktop app's terminals under. */
const DESKTOP_TERMINAL_RUNTIME = { id: DESKTOP_SEAT_FLEET, session: "Herdr app" } as const;
const LAYOUT_DOC = "herdr-app";
const PREFIX = `${DESKTOP_SEAT_FLEET}/`;
const LABEL_MAX = 200;
const ATTACH_MS = 5_000;
/** Scrollback the first paint carries, as a Herdr pane's observer seeds it. */
const HISTORY_LINES = 1_000;
/** Output is gathered this long into one frame, so a busy agent isn't hundreds of tiny frames. */
const COALESCE_MS = 16;
const FRAME_BYTES_MAX = 1024 * 1024;

/** A desktop-app terminal's address from its catalog id (`herdr-core/t7` → `t7`); this Mac's only. */
export function desktopTerminalAddress(terminalId: string): string | undefined {
  if (!terminalId.startsWith(PREFIX)) return undefined;
  const address = terminalId.slice(PREFIX.length);
  return /^t[0-9a-z]{1,16}$/u.test(address) ? address : undefined;
}

interface LayoutNode {
  readonly content?: { readonly terminal?: unknown } | null;
  readonly children?: unknown;
}
interface LayoutTab {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly root?: unknown;
}
interface LayoutSpace {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly folder?: unknown;
  readonly tabs?: unknown;
}

/** The live terminals in the desktop app's window, in its own space → tab → pane order. */
export async function readHerdrCoreCatalog(
  socketPath: string,
  options: { readonly seatIds?: boolean } = {},
): Promise<OperatorTerminalSession[]> {
  let spaces: readonly LayoutSpace[];
  let records: Map<string, Record<string, unknown>>;
  try {
    const [doc, listed] = await Promise.all([
      herdrCoreCall(socketPath, "doc.get", { name: LAYOUT_DOC }) as Promise<{
        value?: { spaces?: unknown } | null;
      }>,
      herdrCoreCall(socketPath, "terminal.list", {}) as Promise<{ terminals?: unknown }>,
    ]);
    spaces = Array.isArray(doc.value?.spaces) ? (doc.value.spaces as LayoutSpace[]) : [];
    records = new Map(
      (Array.isArray(listed.terminals) ? (listed.terminals as unknown[]) : []).flatMap((value) => {
        if (value === null || typeof value !== "object") return [];
        const record = value as Record<string, unknown>;
        return typeof record.address === "string" && record.state === "live"
          ? [[record.address, record] as const]
          : [];
      }),
    );
  } catch {
    return [];
  }
  // The window's layout as the app last saved it, then the terminals it has adopted since:
  // a terminal labeled `herdr.space`/`herdr.tab` is shown in that space and tab even before
  // the app writes its document again.
  const layout = spaces.flatMap((space) =>
    usableId(space.id)
      ? [
          {
            id: space.id,
            name: nonEmpty(space.name),
            folder: space.folder,
            tabs: (Array.isArray(space.tabs) ? (space.tabs as LayoutTab[]) : []).flatMap((tab) =>
              usableId(tab.id)
                ? [{ id: tab.id, name: nonEmpty(tab.name), addresses: terminalsIn(tab.root) }]
                : [],
            ),
          },
        ]
      : [],
  );
  const shown = new Set(layout.flatMap((space) => space.tabs.flatMap((tab) => tab.addresses)));
  for (const [address, record] of records) {
    const spaceId = labelOf(record, "herdr.space");
    // Only this Mac's own terminals; another machine's (`rohan/t7`) aren't listed yet.
    if (shown.has(address) || !/^t[0-9a-z]{1,16}$/u.test(address)) continue;
    if (spaceId === undefined || !usableId(spaceId)) continue;
    let space = layout.find((candidate) => candidate.id === spaceId);
    if (space === undefined) {
      space = { id: spaceId, name: undefined, folder: record.cwd, tabs: [] };
      layout.push(space);
    }
    const tabId = labelOf(record, "herdr.tab") ?? `${spaceId}:${address}`;
    let tab = space.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) {
      tab = { id: tabId, name: undefined, addresses: [] };
      space.tabs.push(tab);
    }
    tab.addresses.push(address);
    shown.add(address);
  }
  const sessions: OperatorTerminalSession[] = [];
  layout.forEach((space, spaceIndex) => {
    const placed = space.tabs.map((tab, tabIndex) => ({
      tab,
      number: tabIndex + 1,
      name: tab.name ?? String(tabIndex + 1),
      terminals: tab.addresses.flatMap((address) => {
        const record = records.get(address);
        return record === undefined ? [] : [{ address, record }];
      }),
    }));
    const spaceName = space.name ?? spaceNameFromWhere(placed) ?? folderName(space.folder);
    for (const { tab, number, name, terminals } of placed) {
      for (const { address, record } of terminals) {
        const terminalId = `${PREFIX}${address}`;
        const agent = desktopTerminalAgent(record);
        sessions.push({
          runtime: DESKTOP_TERMINAL_RUNTIME,
          terminalId,
          label: paneLabel(record, agent),
          workspace: { id: space.id, label: bounded(spaceName), number: spaceIndex + 1 },
          tab: { id: tab.id, label: bounded(name), number },
          pane: { id: terminalId },
          ...(agent === undefined ? {} : { agent: agent.slice(0, 128) }),
          // A desktop seat's id is its terminal's (`herdr-core/<address>`, ADR 0319).
          ...(options.seatIds === true ? { seatId: terminalId } : {}),
        });
      }
    }
  });
  return sessions;
}

/** The terminal's own grid, so its observer paints at the size it really is. */
export async function readHerdrCoreGrid(
  socketPath: string,
  address: string,
): Promise<HerdrPaneGrid | undefined> {
  try {
    const record = (await herdrCoreCall(socketPath, "terminal.get", { terminal: address })) as {
      cols?: unknown;
      rows?: unknown;
    };
    return dimension(record.cols) !== undefined && dimension(record.rows) !== undefined
      ? { columns: dimension(record.cols)!, rows: dimension(record.rows)! }
      : undefined;
  } catch {
    return undefined;
  }
}

type UnavailableReason = OperatorTerminalObservationUnavailable["reason"];

const DATA = 0;
const CREDIT = 1;
const CLOSE = 2;

/**
 * A watch-only attach to one desktop-app terminal, as the lines a Herdr pane's observer
 * prints: the core's first paint (history, then the screen) as one full frame, then its
 * output as diffs. Framed mode: `[channel u32 LE][kind u8][len u32 LE][payload]`; every
 * byte read is credited back at once, so the stream never stalls on this viewer.
 */
export function startHerdrCoreObserver(
  socketPath: string,
  address: string,
  columns: number,
  rows: number,
): HerdrTerminalObserver {
  const queue: string[] = [];
  let waiting: (() => void) | undefined;
  let reason: UnavailableReason | undefined;
  let resolveDone: (reason: UnavailableReason) => void = () => {};
  const done = new Promise<UnavailableReason>((resolve) => (resolveDone = resolve));
  const socket = createConnection(socketPath);
  let buffered = Buffer.alloc(0);
  let framed = false;
  let channel: number | undefined;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const attachTimer = setTimeout(() => end("herdr_unavailable"), ATTACH_MS);
  attachTimer.unref?.();

  const wake = () => {
    const resolve = waiting;
    waiting = undefined;
    resolve?.();
  };
  const flush = () => {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (pendingBytes === 0) return;
    const bytes = Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    sequence += 1;
    queue.push(
      JSON.stringify({
        type: "terminal.frame",
        seq: sequence,
        encoding: "ansi",
        width: columns,
        height: rows,
        full: sequence === 1,
        bytes: bytes.toString("base64"),
      }),
    );
    wake();
  };
  const end = (why: UnavailableReason, graceful = false) => {
    if (reason !== undefined) return;
    clearTimeout(attachTimer);
    flush();
    reason = why;
    if (graceful) socket.end();
    else socket.destroy();
    resolveDone(why);
    wake();
  };
  const send = (to: number, kind: number, payload: Buffer) => {
    const header = Buffer.alloc(9);
    header.writeUInt32LE(to, 0);
    header.writeUInt8(kind, 4);
    header.writeUInt32LE(payload.length, 5);
    socket.write(Buffer.concat([header, payload]));
  };
  const onRpc = (message: { id?: unknown; result?: { channel?: unknown }; error?: unknown }) => {
    if (message.id !== 2) return;
    if (message.error !== undefined || typeof message.result?.channel !== "number")
      return end("terminal_unavailable");
    channel = message.result.channel;
    clearTimeout(attachTimer);
  };

  socket.on("connect", () => {
    socket.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { generation: 1, framed: true } })}\n`,
    );
  });
  socket.on("error", () => end("herdr_unavailable"));
  socket.on("close", () => end(channel === undefined ? "herdr_unavailable" : "observer_closed"));
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (!framed) {
      const newline = buffered.indexOf(0x0a);
      if (newline < 0) return;
      let hello: { result?: { methods?: unknown; features?: unknown } };
      try {
        hello = JSON.parse(buffered.subarray(0, newline).toString("utf8")) as typeof hello;
      } catch {
        return end("herdr_unavailable");
      }
      buffered = buffered.subarray(newline + 1);
      const methods = hello.result?.methods;
      if (!Array.isArray(methods) || !methods.includes("terminal.attach")) return end("herdr_unavailable");
      framed = true;
      const attach = {
        jsonrpc: "2.0",
        id: 2,
        method: "terminal.attach",
        params: { terminal: address, cols: columns, rows, observe: true, history: HISTORY_LINES },
      };
      send(0, DATA, Buffer.from(JSON.stringify(attach)));
    }
    while (buffered.length >= 9) {
      const from = buffered.readUInt32LE(0);
      const kind = buffered.readUInt8(4);
      const length = buffered.readUInt32LE(5);
      if (buffered.length < 9 + length) return;
      const payload = buffered.subarray(9, 9 + length);
      buffered = buffered.subarray(9 + length);
      if (from === 0 && kind === DATA) {
        try {
          onRpc(JSON.parse(payload.toString("utf8")) as Parameters<typeof onRpc>[0]);
        } catch {
          return end("herdr_unavailable");
        }
      } else if (channel !== undefined && from === channel) {
        if (kind === CLOSE) return end("terminal_unavailable");
        if (kind !== DATA || payload.length === 0) continue;
        pending.push(Buffer.from(payload));
        pendingBytes += payload.length;
        const credit = Buffer.alloc(4);
        credit.writeUInt32LE(payload.length, 0);
        send(channel, CREDIT, credit);
        if (pendingBytes >= FRAME_BYTES_MAX) flush();
        else if (flushTimer === undefined) {
          flushTimer = setTimeout(flush, COALESCE_MS);
          flushTimer.unref?.();
        }
      }
    }
  });

  return {
    lines: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const line = queue.shift();
          if (line !== undefined) {
            yield line;
            continue;
          }
          if (reason !== undefined) return;
          await new Promise<void>((resolve) => (waiting = resolve));
        }
      },
    },
    done,
    close: () => {
      if (reason !== undefined) return;
      if (channel !== undefined && socket.writable) send(channel, CLOSE, Buffer.alloc(0));
      end("observer_closed", true);
    },
  };
}

function terminalsIn(node: unknown): string[] {
  if (node === null || typeof node !== "object") return [];
  const { content, children } = node as LayoutNode;
  const own =
    typeof content?.terminal === "string" && /^t[0-9a-z]{1,16}$/u.test(content.terminal)
      ? [content.terminal]
      : [];
  return [...own, ...(Array.isArray(children) ? children.flatMap(terminalsIn) : [])];
}

/** The space's name in the app's own words: its terminals' `where` label, `<space> / <tab>`. */
function spaceNameFromWhere(
  tabs: readonly {
    readonly name: string;
    readonly terminals: readonly { readonly record: Record<string, unknown> }[];
  }[],
): string | undefined {
  for (const { name, terminals } of tabs)
    for (const { record } of terminals) {
      const where = labelOf(record, "where");
      const suffix = ` / ${name}`;
      if (where?.endsWith(suffix) && where.length > suffix.length) return where.slice(0, -suffix.length);
    }
  return undefined;
}

/** What the pane is called: the seat Clankie named in it, else its title, else program and folder. */
function paneLabel(record: Record<string, unknown>, agent: string | undefined): string {
  const named = labelOf(record, SEAT_LABEL) ?? nonEmpty(record.title);
  if (named !== undefined) return bounded(named);
  const foreground =
    record.foreground !== null && typeof record.foreground === "object"
      ? (record.foreground as Record<string, unknown>)
      : {};
  const program = agent ?? programName(foreground.argv) ?? programName(record.argv) ?? "terminal";
  const folder = nonEmpty(foreground.cwd) ?? nonEmpty(record.cwd);
  return bounded(folder === undefined ? program : `${program} · ${folderName(folder)}`);
}

function labelOf(record: Record<string, unknown>, key: string): string | undefined {
  const labels = record.labels;
  return labels !== null && typeof labels === "object"
    ? nonEmpty((labels as Record<string, unknown>)[key])
    : undefined;
}

function programName(argv: unknown): string | undefined {
  if (!Array.isArray(argv) || typeof argv[0] !== "string") return undefined;
  return nonEmpty(basename(argv[0]).replace(/^-/u, ""));
}

function folderName(folder: unknown): string {
  const path = nonEmpty(folder);
  if (path === undefined) return "~";
  const home = homedir();
  return path === home || path === `${home}/` ? "~" : basename(path) || path;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function usableId(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= OPERATOR_CONVERSATION_REF_MAX
  );
}

function dimension(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 1_000
    ? value
    : undefined;
}

function bounded(value: string): string {
  return value.length > LABEL_MAX ? `${value.slice(0, LABEL_MAX - 1)}…` : value;
}
