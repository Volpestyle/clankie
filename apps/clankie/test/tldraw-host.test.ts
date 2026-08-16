import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAttachableTurnMediaRef, isTldrawArtifactRef } from "@clankie/protocol";
import { createTldrawHost, tldrawEnabled } from "../src/tldraw-host.ts";

const logger = { info: () => undefined, warn: () => undefined };

/** One transparent pixel, so an export has real bytes without a real canvas. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

interface FakeCanvas {
  readonly calls: { path: string; body: unknown }[];
  readonly fetchImpl: typeof fetch;
  scriptDir: string;
  scriptState: string;
  statusReads: number;
  execResult: (code: string) => unknown;
}

function fakeCanvas(scriptDir: string): FakeCanvas {
  const canvas: FakeCanvas = {
    calls: [],
    scriptDir,
    scriptState: "applied",
    statusReads: 0,
    execResult: () => ({
      url: `data:image/png;base64,${PNG_BASE64}`,
      width: 800,
      height: 600,
      system: "turbopuffer",
    }),
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      canvas.calls.push({ path, body });
      const ok = (result: unknown): Response =>
        new Response(JSON.stringify({ success: true, result }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/docs/create") return ok({ id: "tldr:file:fake" });
      if (path.endsWith("/script-workspace")) return ok({ scriptDir: canvas.scriptDir });
      if (path.endsWith("/script-status")) {
        // First read is the pre-write baseline; the host waits for the digest to move.
        const digest = canvas.statusReads++ === 0 ? "before" : "after";
        return ok({
          state: canvas.scriptState,
          lastAppliedDigest: digest,
          currentDiskDigest: digest,
        });
      }
      if (path.endsWith("/exec")) {
        const code = String(body?.code ?? "");
        if (code.includes("__clankieDiagrams?.buildEr")) return ok("function");
        if (code.includes("getCurrentPageId")) return ok("page:page");
        return ok(canvas.execResult(code));
      }
      return new Response(JSON.stringify({ success: false, error: `unexpected ${path}` }), { status: 200 });
    }) as unknown as typeof fetch,
  };
  return canvas;
}

/** The three files the host actually reads out of the design system. */
async function fakeDesignSystem(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const file of [
    "config.js",
    "tpPanel.js",
    "tpPanelTool.js",
    "tpTable.js",
    "tpSequence.js",
    "main.js",
  ]) {
    await writeFile(join(directory, file), `// ${file}\n`);
  }
  await writeFile(
    join(directory, "systems.js"),
    "export const ACTIVE = 'turbopuffer'\n\nexport const systems = { turbopuffer: {}, notebook: {} }\n",
  );
}

describe("tldraw host", () => {
  let root: string;
  let designSystem: string;
  let scriptDir: string;
  let serverHome: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "clankie-tldraw-"));
    designSystem = join(root, "design-system");
    scriptDir = join(root, "script");
    serverHome = join(root, "home");
    await fakeDesignSystem(designSystem);
    await mkdir(scriptDir, { recursive: true });
    await mkdir(join(serverHome, "Library", "Application Support", "tldraw"), { recursive: true });
    await writeFile(
      join(serverHome, "Library", "Application Support", "tldraw", "server.json"),
      JSON.stringify({ port: 7236, token: "test-token" }),
    );
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    return {
      HOME: serverHome,
      CLANKIE_TLDRAW_DESIGN_SYSTEM_DIR: designSystem,
      CLANKIE_DISCORD_ATTACHMENT_ROOT: join(root, "attachments"),
      ...overrides,
    };
  }

  it("is on unless switched off", () => {
    expect(tldrawEnabled(undefined)).toBe(true);
    expect(tldrawEnabled("1")).toBe(true);
    expect(tldrawEnabled("off")).toBe(false);
    expect(tldrawEnabled("false")).toBe(false);
  });

  it("mints an attachable artifact from a drawn diagram", async () => {
    const canvas = fakeCanvas(scriptDir);
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment(),
      fetchImpl: canvas.fetchImpl,
    });

    const result = await host.drawErDiagram({
      schemaVersion: 1,
      title: "world model",
      subtitle: "",
      tables: [
        { name: "player", engine: "postgres", tone: "green", columns: "PK|player_id|uuid", footer: "" },
      ],
      edges: [],
    });

    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(isTldrawArtifactRef(result.artifactRef)).toBe(true);
    // The whole point of the directory: it rides a reply without an approval.
    expect(isAttachableTurnMediaRef(result.artifactRef)).toBe(true);
    expect(result.system).toBe("turbopuffer");

    const digest = result.artifactRef.split(":")[1];
    const bytes = await readFile(join(root, "attachments", "tldraw", `${digest}.png`));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  });

  it("sends diagram content as parsed data, never as code", async () => {
    const canvas = fakeCanvas(scriptDir);
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment(),
      fetchImpl: canvas.fetchImpl,
    });

    // A table name that would end the string literal and start a statement if
    // the request were ever interpolated into the snippet.
    const hostile = `');globalThis.pwned=1;('`;
    await host.drawErDiagram({
      schemaVersion: 1,
      title: hostile,
      subtitle: "",
      tables: [{ name: hostile, engine: "", tone: "black", columns: "PK|id|uuid", footer: "" }],
      edges: [],
    });

    const exec = canvas.calls.filter((call) => call.path.endsWith("/exec")).at(-1);
    const code = String((exec?.body as { code?: unknown })?.code ?? "");
    const [preamble = "", ...rest] = code.split("\n");

    // Everything the request contributed lives inside one JSON string literal
    // on the first line, and comes back out as data rather than as statements.
    const literal = preamble.slice(preamble.indexOf("(") + 1, preamble.lastIndexOf(")"));
    expect(JSON.parse(JSON.parse(literal) as string)).toMatchObject({
      title: hostile,
      tables: [{ name: hostile }],
    });

    // The executable remainder is the host's own, verbatim.
    expect(rest.join("\n")).toBe(
      "const d = globalThis.__clankieDiagrams\nreturn { ...(await d.buildEr(editor, helpers, DATA, 1.5)), system: d.active }",
    );
  });

  it("lets the operator choose the design system without touching the skill", async () => {
    const canvas = fakeCanvas(scriptDir);
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment({ CLANKIE_TLDRAW_DESIGN_SYSTEM: "notebook" }),
      fetchImpl: canvas.fetchImpl,
    });
    await host.drawSequenceDiagram({
      schemaVersion: 1,
      title: "join",
      lanes: "a|client|caller",
      steps: "a->a: think",
    });

    expect(await readFile(join(scriptDir, "systems.js"), "utf8")).toContain(
      'export const ACTIVE = "notebook"',
    );
    // The skill's own copy is never rewritten.
    expect(await readFile(join(designSystem, "systems.js"), "utf8")).toContain(
      "export const ACTIVE = 'turbopuffer'",
    );
  });

  it("refuses, sayably, when the app is not open", async () => {
    const canvas = fakeCanvas(scriptDir);
    await rm(join(serverHome, "Library", "Application Support", "tldraw", "server.json"));
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment(),
      fetchImpl: canvas.fetchImpl,
    });

    const result = await host.drawSequenceDiagram({
      schemaVersion: 1,
      title: "join",
      lanes: "a|client|caller",
      steps: "a->a: think",
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "canvas_unavailable" });
  });

  it("refuses when the design system is not installed", async () => {
    const canvas = fakeCanvas(scriptDir);
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment({ CLANKIE_TLDRAW_DESIGN_SYSTEM_DIR: join(root, "nowhere") }),
      fetchImpl: canvas.fetchImpl,
    });

    const result = await host.drawSequenceDiagram({
      schemaVersion: 1,
      title: "join",
      lanes: "a|client|caller",
      steps: "a->a: think",
    });
    expect(result).toMatchObject({ outcome: "refused", reason: "canvas_unavailable" });
  });

  it("re-exports smaller rather than handing over an unsendable diagram", async () => {
    const canvas = fakeCanvas(scriptDir);
    const huge = Buffer.alloc(8 * 1024 * 1024, 1).toString("base64");
    const scales: string[] = [];
    canvas.execResult = (code) => {
      const scale = /DATA, ([\d.]+)\)/u.exec(code)?.[1] ?? "";
      if (scale) scales.push(scale);
      return {
        url: `data:image/png;base64,${scale === "1" ? PNG_BASE64 : huge}`,
        width: 800,
        height: 600,
        system: "turbopuffer",
      };
    };
    const host = await createTldrawHost({
      runnerStateRoot: root,
      logger,
      environment: environment(),
      fetchImpl: canvas.fetchImpl,
    });

    const result = await host.drawSequenceDiagram({
      schemaVersion: 1,
      title: "join",
      lanes: "a|client|caller",
      steps: "a->a: think",
    });
    expect(result.outcome).toBe("ok");
    expect(scales).toEqual(["1.5", "1"]);
  });
});
