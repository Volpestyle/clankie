/**
 * Drives one model selection down every path that executes it, and reports what
 * each path actually did.
 *
 * `pnpm --filter @clankie/clankie verify-model [provider/model[@effort]] [--json]`
 *
 * Selection is one config field and three executors: the captain streams
 * through Pi, gameplay decides through the AI SDK, and play commentary is a
 * second AI SDK agent over the same model. A working captain turn says nothing
 * about the other two — they are different transports over different catalogs —
 * so each is called for real and reported separately.
 *
 * Opt-in and credential-bearing, never part of CI: it makes live provider
 * requests with the broker's stored credentials. It is also isolated — the
 * selection under test is written into a throwaway `XDG_CONFIG_HOME`, so the
 * owner's saved model, effort, and media models are read but never written.
 * Voice and image/video selections are reported from the live config precisely
 * to show a captain change did not move them.
 *
 *   pnpm --filter @clankie/clankie verify-model openai-codex/gpt-6-astra@max
 *   pnpm --filter @clankie/clankie verify-model openai/gpt-6-astra@high --metered
 *   pnpm --filter @clankie/clankie verify-model --config-home /tmp/isolated   # verify what the CLI wrote
 *   pnpm --filter @clankie/clankie verify-model --json
 */
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultCredentialStore } from "@clankie/credential-broker";
import { GbaEmulatorActionSchema } from "@clankie/interactive-environment";
import { createModelRegistry } from "@clankie/model-registry";
import {
  CODEX_PROVIDER_ID,
  loadConfig,
  registerConfiguredPiProviders,
  resolveConfiguredLanguageModel,
  resolvePiModelSelection,
} from "@clankie/model-provider";
import { createModelFreePlayMind, createModelVoice } from "@clankie/play";
import { resolveVoiceSettings, SettingsStore } from "@clankie/settings";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BrokerCredentialStore } from "../src/captain/model.ts";

interface Check {
  readonly path: string;
  readonly ok: boolean;
  readonly detail: string;
}

const args = process.argv.slice(2);
const json = args.includes("--json");
/** Positional: everything that is neither a flag nor a flag's value. */
const [target] = args.filter((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--config-home");

// ---------------------------------------------------------------------------
// The image every path is asked about. Four quadrants, four named colours: an
// answer that names them is evidence the image arrived, which a blank frame
// could never give.
// ---------------------------------------------------------------------------

const QUADRANTS = [
  { name: "red", rgb: [220, 40, 40] },
  { name: "green", rgb: [40, 190, 60] },
  { name: "blue", rgb: [50, 80, 220] },
  { name: "yellow", rgb: [240, 220, 60] },
] as const;
const FRAME_WIDTH = 240;
const FRAME_HEIGHT = 160;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Minimal truecolour PNG; no dependency, and the bytes are checkable by eye. */
function quadrantFramePng(): Uint8Array {
  const raw = Buffer.alloc(FRAME_HEIGHT * (1 + FRAME_WIDTH * 3));
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    const row = y * (1 + FRAME_WIDTH * 3);
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      const [red, green, blue] = QUADRANTS[(y < FRAME_HEIGHT / 2 ? 0 : 2) + (x < FRAME_WIDTH / 2 ? 0 : 1)]
        ?.rgb ?? [0, 0, 0];
      const at = row + 1 + x * 3;
      raw[at] = red;
      raw[at + 1] = green;
      raw[at + 2] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(FRAME_WIDTH, 0);
  header.writeUInt32BE(FRAME_HEIGHT, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const IMAGE_QUESTION =
  "The attached 240x160 image is split into four equal quadrants, each a single flat colour. " +
  "Name the colour of the top-left quadrant and the colour of the bottom-right quadrant.";
const EXPECTED = { topLeft: QUADRANTS[0].name, bottomRight: QUADRANTS[3].name };

// ---------------------------------------------------------------------------
// Isolated config: the selection under test, and nothing of the owner's.
// ---------------------------------------------------------------------------

async function throwawayConfigRoot(
  ref: string,
  effort: string | undefined,
  metered: boolean,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-model-"));
  const dir = join(root, "clankie");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "clankie.json"),
    `${JSON.stringify({
      model: ref,
      ...(effort === undefined ? {} : { variant: { [ref]: effort } }),
      // ADR 0052 routes an `openai/…` ref to the subscription whenever one is
      // stored. Dropping the provider is the documented metered opt-out, and
      // the only way to exercise the API-key transport without logging out.
      ...(metered ? { disabled_providers: [CODEX_PROVIDER_ID] } : {}),
    })}\n`,
    "utf8",
  );
  return root;
}

function describe(error: unknown): string {
  const body = (error as { responseBody?: unknown }).responseBody;
  const message = error instanceof Error ? error.message : String(error);
  const detail = typeof body === "string" && body.length > 0 ? ` — ${body}` : "";
  return `${message}${detail}`.replace(/\s+/gu, " ").trim().slice(0, 600);
}

// ---------------------------------------------------------------------------
// The three executors
// ---------------------------------------------------------------------------

/**
 * The captain's transport: Pi, streaming with a tool available and the image in
 * the turn. One request proves both halves of the captain criterion — a tool
 * call whose arguments name the quadrant colours could not be produced without
 * having seen the image.
 */
async function captainCheck(root: string, framePng: Uint8Array): Promise<Check[]> {
  const broker = createDefaultCredentialStore();
  const runtime = await ModelRuntime.create({
    credentials: new BrokerCredentialStore(broker),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const { config } = await loadConfig({ cwd: root, env: { ...process.env, XDG_CONFIG_HOME: root } });
  const catalog = await createModelRegistry().catalog();
  registerConfiguredPiProviders(runtime, config, catalog);
  const selection = resolvePiModelSelection(config, runtime, {
    hasCodexSubscription: (await broker.get(CODEX_PROVIDER_ID)) !== undefined,
    catalog,
  });
  const checks: Check[] = [
    {
      path: "captain · selection (pi)",
      ok: true,
      detail:
        `${selection.ref} effort=${selection.thinkingLevel} transport=${selection.model.api} ` +
        `context=${String(selection.model.contextWindow)} maxOutput=${String(selection.model.maxTokens)} ` +
        `input=${selection.model.input.join("+")}`,
    },
  ];

  const message = await runtime.complete(
    selection.model,
    {
      systemPrompt: "Answer only by calling the tool you are given.",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: IMAGE_QUESTION },
            { type: "image", data: Buffer.from(framePng).toString("base64"), mimeType: "image/png" },
          ],
          timestamp: Date.now(),
        },
      ],
      tools: [
        {
          name: "report_quadrants",
          description: "Report the colours read off the attached image.",
          parameters: Type.Object({
            topLeft: Type.String({ description: "Colour of the top-left quadrant." }),
            bottomRight: Type.String({ description: "Colour of the bottom-right quadrant." }),
          }),
        },
      ],
    },
    { reasoningEffort: selection.thinkingLevel === "off" ? undefined : selection.thinkingLevel },
  );

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    checks.push({
      path: "captain · tool + image turn",
      ok: false,
      detail: message.errorMessage ?? message.stopReason,
    });
    return checks;
  }
  const call = message.content.find((part) => part.type === "toolCall");
  if (call === undefined) {
    checks.push({
      path: "captain · tool + image turn",
      ok: false,
      detail: "the turn produced no tool call",
    });
    return checks;
  }
  const answered = JSON.stringify(call.arguments);
  const sawImage =
    answered.toLowerCase().includes(EXPECTED.topLeft) &&
    answered.toLowerCase().includes(EXPECTED.bottomRight);
  checks.push({
    path: "captain · tool + image turn",
    ok: sawImage,
    detail: sawImage
      ? `called ${call.name}${answered}; both quadrant colours correct`
      : `called ${call.name}${answered}; expected ${JSON.stringify(EXPECTED)} — the image did not arrive intact`,
  });
  return checks;
}

/** Gameplay and commentary: the AI SDK adapter, over the same selected model. */
async function playChecks(root: string, framePng: Uint8Array): Promise<Check[]> {
  const env = { ...process.env, XDG_CONFIG_HOME: root };
  const configured = await resolveConfiguredLanguageModel({ cwd: root, env });
  const providerOptions = configured.modelOptions?.providerOptions ?? {};
  const checks: Check[] = [
    {
      path: "gameplay+commentary · selection (ai sdk)",
      ok: true,
      detail:
        `${configured.ref} context=${String(configured.modelContextWindowTokens ?? 0)} ` +
        `maxOutput=${String(configured.modelMaxOutputTokens ?? 0)} ` +
        `options=${JSON.stringify(providerOptions)}`,
    },
  ];

  const mind = createModelFreePlayMind({ model: configured.model, providerOptions });
  try {
    const decision = (await mind.decide({
      turn: 1,
      observations: [],
      framePng,
      refusedHere: [],
      knownHardFailures: [],
      stalledForTurns: null,
      repeatingForTurns: null,
      recurringForTurns: null,
      objectiveForTurns: null,
      localeForTurns: null,
      retiredObjective: null,
      objectiveRecovery: false,
      history: [],
      notes: null,
      objective: null,
      verifiedInteractions: [],
      learnedTransitions: [],
      turnsSinceSpoke: null,
      audience: "people watching the activity surface",
      interjection: `${IMAGE_QUESTION} Put both colours in your monologue, then take any action.`,
    })) as { monologue?: string; action?: unknown };
    const action = GbaEmulatorActionSchema.safeParse(decision.action);
    const monologue = (decision.monologue ?? "").toLowerCase();
    const sawImage = monologue.includes(EXPECTED.topLeft) && monologue.includes(EXPECTED.bottomRight);
    checks.push({
      path: "gameplay · valid action",
      ok: action.success,
      detail: action.success
        ? `${JSON.stringify(action.data)}${sawImage ? " (image read: both quadrant colours named)" : " (image NOT confirmed in the monologue)"}`
        : action.error.issues.map((issue) => issue.message).join("; "),
    });
  } catch (error) {
    checks.push({ path: "gameplay · valid action", ok: false, detail: describe(error) });
  }

  const voice = createModelVoice({ model: configured.model, providerOptions });
  try {
    const spoken = (await voice.decide({
      turn: 1,
      framePng,
      monologue: "Four flat colour blocks, nothing to fight yet.",
      effect: "The screen is a test pattern.",
      intent: "Look around.",
      objective: "Confirm the room can hear me.",
      heard: "Say something to the room.",
      turnsSinceSpoke: null,
      audience: "people in the voice channel, watching him play",
      recentlySaid: [],
    })) as { speak?: unknown; reply?: unknown };
    const said = [spoken.speak, spoken.reply].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    checks.push({
      path: "commentary · response",
      ok: said.length > 0,
      detail:
        said.length > 0
          ? said.map((value) => JSON.stringify(value.slice(0, 120))).join(" / ")
          : "the decision parsed but chose silence in both fields",
    });
  } catch (error) {
    checks.push({ path: "commentary · response", ok: false, detail: describe(error) });
  }
  return checks;
}

/**
 * A captain change must leave the independent media selections alone, so they
 * are read from the owner's live state, never the throwaway config. Voice comes
 * from settings (`/voice`, ADR 0113) rather than clankie.json — `voice_model`
 * there is compatibility-only and no runtime reads it.
 */
async function mediaSelections(): Promise<Check> {
  const { config } = await loadConfig();
  const { settings: voice } = resolveVoiceSettings((await new SettingsStore().load()).voice);
  const realtimeModel = voice.realtimeProvider === "xai" ? voice.xAiRealtimeModel : voice.openAiRealtimeModel;
  const speaks =
    voice.ttsProvider === "elevenlabs"
      ? `elevenlabs ${voice.elevenLabsModelId ?? "(runtime default)"}/${voice.elevenLabsVoiceId ?? "(unset)"}`
      : `${voice.realtimeProvider} ${voice.realtimeProvider === "xai" ? (voice.xAiVoice ?? "eve") : (voice.openAiVoice ?? "marin")}`;
  return {
    path: "media+voice · independent selections (live state)",
    ok: true,
    detail:
      `image_model=${config.image_model ?? "unset"} video_model=${config.video_model ?? "unset"} | ` +
      `voice realtime=${voice.realtimeProvider}/${realtimeModel ?? "(runtime default)"} ` +
      `transcribe=${voice.openAiTranscribeModel ?? "(runtime default)"} speaks=${speaks}`,
  };
}

// ---------------------------------------------------------------------------

function configHomeArg(argv: readonly string[]): string | undefined {
  const at = argv.indexOf("--config-home");
  return at === -1 ? undefined : argv[at + 1];
}

const cliRoot = configHomeArg(args);
const live =
  cliRoot === undefined
    ? await loadConfig()
    : await loadConfig({ cwd: cliRoot, env: { ...process.env, XDG_CONFIG_HOME: cliRoot } });
const [named, requestedEffort] = (target ?? "").split("@");
// No argument means "check what is actually selected right now".
const ref = named !== undefined && named.length > 0 ? named : live.config.model;
if (ref === undefined || ref.length === 0) {
  console.error("No model configured and none given. Usage: verify-model provider/model[@effort]");
  process.exit(2);
}
const effort =
  requestedEffort !== undefined && requestedEffort.length > 0 ? requestedEffort : live.config.variant?.[ref];

// `--config-home` verifies state some other surface already wrote — the point
// being that `clankie model set` / `clankie effort set` produce exactly the
// selection these three paths then execute.
const root = cliRoot ?? (await throwawayConfigRoot(ref, effort, args.includes("--metered")));
const framePng = quadrantFramePng();
const results: Check[] = [];
try {
  results.push(await mediaSelections());
  try {
    results.push(...(await captainCheck(root, framePng)));
  } catch (error) {
    results.push({ path: "captain · selection (pi)", ok: false, detail: describe(error) });
  }
  try {
    results.push(...(await playChecks(root, framePng)));
  } catch (error) {
    results.push({ path: "gameplay+commentary · selection (ai sdk)", ok: false, detail: describe(error) });
  }
} finally {
  if (cliRoot === undefined) await rm(root, { recursive: true, force: true });
}

if (json) {
  process.stdout.write(`${JSON.stringify({ ref, effort: effort ?? null, results }, null, 2)}\n`);
} else {
  process.stdout.write(`Selection under test: ${ref}${effort === undefined ? "" : ` @ ${effort}`}\n\n`);
  for (const result of results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.path}\n      ${result.detail}\n`);
  }
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(`\n${String(results.length - failed)}/${String(results.length)} checks passed\n`);
}
if (results.some((result) => !result.ok)) process.exitCode = 1;
