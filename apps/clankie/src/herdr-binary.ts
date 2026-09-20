import { constants } from "node:fs";
import { chmod, copyFile, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { refreshOfficialHerdr } from "./herdr-release.ts";

/** Keep a matching CLI for live workers; promote the official release on a cold start. */
export async function prepareHerdrBinary(input: {
  root: string;
  fallback: string;
  listening: boolean;
  answers: (binary: string) => Promise<boolean>;
}): Promise<string> {
  const binary = join(input.root, "bin/herdr");
  if (input.listening && (await input.answers(binary))) return binary;
  // An existing pre-upgrade fleet may still need the old bundled CLI. It is
  // retained solely for that live server, never selected for a new fleet.
  const source =
    input.listening && (await input.answers(input.fallback))
      ? input.fallback
      : await refreshOfficialHerdr(input.root, input.fallback);
  if (input.listening && !(await input.answers(source)))
    throw new Error(
      "The running Herdr session needs its matching executable; leave its workers running and restore that installation",
    );
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 });
  const temporary = `${binary}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary, constants.COPYFILE_FICLONE);
    await chmod(temporary, 0o700);
    await rename(temporary, binary);
  } finally {
    await rm(temporary, { force: true });
  }
  return binary;
}
