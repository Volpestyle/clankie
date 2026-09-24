import { afterEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignmentSkills } from "../src/captain/assignment-skills.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-skill-bundle-"));
  roots.push(root);
  const source = join(root, "source");
  const cwd = join(root, "project");
  const other = join(root, "other");
  const skill = "fixture-portable-skill";
  await mkdir(source);
  for (const path of [cwd, other]) await mkdir(join(path, ".agents/skills"), { recursive: true });
  await symlink(source, join(cwd, ".agents/skills", skill));
  await writeFile(
    join(source, "SKILL.md"),
    `---\nname: ${skill}\ndescription: Portable fixture\n---\nUse ./helper.sh and assets/sample.bin.`,
  );
  return { root, source, cwd, other, skill, input: { cwd, repoRoot: root, names: [skill] } };
}

test("selected installed skill bundles preserve scripts, relative references, binary assets and provenance", async () => {
  const f = await fixture();
  await mkdir(join(f.source, "assets"));
  const bytes = Buffer.from([0, 255, 128, 65]);
  await writeFile(join(f.source, "assets/sample.bin"), bytes);
  await writeFile(join(f.source, "helper.sh"), "#!/bin/sh\nprintf 'fixture 🐑\\n'\n");
  await chmod(join(f.source, "helper.sh"), 0o755);
  await symlink("helper.sh", join(f.source, "alias.sh"));
  const text = await assignmentSkills(f.input);
  const bundles = JSON.parse(text.split("\n\n").at(-1)!).skills;
  expect(bundles).toHaveLength(1);
  expect(bundles[0]).toMatchObject({ name: f.skill, entrypoint: "SKILL.md" });
  const files = new Map<
    string,
    { path: string; encoding: BufferEncoding; content: string; executable: boolean; sha256: string }
  >(bundles[0].files.map((file: { path: string }) => [file.path, file]));
  expect(files.get("helper.sh")).toMatchObject({ encoding: "utf8", executable: true });
  expect(files.get("alias.sh")!.content).toBe(files.get("helper.sh")!.content);
  expect(files.get("assets/sample.bin")).toMatchObject({ encoding: "base64", executable: false });
  expect(Buffer.from(files.get("assets/sample.bin")!.content, "base64")).toEqual(bytes);
  for (const file of files.values())
    expect(createHash("sha256").update(Buffer.from(file.content, file.encoding)).digest("hex")).toBe(
      file.sha256,
    );
  await rm(f.source, { recursive: true });
  expect(files.get("SKILL.md")!.content).toContain("./helper.sh");
  await expect(assignmentSkills({ ...f.input, cwd: f.other })).rejects.toThrow("unavailable");
  expect(await assignmentSkills({ ...f.input, names: [] })).toBe("");
});

test("portable selection refuses missing skills, external links, cycles and oversized bundles", async () => {
  const f = await fixture();
  await expect(assignmentSkills({ ...f.input, names: ["missing-fixture"] })).rejects.toThrow("unavailable");
  await writeFile(join(f.root, "private.txt"), "not part of the selected skill");
  await symlink(join(f.root, "private.txt"), join(f.source, "external"));
  await expect(assignmentSkills(f.input)).rejects.toThrow("outside");
  await rm(join(f.source, "external"));
  await symlink(".", join(f.source, "cycle"));
  await expect(assignmentSkills(f.input)).rejects.toThrow("cycle");
  await rm(join(f.source, "cycle"));
  await writeFile(join(f.source, "large.bin"), Buffer.alloc(256 * 1024));
  await expect(assignmentSkills(f.input)).rejects.toThrow("256 KiB");
});
