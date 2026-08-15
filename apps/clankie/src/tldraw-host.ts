import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DrawDiagramResultSchema,
  TLDRAW_ARTIFACT_DIRECTORY,
  type DiagramRefusalReason,
  type DrawDiagramResult,
  type DrawErDiagramRequest,
  type DrawSequenceDiagramRequest,
} from "@clankie/protocol";

/**
 * Clankie's drawing hand (ADR 0096).
 *
 * The tldraw desktop app runs on the same machine and exposes a local HTTP
 * server. This host owns the whole conversation with it: which document he
 * draws in, what script that document carries, and — the part that matters —
 * every line of JavaScript that reaches the canvas. A diagram request carries
 * content, never code, so the worst a prompt-injected turn can do is draw
 * something silly.
 *
 * The app is a GUI app on the operator's Mac. When it is not running there is
 * no drawing hand, and that is a refusal he says out loud rather than a boot
 * failure or a 500.
 */

/** Where the app writes its per-launch port and bearer token. */
const SERVER_JSON = join("Library", "Application Support", "tldraw", "server.json");

const ARTIFACT_SUBDIRECTORY = TLDRAW_ARTIFACT_DIRECTORY;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
/** Discord rejects larger attachments outright; re-export smaller before giving up. */
const COMFORTABLE_ARTIFACT_BYTES = 7 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const SCRIPT_APPLY_TIMEOUT_MS = 20_000;

/** The design system's own files, copied in verbatim so the skill stays the source of truth. */
const DESIGN_SYSTEM_FILES = [
  "config.js",
  "tpPanel.js",
  "tpPanelTool.js",
  "tpTable.js",
  "tpSequence.js",
] as const;

/**
 * `systems.js` declares every look and names the active one on its first line.
 * It is copied through this rather than verbatim so the operator can pick, and
 * the file itself stays the one place a look is defined or added.
 */
const ACTIVE_SYSTEM_LINE = /^export const ACTIVE = .*$/mu;

const DEFAULT_DESIGN_SYSTEM_DIR = join(
  homedir(),
  "dev",
  "skills",
  "app-dev",
  "tldraw-design-systems",
  "assets",
);

export interface TldrawHostLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface TldrawHostOptions {
  readonly runnerStateRoot: string;
  readonly logger: TldrawHostLogger;
  readonly environment?: NodeJS.ProcessEnv;
  /** Injectable transport, so tests never need a running desktop app. */
  readonly fetchImpl?: typeof fetch;
}

export interface TldrawHost {
  drawErDiagram(request: DrawErDiagramRequest): Promise<DrawDiagramResult>;
  drawSequenceDiagram(request: DrawSequenceDiagramRequest): Promise<DrawDiagramResult>;
}

/** A refusal he can say: "the canvas is not open", not a stack trace. */
class CanvasRefusal extends Error {
  readonly reason: DiagramRefusalReason;
  readonly detail: string | undefined;

  constructor(reason: DiagramRefusalReason, detail?: string) {
    super(detail ?? reason);
    this.reason = reason;
    this.detail = detail;
  }
}

interface ServerHandle {
  readonly port: number;
  readonly token: string;
}

export function tldrawEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export async function createTldrawHost(options: TldrawHostOptions): Promise<TldrawHost> {
  const environment = options.environment ?? process.env;
  const doFetch = options.fetchImpl ?? fetch;
  const home = environment.HOME?.trim() || homedir();
  const designSystemDir = environment.CLANKIE_TLDRAW_DESIGN_SYSTEM_DIR?.trim() || DEFAULT_DESIGN_SYSTEM_DIR;
  /** Unset means "whatever `systems.js` already names", which is the skill's own default. */
  const activeSystem = environment.CLANKIE_TLDRAW_DESIGN_SYSTEM?.trim() || undefined;

  // Diagrams land under the root the Discord attachment resolver already
  // serves, for the same reason screenshots do (ADR 0088). Without that root
  // they still get written and are simply not sendable.
  const artifactRoot = environment.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim() || options.runnerStateRoot;
  await mkdir(join(artifactRoot, ARTIFACT_SUBDIRECTORY), { recursive: true, mode: 0o700 });

  const documentDirectory = join(options.runnerStateRoot, "tldraw");
  await mkdir(documentDirectory, { recursive: true, mode: 0o700 });

  /** The board he is drawing on this run, and whether its script is in place. */
  let board: { id: string } | undefined;

  async function server(): Promise<ServerHandle> {
    let raw: string;
    try {
      raw = await readFile(join(home, SERVER_JSON), "utf8");
    } catch {
      throw new CanvasRefusal("canvas_unavailable", "the tldraw app is not open on the mac");
    }
    let parsed: { port?: unknown; token?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new CanvasRefusal("canvas_unavailable", "the tldraw app left an unreadable server file");
    }
    const port = typeof parsed.port === "number" ? parsed.port : Number.NaN;
    const token = typeof parsed.token === "string" ? parsed.token : "";
    if (!Number.isInteger(port) || token.length === 0) {
      throw new CanvasRefusal("canvas_unavailable", "the tldraw app left an incomplete server file");
    }
    return { port, token };
  }

  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const { port, token } = await server();
    let response: Response;
    try {
      response = await doFetch(`http://localhost:${port}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // A stale server.json with nothing listening is the ordinary shape of
      // "the app quit"; it reads as a connection error, not a missing file.
      throw new CanvasRefusal(
        "canvas_unavailable",
        `the tldraw app is not answering (${error instanceof Error ? error.message.slice(0, 120) : "no response"})`,
      );
    }
    if (!response.ok) {
      throw new CanvasRefusal("canvas_failed", `tldraw returned ${response.status} for ${path}`);
    }
    const payload = (await response.json()) as { success?: unknown; result?: unknown; error?: unknown };
    if (payload.success !== true) {
      const detail = typeof payload.error === "string" ? payload.error : "the canvas rejected the request";
      throw new CanvasRefusal("canvas_failed", detail.slice(0, 400));
    }
    return payload.result;
  }

  /**
   * Run host-authored JavaScript against the board.
   *
   * `data` is the only thing a request influences, and it crosses as a JSON
   * *string* that the snippet parses — double-encoded on purpose, so no amount
   * of contrivance in a table name can escape a string literal and become code.
   */
  async function exec(docId: string, code: string, data?: unknown): Promise<unknown> {
    const preamble =
      data === undefined ? "" : `const DATA = JSON.parse(${JSON.stringify(JSON.stringify(data))});\n`;
    return call("POST", `/api/doc/${docId}/exec`, { code: `${preamble}${code}` });
  }

  interface ScriptStatus {
    state?: unknown;
    lastAppliedDigest?: unknown;
    currentDiskDigest?: unknown;
    lastApplyError?: unknown;
  }

  /** Install the design system plus this repo's builders into a board's script. */
  async function installScript(docId: string): Promise<void> {
    const workspace = (await call("POST", `/api/doc/${docId}/script-workspace`)) as { scriptDir?: unknown };
    const scriptDir = typeof workspace.scriptDir === "string" ? workspace.scriptDir : "";
    if (scriptDir.length === 0) throw new CanvasRefusal("canvas_failed", "tldraw exposed no script directory");

    // What was applied before we wrote anything. A fresh board already reports
    // `applied` for its starter template, so waiting on the state alone hands
    // back a board whose script has not run yet — and the first diagram then
    // reaches for builders that do not exist.
    const before = ((await call("GET", `/api/doc/${docId}/script-status`)) as ScriptStatus).lastAppliedDigest;

    for (const file of DESIGN_SYSTEM_FILES) {
      try {
        await copyFile(join(designSystemDir, file), join(scriptDir, file));
      } catch {
        throw new CanvasRefusal(
          "canvas_unavailable",
          `the tldraw design system is missing at ${designSystemDir}`,
        );
      }
    }

    // Which look he draws in is an operator choice, like which model draws a
    // picture (ADR 0085) — the turn picks what the diagram says, never how it
    // looks. Rewriting the one line keeps `systems.js` the single place a look
    // is defined, so adding one is a skill edit and needs no service change.
    let systems: string;
    try {
      systems = await readFile(join(designSystemDir, "systems.js"), "utf8");
    } catch {
      throw new CanvasRefusal(
        "canvas_unavailable",
        `the tldraw design system is missing at ${designSystemDir}`,
      );
    }
    if (activeSystem !== undefined) {
      if (!ACTIVE_SYSTEM_LINE.test(systems)) {
        options.logger.warn(
          { event: "tldraw.system.unset", system: activeSystem },
          "systems.js declares no ACTIVE line; drawing in its own default",
        );
      }
      systems = systems.replace(ACTIVE_SYSTEM_LINE, `export const ACTIVE = ${JSON.stringify(activeSystem)}`);
    }
    await writeFile(join(scriptDir, "systems.js"), systems, { mode: 0o600 });
    // The skill's own entry point becomes a plain module this one calls, so the
    // theme stays the skill's business and only the builders are ours.
    await copyFile(join(designSystemDir, "main.js"), join(scriptDir, "system.js"));
    await writeFile(join(scriptDir, "clankie-diagrams.js"), DIAGRAM_BUILDERS, { mode: 0o600 });
    await writeFile(join(scriptDir, "main.js"), MAIN_SCRIPT, { mode: 0o600 });

    const deadline = Date.now() + SCRIPT_APPLY_TIMEOUT_MS;
    for (;;) {
      const status = (await call("GET", `/api/doc/${docId}/script-status`)) as ScriptStatus;
      if (status.state === "error") {
        const detail = typeof status.lastApplyError === "string" ? status.lastApplyError : "script apply failed";
        throw new CanvasRefusal("canvas_failed", detail.slice(0, 400));
      }
      if (
        status.state === "applied" &&
        status.lastAppliedDigest !== before &&
        status.lastAppliedDigest === status.currentDiskDigest
      ) {
        break;
      }
      if (Date.now() > deadline) throw new CanvasRefusal("canvas_failed", "the canvas script never applied");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // `applied` only means the watcher wrote the files through. A module that
    // fails to import lands in the app's error log and leaves the status clean,
    // so the honest check is whether the builders are actually reachable.
    const ready = await exec(docId, "return typeof globalThis.__clankieDiagrams?.buildEr");
    if (ready !== "function") {
      throw new CanvasRefusal("canvas_failed", "the canvas script applied but exposed no builders");
    }
  }

  /**
   * The board for this run, created on first use and reused after.
   *
   * A closed window is the ordinary way this goes stale, so a failed call drops
   * the handle and the next request draws on a fresh board rather than erroring
   * for the rest of the process's life.
   */
  async function ensureBoard(): Promise<string> {
    if (board !== undefined) {
      try {
        await exec(board.id, "return editor.getCurrentPageId()");
        return board.id;
      } catch {
        board = undefined;
      }
    }
    const created = (await call("POST", "/api/docs/create", {
      name: `Clankie diagrams ${new Date().toISOString().slice(0, 19).replace(/[:T]/gu, "-")} ${randomUUID().slice(0, 8)}`,
      directory: documentDirectory,
    })) as { id?: unknown };
    const id = typeof created.id === "string" ? created.id : "";
    if (id.length === 0) throw new CanvasRefusal("canvas_failed", "tldraw created no document");
    await installScript(id);
    board = { id };
    options.logger.info({ event: "tldraw.board.created", docId: id }, "diagram board opened");
    return id;
  }

  async function render(builder: "buildEr" | "buildSequence", data: unknown): Promise<DrawDiagramResult> {
    const docId = await ensureBoard();
    let scale = 1.5;
    for (;;) {
      const exported = (await exec(
        docId,
        `const d = globalThis.__clankieDiagrams
return { ...(await d.${builder}(editor, helpers, DATA, ${scale})), system: d.active }`,
        data,
      )) as { url?: unknown; width?: unknown; height?: unknown; system?: unknown };
      const url = typeof exported.url === "string" ? exported.url : "";
      const comma = url.indexOf(",");
      if (!url.startsWith("data:image/png;base64,") || comma < 0) {
        throw new CanvasRefusal("canvas_failed", "the canvas produced no image");
      }
      const bytes = Buffer.from(url.slice(comma + 1), "base64");
      if (bytes.byteLength === 0) throw new CanvasRefusal("canvas_failed", "the canvas produced an empty image");
      if (bytes.byteLength > COMFORTABLE_ARTIFACT_BYTES && scale > 1) {
        scale = 1;
        continue;
      }
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw new CanvasRefusal("artifact_too_large");

      const digest = createHash("sha256").update(bytes).digest("hex");
      const relativePath = join(ARTIFACT_SUBDIRECTORY, `${digest}.png`);
      await writeFile(join(artifactRoot, relativePath), bytes, { mode: 0o600 });
      const system = typeof exported.system === "string" ? exported.system : "";
      options.logger.info(
        { event: "tldraw.diagram.drawn", builder, system, bytes: bytes.byteLength },
        "diagram drawn",
      );
      return DrawDiagramResultSchema.parse({
        outcome: "ok",
        artifactRef: `sha256:${digest}:${relativePath}`,
        filename: `diagram-${digest.slice(0, 8)}.png`,
        width: Math.round(Number(exported.width) || 0) || 1,
        height: Math.round(Number(exported.height) || 0) || 1,
        ...(system.length === 0 ? {} : { system }),
      });
    }
  }

  async function guarded(
    builder: "buildEr" | "buildSequence",
    data: unknown,
  ): Promise<DrawDiagramResult> {
    try {
      return await render(builder, data);
    } catch (error) {
      if (error instanceof CanvasRefusal) {
        options.logger.warn(
          { event: "tldraw.diagram.refused", reason: error.reason, detail: error.detail },
          "diagram refused",
        );
        return DrawDiagramResultSchema.parse({
          outcome: "refused",
          reason: error.reason,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        });
      }
      const detail = error instanceof Error ? error.message.slice(0, 400) : "the canvas failed";
      options.logger.warn({ event: "tldraw.diagram.failed", detail }, "diagram failed");
      return DrawDiagramResultSchema.parse({ outcome: "refused", reason: "canvas_failed", detail });
    }
  }

  return {
    drawErDiagram: (request) => guarded("buildEr", request),
    drawSequenceDiagram: (request) => guarded("buildSequence", request),
  };
}

/**
 * The board's entry point. The design system's own `main.js` (copied in as
 * `system.js`) still owns the theme; this only hangs the builders where `exec`
 * can reach them.
 */
const MAIN_SCRIPT = `import applySystem from './system.js'
import { ACTIVE, systems } from './systems.js'
import { buildEr, buildSequence } from './clankie-diagrams.js'

export default function (ctx) {
\t// Registered before the look is applied, so an unknown system still leaves
\t// the builders reachable and the failure is the skill's own clear message.
\tglobalThis.__clankieDiagrams = { buildEr, buildSequence, active: ACTIVE, available: Object.keys(systems) }
\tapplySystem(ctx)
}
`;

/**
 * Layout and export, running inside the board.
 *
 * Kept as one string rather than a file on disk because it has to travel into
 * the app's own script directory, which is not part of this package's build.
 */
const DIAGRAM_BUILDERS = `import { createShapeId, toRichText } from 'tldraw'
import { measureSequence } from './tpSequence.js'

const TABLE_W = 560
const COL_GAP = 240
const ROW_GAP = 96
const HEADER_H = 30
const COLHDR_H = 27
const ROW_H = 34
const PER_COLUMN = 3

const rowsOf = (columns) => columns.trim().split('\\n').filter((line) => line.trim())

function estimateHeight(table) {
\tconst footerLines = table.footer
\t\t? table.footer.split('\\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 74)), 0)
\t\t: 0
\treturn HEADER_H + COLHDR_H + rowsOf(table.columns).length * ROW_H + (footerLines ? 20 + footerLines * 18 : 0)
}

/** Normalized anchor on the edge of the row that owns \`field\`. */
function rowAnchor(table, height, field, side) {
\tconst rows = rowsOf(table.columns)
\tconst index = rows.findIndex((line) => line.split('|')[1]?.trim() === field)
\tconst y = HEADER_H + COLHDR_H + (index < 0 ? 0 : index) * ROW_H + ROW_H / 2
\tif (side === 'top') return { x: 0.5, y: 0 }
\tif (side === 'bottom') return { x: 0.5, y: 1 }
\treturn { x: side === 'left' ? 0 : 1, y: y / height }
}

async function painted() {
\tawait new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/** Grow each table to the height its own DOM needs, then restack its column. */
function fitTables(editor, columns, placed) {
\tcolumns.forEach((column, ci) => {
\t\tlet y = 0
\t\tfor (const name of column) {
\t\t\tconst id = placed[name]
\t\t\tconst shape = editor.getShape(id)
\t\t\tif (!shape) continue
\t\t\tconst el = document.querySelector(\`[data-shape-id="\${id}"]\`)
\t\t\tconst stack = el && [...el.querySelectorAll('div')].find((d) => d.style.flexDirection === 'column')
\t\t\tconst needed = stack
\t\t\t\t? Math.ceil([...stack.children].reduce((n, kid) => n + kid.scrollHeight, 0)) + 2
\t\t\t\t: shape.props.h
\t\t\tconst next = {}
\t\t\tif (Math.abs(needed - shape.props.h) > 1) next.props = { h: needed }
\t\t\tif (Math.abs(shape.y - y) > 1) next.y = y
\t\t\tif (Object.keys(next).length) editor.updateShape({ id, type: shape.type, ...next })
\t\t\ty += (next.props?.h ?? shape.props.h) + ROW_GAP
\t\t}
\t})
}

async function exportPage(editor, scale) {
\tawait painted()
\tconst ids = editor.getCurrentPageShapes().map((shape) => shape.id)
\tif (ids.length === 0) throw new Error('nothing to export')
\tconst image = await editor.toImageDataUrl(ids, { format: 'png', scale, background: true, padding: 48 })
\treturn { url: image.url, width: image.width, height: image.height }
}

function clear(editor) {
\teditor.deleteShapes(editor.getCurrentPageShapes().map((shape) => shape.id))
}

export async function buildEr(editor, helpers, data, scale) {
\tclear(editor)
\t// Balanced rather than three-then-remainder: four entities read better as
\t// two columns of two than as a stack of three with an orphan beside it.
\tconst columnCount = Math.max(1, Math.ceil(data.tables.length / PER_COLUMN))
\tconst base = Math.floor(data.tables.length / columnCount)
\tconst wide = data.tables.length % columnCount
\tconst columns = []
\tfor (let i = 0, taken = 0; i < columnCount; i += 1) {
\t\tconst size = base + (i < wide ? 1 : 0)
\t\tcolumns.push(data.tables.slice(taken, taken + size).map((table) => table.name))
\t\ttaken += size
\t}
\tconst byName = new Map(data.tables.map((table) => [table.name, table]))
\tconst columnOf = new Map()
\tconst placed = {}
\tconst heights = {}

\teditor.createShape({
\t\tid: createShapeId('diagram-title'),
\t\ttype: 'text',
\t\tx: 0,
\t\ty: -210,
\t\tprops: { richText: toRichText(data.title), size: 'xl', font: 'mono', color: 'black', textAlign: 'start' },
\t})
\tif (data.subtitle) {
\t\teditor.createShape({
\t\t\tid: createShapeId('diagram-subtitle'),
\t\t\ttype: 'text',
\t\t\tx: 0,
\t\t\ty: -112,
\t\t\tprops: { richText: toRichText(data.subtitle), size: 'm', font: 'mono', color: 'black', textAlign: 'start' },
\t\t})
\t}

\tcolumns.forEach((column, ci) => {
\t\tlet y = 0
\t\tfor (const name of column) {
\t\t\tconst table = byName.get(name)
\t\t\tconst h = estimateHeight(table)
\t\t\tconst id = createShapeId(\`erd-\${ci}-\${name}\`)
\t\t\teditor.createShape({
\t\t\t\tid,
\t\t\t\ttype: 'tp-table',
\t\t\t\tx: ci * (TABLE_W + COL_GAP),
\t\t\t\ty,
\t\t\t\tprops: {
\t\t\t\t\tw: TABLE_W,
\t\t\t\t\th,
\t\t\t\t\tname: table.name,
\t\t\t\t\tengine: table.engine,
\t\t\t\t\ttone: table.tone,
\t\t\t\t\tcolumns: table.columns,
\t\t\t\t\tfooter: table.footer,
\t\t\t\t},
\t\t\t})
\t\t\tplaced[name] = id
\t\t\theights[name] = h
\t\t\tcolumnOf.set(name, ci)
\t\t\ty += h + ROW_GAP
\t\t}
\t})

\tfor (const edge of data.edges ?? []) {
\t\tconst fromId = placed[edge.from]
\t\tconst toId = placed[edge.to]
\t\tif (!fromId || !toId) continue
\t\tconst sameColumn = columnOf.get(edge.from) === columnOf.get(edge.to)
\t\tconst rightwards = (columnOf.get(edge.to) ?? 0) > (columnOf.get(edge.from) ?? 0)
\t\tconst fromSide = sameColumn ? 'bottom' : rightwards ? 'right' : 'left'
\t\tconst toSide = sameColumn ? 'top' : rightwards ? 'left' : 'right'
\t\tconst arrow = helpers.createArrowBetweenShapes(fromId, toId, {
\t\t\t...(edge.label ? { richText: toRichText(edge.label) } : {}),
\t\t})
\t\teditor.updateShape({ id: arrow, type: 'arrow', props: { kind: 'elbow', color: 'grey', size: 's' } })
\t\tfor (const binding of editor.getBindingsFromShape(arrow, 'arrow')) {
\t\t\tconst isStart = binding.props.terminal === 'start'
\t\t\tconst name = isStart ? edge.from : edge.to
\t\t\teditor.updateBinding({
\t\t\t\tid: binding.id,
\t\t\t\ttype: 'arrow',
\t\t\t\tprops: {
\t\t\t\t\t...binding.props,
\t\t\t\t\tnormalizedAnchor: rowAnchor(
\t\t\t\t\t\tbyName.get(name),
\t\t\t\t\t\theights[name],
\t\t\t\t\t\tisStart ? edge.fromField : edge.toField,
\t\t\t\t\t\tisStart ? fromSide : toSide,
\t\t\t\t\t),
\t\t\t\t\tisPrecise: true,
\t\t\t\t\tisExact: false,
\t\t\t\t},
\t\t\t})
\t\t}
\t}

\tawait painted()
\teditor.run(() => fitTables(editor, columns, placed), { history: 'ignore' })
\treturn exportPage(editor, scale)
}

export async function buildSequence(editor, _helpers, data, scale) {
\tclear(editor)
\tconst size = measureSequence(data)
\teditor.createShape({
\t\tid: createShapeId('sequence'),
\t\ttype: 'tp-sequence',
\t\tx: 0,
\t\ty: 0,
\t\tprops: { title: data.title, lanes: data.lanes, steps: data.steps, tone: 'black', ...size },
\t})
\treturn exportPage(editor, scale)
}
`;
