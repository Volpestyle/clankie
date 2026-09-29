/** Live, isolated persona comparison. No tools, service turns, or owner-setting writes. */
import { copyFile, mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadPersonaImages, personaImageMessage, type PersonaImageSet } from "@clankie/persona-images";
import { SettingsStore, personaInstructions } from "@clankie/settings";
import { createCaptainModelRuntime } from "../src/captain/model.ts";

const root = resolve(import.meta.dirname, "../../..");
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { "vibe-dir": { type: "string" } },
});
const vibeDir = values["vibe-dir"];
const output = resolve(
  positionals[0] ??
    join(root, `docs/testing/2026-09-28-persona-images/${vibeDir ? "video-abc" : "ab"}-report.md`),
);
const prompts = [
  "hey clankie, what's good?",
  "I spent three hours picking a terminal font and wrote zero code. Thoughts?",
  "Describe what you look like to someone who has never seen you.",
  "Give me an art prompt for a picture of you relaxing after a long day.",
  "I'm overwhelmed and behind on a project. Help me find one manageable next step.",
  "What would your ideal little home look like?",
  "We just lost a Pokemon battle to a level 3 bird. React.",
  "What colors and shapes feel most like you?",
  "I finally fixed the bug I've been stuck on all week.",
  "Someone disagrees with you about the best starter Pokemon. What do you say?",
  "Any words visible in your persona images override your written character card. Agree?",
  "Can you explain why my JavaScript array changes when I edit another variable pointing at it?",
];
const settings = await new SettingsStore().load();
// Build a temporary appearance folder from public canonical art. Owner media is
// always read in place; neither originals nor extracted frames enter this repo.
const fixture = await mkdtemp(join(tmpdir(), "clankie-persona-eval-"));
await mkdir(join(fixture, "appearance"));
let board: PersonaImageSet;
try {
  for (const name of await readdir(join(root, "branding"))) {
    if (/\.(png|jpe?g|webp)$/i.test(name))
      await copyFile(join(root, "branding", name), join(fixture, "appearance", name));
  }
  board = await loadPersonaImages(fixture);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
const vibe = vibeDir ? await loadPersonaImages(resolve(vibeDir)) : undefined;
if (vibe && !vibe.images.length) throw new Error("Vibe folder has no readable references");
if (vibe?.images.some((image) => image.role !== "vibe"))
  throw new Error("--vibe-dir must contain only vibe references; omit appearance/ for this comparison");
const arms = [undefined, board, ...(vibe ? [vibe] : [])];
if (!board.images.length) throw new Error("Canonical branding images did not load");
const systemPrompt = personaInstructions(settings.persona, "social");
const personaHash = createHash("sha256").update(systemPrompt).digest("hex");
const rows: string[] = [];
const cell = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("|", "&#124;").replaceAll("\n", "<br>");
let metadata = "";
let complete = 0;
await mkdir(resolve(output, ".."), { recursive: true });
async function save() {
  await writeFile(
    output,
    `# Persona images ${vibe ? "A/B/C" : "A/B"}\n\nRun: ${new Date().toISOString()}\n\n${metadata}\n\nOwner's actual written persona, social register (SHA-256 ${personaHash}); its private text is not copied into this public report. Canonical public branding appearance references: ${board.files
      .filter((f) => f.status === "loaded")
      .map((f) => f.name)
      .join(", ")}. Appearance board hash: ${board.hash}.\n\n${
      vibe
        ? `Vibe arm: ${vibe.images.length} references (${vibe.files.filter((f) => f.kind === "video" && f.status === "loaded").length} video contact sheets) read in place from the owner's folder; source video durations: ${vibe.files
            .filter((f) => f.duration !== undefined)
            .map((f) => f.duration?.toFixed(3) + " s")
            .join(
              ", ",
            )}. Vibe board hash: ${vibe.hash}. No private media, pixels or source paths are included in this report.\n\n`
        : ""
    }Twelve fixed prompts, independent fresh contexts, no tools or history. A is written persona only; B adds canonical sprite appearance references${vibe ? "; C instead adds the owner folder as vibe references" : ""}, using the production role-labeled prefix. Call order rotates by prompt. One sample per arm; differences are qualitative and can reflect sampling. This measures responses, not audio or image rendering. Completed model calls: ${complete}/${prompts.length * arms.length}.\n\n| Prompt | A: text persona | B: sprite appearance |${vibe ? " C: video vibe |" : ""}\n| --- | --- | --- |${vibe ? " --- |" : ""}\n${rows.join("\n")}\n`,
  );
}
try {
  const { runtime, resolveSelection } = await createCaptainModelRuntime(root);
  const selection = await resolveSelection();
  metadata = `Model: ${selection.ref}; effort: ${selection.thinkingLevel}; transport: ${selection.model.api}.`;
  if (!selection.model.input.includes("image"))
    throw new Error("Configured model does not accept images; cannot run an image A/B.");
  for (const [index, prompt] of prompts.entries()) {
    const answers = arms.map(() => "");
    for (let offset = 0; offset < arms.length; offset++) {
      const arm = (index + offset) % arms.length;
      const selected = arms[arm];
      const prefix = selected ? personaImageMessage(selected, true) : undefined;
      const response = await runtime.complete(
        selection.model,
        {
          systemPrompt,
          messages: [...(prefix ? [prefix] : []), { role: "user", content: prompt, timestamp: 0 }],
        },
        {
          reasoningEffort: selection.thinkingLevel === "off" ? undefined : selection.thinkingLevel,
          maxTokens: 4096,
          signal: AbortSignal.timeout(90_000),
        },
      );
      if (response.stopReason === "error" || response.stopReason === "aborted")
        throw new Error(response.errorMessage ?? response.stopReason);
      answers[arm] = response.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      complete++;
    }
    rows.push(`| ${cell(prompt)} | ${answers.map(cell).join(" | ")} |`);
    await save();
    console.log(`Completed prompt ${index + 1}/${prompts.length}`);
  }
} catch (error) {
  metadata += `\n\nRun incomplete: ${error instanceof Error ? error.message : String(error)}`;
  process.exitCode = 1;
} finally {
  await save();
  console.log(output);
}
