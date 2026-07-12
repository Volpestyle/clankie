import { constants } from "node:fs";
import { chmod, link, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const PRIVATE_FILE_MODE = 0o600;

export async function publishImmutablePrivateFile(
  path: string,
  content: string,
  conflict: () => Promise<void>,
): Promise<"published" | "existing"> {
  const directory = dirname(path);
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }

  let result: "published" | "existing";
  try {
    try {
      await link(temporary, path);
      result = "published";
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await conflict();
      await chmod(path, PRIVATE_FILE_MODE);
      result = "existing";
    }
  } finally {
    await rm(temporary, { force: true });
  }
  if (result === "published") await syncDirectory(directory);
  return result;
}

export async function replacePrivateFileAtomically(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await chmod(directory, 0o700);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(directory);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isAlreadyExists(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "EEXIST";
}
