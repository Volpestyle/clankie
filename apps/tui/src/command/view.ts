import { resolve } from "node:path";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  VIEWS_PATH,
  ViewExpiredSchema,
  ViewListSchema,
  ViewRenderSchema,
  ViewRequestSchema,
  ViewResultSchema,
  viewPath,
  type FleetResourceSnapshot,
  type ViewPanel,
  type ViewRender,
  type ViewSourceData,
} from "@clankie/protocol";
import type { z } from "zod";
import { createCaptainRouteClient, type CaptainRouteFetcher } from "../session/operator-conversations.ts";
import { commandHost, type Writable } from "./io.ts";

export const VIEW_USAGE = [
  "Usage: clankie view list",
  "  | create SPEC_JSON|--stdin [--ttl HOURS|Nd] [--pin]   (temporary for 24h unless --ttl or --pin)",
  "  | show ID [--text] [--watch]   (the spec with live data; --watch re-renders text every refreshSeconds)",
  "  | pin ID | unpin ID [--ttl HOURS|Nd] | expire ID",
].join("\n");

export interface ViewCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly ownerFetcher?: CaptainRouteFetcher | undefined;
  readonly cwd?: string;
  readonly stdin?: () => Promise<string>;
}

/** The owner's view API, over the local operator bearer or an existing owner transport. */
export async function viewClient(options: ViewCommandOptions = {}) {
  let transport = options.ownerFetcher;
  if (!transport) {
    const env = options.env ?? process.env;
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (!credential) throw new Error("Views need the owner operator credential. Run clankie doctor.");
    transport = createCaptainRouteClient({
      host: commandHost(options),
      captainToken: credential.token,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  }
  const fetcher = transport;
  const call = async <T>(schema: z.ZodType<T>, path: string, body?: unknown): Promise<T> => {
    const response = await fetcher.fetch(path, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const value = (await response.json().catch(() => null)) as { error?: string; detail?: string } | null;
    if (!response.ok)
      throw new Error(
        value?.detail ?? value?.error ?? `View request failed (HTTP ${String(response.status)})`,
      );
    return schema.parse(value);
  };
  return {
    list: () => call(ViewListSchema, VIEWS_PATH),
    render: (id: string) => call(ViewRenderSchema, viewPath(id)),
    request: (body: unknown) => {
      const input = ViewRequestSchema.parse(body);
      return input.action === "expire"
        ? call(ViewExpiredSchema, VIEWS_PATH, input)
        : call(ViewResultSchema, VIEWS_PATH, input);
    },
  };
}

function ttlHours(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)\s*([hd]?)$/iu.exec(value.trim());
  if (!match) throw new Error(`--ttl takes hours (24, 48h) or days (3d)\n${VIEW_USAGE}`);
  return Number(match[1]) * (match[2]?.toLowerCase() === "d" ? 24 : 1);
}

/** Relative tracker repo paths are resolved here, where the caller's directory is known. */
function resolveRepos(spec: unknown, cwd: string): unknown {
  if (typeof spec !== "object" || spec === null || !("sources" in spec)) return spec;
  const sources = (spec as { sources: unknown }).sources;
  if (typeof sources !== "object" || sources === null) return spec;
  return {
    ...spec,
    sources: Object.fromEntries(
      Object.entries(sources).map(([id, source]) => {
        const repo = (source as { repo?: unknown } | null)?.repo;
        return [
          id,
          typeof repo === "string" && /^\.\.?(?:\/|$)/u.test(repo)
            ? { ...source, repo: resolve(cwd, repo) }
            : source,
        ];
      }),
    ),
  };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      done();
    });
  });

/** `clankie view …`: JSON out except `show --text`/`--watch`, which print the rendered board. */
export async function runViewCommand(
  args: readonly string[],
  options: ViewCommandOptions & { stdout?: Writable; signal?: AbortSignal } = {},
): Promise<unknown> {
  const flags = new Set(args.filter((arg) => ["--pin", "--text", "--watch", "--stdin"].includes(arg)));
  const ttlIndex = args.indexOf("--ttl");
  const ttl = ttlHours(ttlIndex === -1 ? undefined : args[ttlIndex + 1]);
  const positional = args.filter(
    (arg, index) => !flags.has(arg) && arg !== "--ttl" && (ttlIndex === -1 || index !== ttlIndex + 1),
  );
  const [verb = "list", target, ...extra] = positional;
  if (extra.length > 0) throw new Error(VIEW_USAGE);
  const client = await viewClient(options);
  switch (verb) {
    case "list":
      return client.list();
    case "create": {
      const raw = flags.has("--stdin") ? await (options.stdin ?? readStdin)() : target;
      if (raw === undefined) throw new Error(VIEW_USAGE);
      let spec: unknown;
      try {
        spec = JSON.parse(raw);
      } catch {
        throw new Error("The view spec must be JSON");
      }
      const { view } = (await client.request({
        action: "create",
        spec: resolveRepos(spec, options.cwd ?? process.cwd()),
        ...(ttl === undefined ? {} : { ttlHours: ttl }),
        ...(flags.has("--pin") ? { pin: true } : {}),
      })) as z.infer<typeof ViewResultSchema>;
      // Render once so a source that cannot be read shows up now, not on first look.
      return { view, render: await client.render(view.id) };
    }
    case "show": {
      if (target === undefined) throw new Error(VIEW_USAGE);
      if (!flags.has("--text") && !flags.has("--watch")) return client.render(target);
      const stdout = options.stdout ?? process.stdout;
      do {
        const render = await client.render(target);
        if (flags.has("--watch")) stdout.write("\u001b[2J\u001b[H");
        stdout.write(`${formatViewLines(render).join("\n")}\n`);
        if (!flags.has("--watch")) break;
        await sleep(render.view.spec.refreshSeconds * 1000, options.signal);
      } while (!options.signal?.aborted);
      return undefined;
    }
    case "pin":
    case "expire":
      if (target === undefined) throw new Error(VIEW_USAGE);
      return client.request({ action: verb, id: target });
    case "unpin":
      if (target === undefined) throw new Error(VIEW_USAGE);
      return client.request({ action: "unpin", id: target, ...(ttl === undefined ? {} : { ttlHours: ttl }) });
    default:
      throw new Error(VIEW_USAGE);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface ViewTextStyle {
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
}
const PLAIN: ViewTextStyle = { bold: (t) => t, dim: (t) => t, red: (t) => t, yellow: (t) => t };

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${seconds % 60 ? `${String(seconds % 60)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)}h${minutes % 60 ? `${String(minutes % 60)}m` : ""}`;
  return `${String(Math.floor(hours / 24))}d`;
}

function bar(used: number, total: number): string {
  const width = Math.min(Math.max(total, 1), 16);
  const filled = total <= 0 ? 0 : Math.min(width, Math.round((used / total) * width));
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

const who = (entry: {
  seatId?: string | undefined;
  holderId?: string | undefined;
  executable?: string | undefined;
}) =>
  [
    entry.executable ?? "process",
    entry.seatId ? `seat ${entry.seatId}` : entry.holderId ? `holder ${entry.holderId}` : "",
  ]
    .filter(Boolean)
    .join("  ");

function fleetLines(
  panel: ViewPanel,
  snapshot: FleetResourceSnapshot,
  now: number,
  style: ViewTextStyle,
): string[] {
  const kind = (entry: { kind: "heavy" | "simulator" }) =>
    panel.resource === undefined || entry.kind === panel.resource;
  if (panel.show === "capacity") {
    const { capacity, pressure } = snapshot;
    const simulatorUsed = capacity.simulatorUsed ?? 0;
    const waiting = snapshot.queue.filter(kind).length;
    return [
      `heavy       ${bar(capacity.used, capacity.heavySlots)}  ${String(capacity.used)}/${String(capacity.heavySlots)} in use`,
      `simulators  ${bar(simulatorUsed, capacity.simulatorSlots)}  ${String(simulatorUsed)}/${String(capacity.simulatorSlots)} in use`,
      `queue       ${waiting === 0 ? style.dim("empty") : `${String(waiting)} waiting`}`,
      `pressure    ${
        pressure.healthy ? "ok" : style.yellow(`high (${pressure.reason ?? "unknown"})`)
      }  load ${pressure.loadRatio.toFixed(2)} · ${(pressure.availableMemoryMb / 1024).toFixed(1)} GB free`,
    ];
  }
  if (panel.show === "queue") {
    const queue = snapshot.queue.filter(kind);
    if (queue.length === 0) return [style.dim("Nothing waiting.")];
    return queue.map(
      (entry, index) =>
        `${String(entry.position ?? index + 1).padStart(2)}. ${entry.kind.padEnd(9)} ${who(entry)}  waiting ${formatDuration(now - entry.queuedAtMs)}${
          entry.estimatedWaitMs ? style.dim(`  ~${formatDuration(entry.estimatedWaitMs)} left`) : ""
        }`,
    );
  }
  const leases = snapshot.leases.filter(kind);
  if (leases.length === 0) return [style.dim("No leases held.")];
  return leases.map(
    (lease) =>
      `${lease.kind.padEnd(9)} ${who(lease)}  ${lease.state}  ${formatDuration(now - lease.createdAtMs)}${
        lease.deviceId ? style.dim(`  ${lease.deviceId.slice(0, 8)}`) : ""
      }`,
  );
}

const PRIORITY = ["", "Urgent", "High", "Medium", "Low"] as const;

function sourceLines(panel: ViewPanel, data: ViewSourceData, now: number, style: ViewTextStyle): string[] {
  if (data.state === "unavailable") return [style.red(`Unavailable: ${data.detail}`)];
  if (data.kind === "fleet_resources") return fleetLines(panel, data.snapshot, now, style);
  if (data.items.length === 0) return [style.dim("No matching issues.")];
  return data.items.map(
    (item) =>
      `${item.id.padEnd(9)} ${item.status.padEnd(11)} ${(item.priority ? PRIORITY[item.priority] : "").padEnd(6)} ${item.title}${
        item.owner ? style.dim(`  @${item.owner}`) : ""
      }`,
  );
}

const defaultTitle = (panel: ViewPanel, data: ViewSourceData | undefined) =>
  `${panel.show[0]!.toUpperCase()}${panel.show.slice(1)}${panel.resource ? ` (${panel.resource})` : ""}${
    data?.state === "ok" && data.kind === "tracker_issues" ? ` · ${data.repo.name}` : ""
  }`;

/** One text rendering of a view, shared by `clankie view show --text` and the TUI `/view` panel. */
export function formatViewLines(
  render: ViewRender,
  options: { now?: number; style?: ViewTextStyle } = {},
): string[] {
  const now = options.now ?? render.renderedAtMs;
  const style = options.style ?? PLAIN;
  const { view } = render;
  const lifetime = view.pinned ? "pinned" : `expires in ${formatDuration((view.expiresAtMs ?? now) - now)}`;
  const lines = [
    `${style.bold(view.spec.title)}  ${style.dim(`${view.id} · ${lifetime} · read ${new Date(render.renderedAtMs).toLocaleTimeString()}`)}`,
  ];
  for (const panel of view.spec.panels) {
    const data = render.sources[panel.source];
    lines.push("", style.bold(panel.title ?? defaultTitle(panel, data)));
    lines.push(
      ...(data === undefined ? [style.red("Source missing")] : sourceLines(panel, data, now, style)),
    );
  }
  return lines;
}
