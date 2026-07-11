import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { CorpusLock, StatusCorpus } from "./types.ts";

export const DEFAULT_CORPUS_DIRECTORY = join(import.meta.dirname, "..", "fixtures", "v1");

export interface LoadedCorpus {
  readonly corpus: StatusCorpus;
  readonly corpusHash: string;
  readonly transcripts: ReadonlyMap<string, string>;
}

export async function loadFrozenCorpus(directory = DEFAULT_CORPUS_DIRECTORY): Promise<LoadedCorpus> {
  const manifestPath = join(directory, "manifest.json");
  const lockPath = join(directory, "corpus-lock.json");
  const corpus = JSON.parse(await readFile(manifestPath, "utf8")) as StatusCorpus;
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as CorpusLock;
  validateCorpusShape(corpus, lock);

  const actualFiles = (await listFiles(directory))
    .map((path) => relative(directory, path))
    .filter((path) => path !== "corpus-lock.json")
    .sort();
  const lockedFiles = Object.keys(lock.files).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(lockedFiles)) {
    throw new Error(`Frozen corpus file set differs from corpus-lock.json`);
  }

  for (const path of actualFiles) {
    const actual = sha256(await readFile(join(directory, path)));
    if (actual !== lock.files[path]) throw new Error(`Frozen corpus checksum mismatch: ${path}`);
  }

  const transcripts = new Map<string, string>();
  for (const fixture of corpus.fixtures) {
    if (basename(fixture.transcriptFile) !== fixture.transcriptFile) {
      throw new Error(`Fixture ${fixture.id} transcriptFile must be a basename`);
    }
    const path = `screens/${fixture.transcriptFile}`;
    if (!lock.files[path]) throw new Error(`Fixture ${fixture.id} transcript is not locked`);
    transcripts.set(fixture.id, await readFile(join(directory, path), "utf8"));
  }

  return { corpus, corpusHash: sha256(Buffer.from(JSON.stringify(lock.files))), transcripts };
}

function validateCorpusShape(corpus: StatusCorpus, lock: CorpusLock): void {
  if (corpus.schemaVersion !== 1 || lock.schemaVersion !== 1) throw new Error("Unsupported corpus schema");
  if (corpus.corpusId !== lock.corpusId) throw new Error("Corpus and lock identifiers differ");
  const ids = new Set(corpus.fixtures.map((fixture) => fixture.id));
  if (ids.size !== corpus.fixtures.length) throw new Error("Fixture ids must be unique");
  if (corpus.fixtures.length === 0) throw new Error("Frozen corpus is empty");
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
