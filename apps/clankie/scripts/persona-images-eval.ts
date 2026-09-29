/** Live, isolated persona comparison. No tools, service turns, or owner-setting writes. */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadPersonaImages, personaImageMessage } from "@clankie/persona-images";
import { SettingsStore, personaInstructions } from "@clankie/settings";
import { createCaptainModelRuntime } from "../src/captain/model.ts";

const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] ?? join(root, "docs/testing/2026-09-28-persona-images/ab-report.md"));
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
const board = await loadPersonaImages(join(root, "branding"));
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
    `# Persona images A/B\n\nRun: ${new Date().toISOString()}\n\n${metadata}\n\nOwner's actual written persona, social register (SHA-256 ${personaHash}); its private text is not copied into this public report. Canonical public branding only: ${board.files
      .filter((f) => f.status === "loaded")
      .map((f) => f.name)
      .join(
        ", ",
      )}. Board hash: ${board.hash}.\n\nTwelve fixed prompts, independent fresh contexts, no tools or history. A is written persona only; B uses the same persona plus the production image prefix. Order alternates A/B and B/A. One sample per arm; differences are qualitative and can reflect sampling. This measures responses, not audio or image rendering. Completed model calls: ${complete}/24.\n\n| Prompt | A: text persona | B: persona + images |\n| --- | --- | --- |\n${rows.join("\n")}\n`,
  );
}
try {
  const { runtime, resolveSelection } = await createCaptainModelRuntime(root);
  const selection = await resolveSelection();
  metadata = `Model: ${selection.ref}; effort: ${selection.thinkingLevel}; transport: ${selection.model.api}.`;
  if (!selection.model.input.includes("image"))
    throw new Error("Configured model does not accept images; cannot run an image A/B.");
  for (const [index, prompt] of prompts.entries()) {
    const answers = ["", ""];
    for (const arm of index % 2 ? [1, 0] : [0, 1]) {
      const prefix = arm ? personaImageMessage(board, true) : undefined;
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
    rows.push(`| ${cell(prompt)} | ${cell(answers[0]!)} | ${cell(answers[1]!)} |`);
    await save();
    console.log(`Completed pair ${index + 1}/${prompts.length}`);
  }
} catch (error) {
  metadata += `\n\nRun incomplete: ${error instanceof Error ? error.message : String(error)}`;
  process.exitCode = 1;
} finally {
  await save();
  console.log(output);
}
