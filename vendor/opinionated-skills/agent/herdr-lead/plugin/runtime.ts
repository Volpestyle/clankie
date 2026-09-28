import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ColorName, HerdrSnapshot, Pane, RpcResponse, ShellResult, Theme } from "./types.ts";

const HOME = os.homedir();
const SOCKET = process.env.HERDR_SOCKET_PATH || path.join(HOME, ".config/herdr/herdr.sock");
const CONFIG = path.join(HOME, ".config/herdr/config.toml");
const RPC_TIMEOUT = envInt(process.env.HERD_LEAD_RPC_TIMEOUT_MS, 10_000);

export function envInt(value: string | undefined, fallback: number, minimum = 1): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export function readJson<T>(file: string, fallback: T): T {
  try { return (JSON.parse(fs.readFileSync(file, "utf8")) as T | null) ?? fallback; } catch { return fallback; }
}

export function writeJson(file: string, value: unknown, space?: number): boolean {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(value, null, space));
    fs.renameSync(temporary, file);
    return true;
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
    return false;
  }
}

export function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<RpcResponse<T>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let buffer = "";
    let settled = false;
    const finish = <V>(fn: (value: V) => void, value: V) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`${method} timed out after ${RPC_TIMEOUT}ms`)),
      RPC_TIMEOUT,
    );
    socket.on("connect", () => socket.write(`${JSON.stringify({ id: "rpc", method, params })}\n`));
    socket.on("data", (data) => {
      buffer += data;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try { finish(resolve, JSON.parse(buffer.slice(0, end)) as RpcResponse<T>); }
      catch (error) { finish(reject, error); }
    });
    socket.on("error", (error) => finish(reject, error));
    socket.on("close", () => {
      if (!settled) finish(reject, new Error(`${method} closed before returning a response`));
    });
  });
}

export const BOARD_LABEL = "Herd Lead";

export function boardPane(panes: Pane[], exclude = ""): string {
  return panes.find((p) => p.label === BOARD_LABEL && p.pane_id !== exclude)?.pane_id || "";
}

export async function findBoardPane(exclude = ""): Promise<string> {
  const snap = (await rpc<{ snapshot?: HerdrSnapshot }>("session.snapshot", {})).result?.snapshot;
  return boardPane(snap?.panes || [], exclude);
}

export function subscribe(kinds: string[], onEvent: (event: unknown) => void): () => void {
  let socket: net.Socket | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  let closed = false;
  const connect = () => {
    const connection = net.createConnection(SOCKET);
    socket = connection;
    let buffer = "";
    connection.on("connect", () => connection.write(`${JSON.stringify({
      id: "sub",
      method: "events.subscribe",
      params: { subscriptions: kinds },
    })}\n`));
    connection.on("data", (data) => {
      buffer += data;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { onEvent(JSON.parse(line)); } catch {}
      }
    });
    const retry = () => {
      if (closed || socket !== connection || retryTimer) return;
      connection.destroy();
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, 1000);
      retryTimer.unref();
    };
    connection.on("error", retry);
    connection.on("close", retry);
  };
  connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    socket?.destroy();
  };
}

type Rgb = [number, number, number];

const PALETTES: Record<string, Record<ColorName, Rgb>> = {
  catppuccin: {
    base: [30, 30, 46], surface: [49, 50, 68], overlay: [108, 112, 134],
    text: [205, 214, 244], subtext: [166, 173, 200],
    red: [243, 139, 168], peach: [250, 179, 135], yellow: [249, 226, 175],
    green: [166, 227, 161], teal: [148, 226, 213], blue: [137, 180, 250],
    mauve: [203, 166, 247], lavender: [180, 190, 254],
  },
  "tokyo-night": {
    base: [26, 27, 38], surface: [41, 46, 66], overlay: [86, 95, 137],
    text: [192, 202, 245], subtext: [154, 165, 206],
    red: [247, 118, 142], peach: [255, 158, 100], yellow: [224, 175, 104],
    green: [158, 206, 106], teal: [125, 207, 255], blue: [122, 162, 247],
    mauve: [187, 154, 247], lavender: [180, 249, 248],
  },
  gruvbox: {
    base: [40, 40, 40], surface: [60, 56, 54], overlay: [124, 111, 100],
    text: [235, 219, 178], subtext: [189, 174, 147],
    red: [251, 73, 52], peach: [254, 128, 25], yellow: [250, 189, 47],
    green: [184, 187, 38], teal: [142, 192, 124], blue: [131, 165, 152],
    mauve: [211, 134, 155], lavender: [211, 134, 155],
  },
};

function resolvePalette(): { name: string; palette: Record<ColorName, Rgb> } {
  let name = "catppuccin";
  try {
    const raw = fs.readFileSync(CONFIG, "utf8");
    const match = raw.match(/^\s*name\s*=\s*"([^"]+)"/m);
    if (match?.[1]) name = match[1];
  } catch {}
  const palette = PALETTES[name]
    || PALETTES[name.replace(/-(latte|day|light|dawn|lotus)$/, "")]
    || PALETTES.catppuccin!;
  return { name, palette };
}

export function paletteHex(): { name: string; colors: Record<ColorName, string> } {
  const { name, palette } = resolvePalette();
  const colors = {} as Record<ColorName, string>;
  for (const [key, [r, g, b]] of Object.entries(palette)) {
    colors[key as ColorName] = `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  return { name, colors };
}

export function loadTheme(): Theme {
  const { name, palette } = resolvePalette();
  const foreground = ([red, green, blue]: Rgb) => (value: string) =>
    `\x1b[38;2;${red};${green};${blue}m${value}\x1b[39m`;
  const background = ([red, green, blue]: Rgb) => (value: string) =>
    `\x1b[48;2;${red};${green};${blue}m${value}\x1b[49m`;
  const theme = {} as Theme;
  for (const [key, value] of Object.entries(palette)) theme[key as ColorName] = foreground(value);
  theme.on = {} as Theme["on"];
  for (const [key, value] of Object.entries(palette)) theme.on[key as ColorName] = background(value);
  theme.bold = (value: string) => `\x1b[1m${value}\x1b[22m`;
  theme.dim = (value: string) => `\x1b[2m${value}\x1b[22m`;
  theme.themeName = name;
  return theme;
}

export function shOut(cmd: string, args: string[], cwd?: string): Promise<ShellResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1 << 24,
      timeout: 30_000,
    }, (error, stdout, stderr) =>
      resolve({
        ok: !error,
        out: (stdout || "").toString().trim(),
        err: (stderr || "").toString().trim() || (error ? error.message : ""),
      }));
  });
}

export function coalesceAsync(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let rerun = false;
  return () => {
    rerun = true;
    running ||= (async () => {
      do {
        rerun = false;
        await task();
      } while (rerun);
    })().finally(() => { running = null; });
    return running;
  };
}
