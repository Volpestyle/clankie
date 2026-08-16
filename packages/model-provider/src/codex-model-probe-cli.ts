/**
 * Streamed Codex-backend probe. ADR 0052 admits a model to the `openai-codex`
 * provider only after a streamed subscription request proves Clankie's own
 * `originator` identity may call it — first-party Codex client visibility is
 * not evidence. This drives the real path (broker credential → codex fetch
 * adapter → Responses transport) once per model/effort pair and prints the
 * backend's own verdict.
 *
 * Opt-in and credential-bearing; never part of CI.
 *
 *   pnpm models:codex-probe                      # exposed models at their top tier
 *   pnpm models:codex-probe gpt-5.7-x@max        # a candidate before exposing it
 *   pnpm models:codex-probe --all-efforts --json
 *
 * A candidate need not be in the exposed set: each probe declares its target
 * into a throwaway config, so an unexposed id still reaches the backend and
 * returns the backend's reason for refusing it.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelEntrySchema } from "@clankie/model-registry";
import { streamText } from "ai";
import { CODEX_SUBSCRIPTION_MODEL_IDS } from "./codex-catalog.ts";
import { resolveConfiguredLanguageModel } from "./configured-model.ts";
import { CODEX_PROVIDER_ID } from "./oauth/openai-codex.ts";
import { effortVariantsFor } from "./variants.ts";

interface ProbeResult {
  readonly modelId: string;
  readonly effort: string;
  readonly ok: boolean;
  readonly detail: string;
}

const PROBE_PROMPT = "Reply with exactly: ok";
/** Any UUID works; a fixed one keeps probe traffic distinguishable from captain sessions. */
const PROBE_SESSION_ID = "00000000-0000-4000-8000-0000c0defcae";

function laddersFor(modelId: string): readonly string[] {
  const model = ModelEntrySchema.parse({ id: modelId, name: modelId, reasoning: true });
  return effortVariantsFor(CODEX_PROVIDER_ID, model).map((variant) => variant.id);
}

/** Message plus the backend's own response body; neither carries credential material. */
function describeError(error: unknown): string {
  const body = (error as { responseBody?: unknown }).responseBody;
  const message = error instanceof Error ? error.message : String(error);
  const detail = typeof body === "string" && body.length > 0 ? ` — ${body}` : "";
  return `${message}${detail}`.replace(/\s+/gu, " ").trim();
}

async function probe(modelId: string, effort: string): Promise<ProbeResult> {
  const ref = `${CODEX_PROVIDER_ID}/${modelId}`;
  const root = await mkdtemp(join(tmpdir(), "codex-model-probe-"));
  let failure: string | undefined;
  try {
    const configDir = join(root, "clankie");
    await mkdir(configDir, { recursive: true });
    const config = {
      model: ref,
      variant: { [ref]: effort },
      provider: { [CODEX_PROVIDER_ID]: { models: { [modelId]: { reasoning: true } } } },
    };
    await writeFile(join(configDir, "clankie.json"), `${JSON.stringify(config)}\n`, "utf8");
    const configured = await resolveConfiguredLanguageModel({
      env: { ...process.env, XDG_CONFIG_HOME: root },
      cwd: root,
      sessionId: PROBE_SESSION_ID,
    });
    // The Codex backend rejects `max_output_tokens`; the turn is bounded by the prompt instead.
    const result = streamText({
      model: configured.model,
      prompt: PROBE_PROMPT,
      ...configured.modelOptions,
      onError: ({ error }) => {
        failure ??= describeError(error);
      },
    });
    let text = "";
    for await (const delta of result.textStream) text += delta;
    if (failure !== undefined) return { modelId, effort, ok: false, detail: failure };
    const usage = await result.usage;
    return {
      modelId,
      effort,
      ok: true,
      detail: `${JSON.stringify(text.trim().slice(0, 40))} (${usage.outputTokens ?? "?"} output tokens)`,
    };
  } catch (error) {
    return { modelId, effort, ok: false, detail: failure ?? describeError(error) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const json = args.includes("--json");
const allEfforts = args.includes("--all-efforts");
const targets = args.filter((arg) => !arg.startsWith("--"));

const pairs: { modelId: string; effort: string }[] = [];
for (const target of targets.length > 0 ? targets : CODEX_SUBSCRIPTION_MODEL_IDS) {
  const [modelId = "", requested] = target.split("@");
  const ladder = laddersFor(modelId);
  const efforts =
    requested !== undefined && requested.length > 0 ? [requested] : allEfforts ? ladder : ladder.slice(-1);
  for (const effort of efforts) pairs.push({ modelId, effort });
}

const results: ProbeResult[] = [];
for (const pair of pairs) {
  const result = await probe(pair.modelId, pair.effort);
  results.push(result);
  if (!json) {
    process.stdout.write(
      `${result.ok ? "PASS" : "FAIL"}  ${CODEX_PROVIDER_ID}/${result.modelId} @ ${result.effort}  ${result.detail}\n`,
    );
  }
}

if (json) process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
else {
  const failed = results.filter((result) => !result.ok).length;
  process.stdout.write(
    `\nCodex backend probe: ${results.length - failed}/${results.length} callable by this originator identity\n`,
  );
}

if (results.some((result) => !result.ok)) process.exitCode = 1;
