import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discordAttachmentRoot } from "@clankie/settings";
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
  "tpNode.js",
  "tpTable.js",
  "tpSequence.js",
  "tpConnect.js",
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

interface TldrawHostLogger {
  info(payload: Record<string, unknown>, message: string): void;
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface TldrawHostOptions {
  readonly stateRoot: string;
  /** Where a diagram is written so the Discord bridge can serve it back; supplied by the composition root. */
  readonly attachmentRoot?: string;
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
  // serves, for the same reason screenshots do (ADR 0088).
  const artifactRoot = options.attachmentRoot ?? discordAttachmentRoot(environment);
  await mkdir(join(artifactRoot, ARTIFACT_SUBDIRECTORY), { recursive: true, mode: 0o700 });

  const documentDirectory = join(options.stateRoot, "tldraw");
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
    if (scriptDir.length === 0)
      throw new CanvasRefusal("canvas_failed", "tldraw exposed no script directory");

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
        const detail =
          typeof status.lastApplyError === "string" ? status.lastApplyError : "script apply failed";
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
      await delay(250);
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
      if (bytes.byteLength === 0)
        throw new CanvasRefusal("canvas_failed", "the canvas produced an empty image");
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

  async function guarded(builder: "buildEr" | "buildSequence", data: unknown): Promise<DrawDiagramResult> {
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
import { connectShapes } from './tpConnect.js'
import { fitTable, measureTable } from './tpTable.js'

const TABLE_W = 560
const COL_GAP = 240
const ROW_GAP = 96
const PER_COLUMN = 3

async function painted() {
	await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/** Grow each table to the height its own DOM needs, then restack its column. */
function fitTables(editor, columns, placed) {
	columns.forEach((column) => {
		let y = 0
		for (const name of column) {
			const id = placed[name]
			const shape = editor.getShape(id)
			if (!shape) continue
			const h = fitTable(editor, id) ?? shape.props.h
			if (Math.abs(shape.y - y) > 1) editor.updateShape({ id, type: shape.type, y })
			y += h + ROW_GAP
		}
	})
}

async function exportPage(editor, scale) {
	await painted()
	const ids = editor.getCurrentPageShapes().map((shape) => shape.id)
	if (ids.length === 0) throw new Error('nothing to export')
	const image = await editor.toImageDataUrl(ids, { format: 'png', scale, background: true, padding: 48 })
	return { url: image.url, width: image.width, height: image.height }
}

function clear(editor) {
	editor.deleteShapes(editor.getCurrentPageShapes().map((shape) => shape.id))
}

export async function buildEr(editor, helpers, data, scale) {
	clear(editor)
	// Balanced rather than three-then-remainder: four entities read better as
	// two columns of two than as a stack of three with an orphan beside it.
	const columnCount = Math.max(1, Math.ceil(data.tables.length / PER_COLUMN))
	const base = Math.floor(data.tables.length / columnCount)
	const wide = data.tables.length % columnCount
	const columns = []
	for (let i = 0, taken = 0; i < columnCount; i += 1) {
		const size = base + (i < wide ? 1 : 0)
		columns.push(data.tables.slice(taken, taken + size).map((table) => table.name))
		taken += size
	}
	const byName = new Map(data.tables.map((table) => [table.name, table]))
	const columnOf = new Map()
	const placed = {}

	editor.createShape({
		id: createShapeId('diagram-title'),
		type: 'text',
		x: 0,
		y: -210,
		props: { richText: toRichText(data.title), size: 'xl', font: 'mono', color: 'black', textAlign: 'start' },
	})
	if (data.subtitle) {
		editor.createShape({
			id: createShapeId('diagram-subtitle'),
			type: 'text',
			x: 0,
			y: -112,
			props: { richText: toRichText(data.subtitle), size: 'm', font: 'mono', color: 'black', textAlign: 'start' },
		})
	}

	columns.forEach((column, ci) => {
		let y = 0
		for (const name of column) {
			const table = byName.get(name)
			const h = measureTable({ ...table, w: TABLE_W }).h
			const id = createShapeId(\`erd-\${ci}-\${name}\`)
			editor.createShape({
				id,
				type: 'tp-table',
				x: ci * (TABLE_W + COL_GAP),
				y,
				props: {
					w: TABLE_W,
					h,
					name: table.name,
					engine: table.engine,
					tone: table.tone,
					columns: table.columns,
					footer: table.footer,
				},
			})
			placed[name] = id
			columnOf.set(name, ci)
			y += h + ROW_GAP
		}
	})

	await painted()
	editor.run(() => fitTables(editor, columns, placed), { history: 'ignore' })

	for (const edge of data.edges ?? []) {
		const fromId = placed[edge.from]
		const toId = placed[edge.to]
		if (!fromId || !toId) continue
		const sameColumn = columnOf.get(edge.from) === columnOf.get(edge.to)
		const rightwards = (columnOf.get(edge.to) ?? 0) > (columnOf.get(edge.from) ?? 0)
		const fromSide = sameColumn ? 'bottom' : rightwards ? 'right' : 'left'
		const toSide = sameColumn ? 'top' : rightwards ? 'left' : 'right'
		connectShapes(editor, helpers, fromId, toId, {
			meaning: 'fk',
			label: edge.label,
			from: fromSide,
			to: toSide,
			fromField: edge.fromField,
			toField: edge.toField,
		})
	}

	return exportPage(editor, scale)
}

export async function buildSequence(editor, _helpers, data, scale) {
	clear(editor)
	const size = measureSequence(data)
	editor.createShape({
		id: createShapeId('sequence'),
		type: 'tp-sequence',
		x: 0,
		y: 0,
		props: { title: data.title, lanes: data.lanes, steps: data.steps, tone: 'black', ...size },
	})
	return exportPage(editor, scale)
}
`;
