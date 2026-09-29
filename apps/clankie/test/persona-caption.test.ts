import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { emptySettings } from "@clankie/settings";
import { personaImageBriefing } from "@clankie/persona-images";
import { createPersonaImageSource } from "../src/persona-images.ts";
const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));
vi.mock("../src/captain/model.ts", () => ({
  createCaptainModelRuntime: async () => ({
    runtime: { complete },
    resolveSelection: async () => ({ model: { input: ["text", "image"] } }),
  }),
}));
let root: string;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});
it("captions role-labeled references once, retaining distinct appearance and vibe for voice", async () => {
  root = await mkdtemp(join(tmpdir(), "persona-caption-"));
  vi.stubEnv("XDG_CACHE_HOME", join(root, "cache"));
  const images = join(root, "images");
  await mkdir(join(images, "appearance"), { recursive: true });
  const art = new URL("../../../branding/clankie-logo-512.png", import.meta.url);
  await copyFile(art, join(images, "vibe.png"));
  await copyFile(art, join(images, "appearance", "look.png"));
  const description = "Appearance: A leaf sprite. Vibe: Playful grandeur.";
  complete.mockResolvedValue({ stopReason: "stop", content: [{ type: "text", text: description }] });
  const settings = emptySettings();
  settings.persona.imagesDir = images;
  const store = { load: async () => settings };
  const source = createPersonaImageSource(store, root);
  const board = await source();
  const context = complete.mock.calls[0]![1];
  expect(context.systemPrompt).toContain("separate labeled Appearance and Vibe sections");
  expect(context.systemPrompt).toContain("If a role is absent, say it is unspecified");
  expect(context.messages[0].content[0]).toMatchObject({ text: "Appearance reference: how you look." });
  expect(context.messages[0].content[2]).toMatchObject({
    text: expect.stringContaining("Never a self-portrait reference"),
  });
  expect(personaImageBriefing(board)).toContain(description);
  expect(personaImageBriefing(board)).not.toContain(board.images[0]!.data);
  expect((await source()).description).toBe(description);
  expect((await createPersonaImageSource(store, root)()).description).toBe(description);
  expect(complete).toHaveBeenCalledOnce();
});
