import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildLeadSkin,
  digest,
  readLeadSkin,
  renderLeadSkinSheets,
  sampleReference,
  verifyLeadSkinArtifact,
  LEAD_SKIN_LIMITS,
  IMAGE_LIMITS,
  type SamplingOptions,
} from "@clankie/lead-skin";

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > limit) throw new Error("Skin input byte limit exceeded");
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const part = await file.read(bytes, count, bytes.length - count, count);
      if (!part.bytesRead) break;
      count += part.bytesRead;
    }
    if (count > limit) throw new Error("Skin input byte limit exceeded");
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}

/** Local data tooling: no provider, live settings, owner approval or publication effects. */
export async function runSkinCommand(args: readonly string[]): Promise<unknown> {
  const [action, input] = args;
  const usage =
    "Usage: clankie skin compile SOURCE --out NEW_DIRECTORY | sample IMAGE OPTIONS.json --out NEW_DIRECTORY | check DIRECTORY";
  if (!input) throw new Error(usage);
  if (action === "check" && args.length === 2) {
    const expected = JSON.parse(
      (await boundedFile(join(input, "artifact.json"), LEAD_SKIN_LIMITS.manifestBytes)).toString("utf8"),
    );
    const manifest = verifyLeadSkinArtifact(
      await boundedFile(join(input, "manifest.json"), LEAD_SKIN_LIMITS.manifestBytes),
      await boundedFile(join(input, "lead.png"), LEAD_SKIN_LIMITS.bytes),
      expected,
    );
    return {
      outcome: "ok",
      id: manifest.id,
      version: manifest.version,
      mechanicalValidation: "passed",
      ownerApproval: "not_checked",
      visualReview: "not_checked",
    };
  }
  if (action === "compile" && args.length === 4 && args[2] === "--out") {
    const { manifest, png } = buildLeadSkin(await readLeadSkin(input));
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
    const artifact = {
      schemaVersion: 1,
      manifestSha256: digest(manifestBytes),
      atlasSha256: digest(png),
      reviews: [] as { file: string; rows: unknown }[],
    };
    verifyLeadSkinArtifact(manifestBytes, png, artifact);
    await mkdir(args[3]!, { mode: 0o700 });
    for (const sheet of renderLeadSkinSheets(manifest, png)) {
      const file = `review-${artifact.reviews.length + 1}.png`;
      await writeFile(join(args[3]!, file), sheet.png, { mode: 0o600, flag: "wx" });
      artifact.reviews.push({ file, rows: sheet.rows });
    }
    for (const [name, bytes] of [
      ["manifest.json", manifestBytes],
      ["lead.png", png],
      ["artifact.json", Buffer.from(JSON.stringify(artifact, null, 2) + "\n")],
    ] as const)
      await writeFile(join(args[3]!, name), bytes, { mode: 0o600, flag: "wx" });
    return {
      outcome: "ok",
      directory: args[3],
      ...artifact,
      ownerApproval: "not_checked",
      visualReview: "not_checked",
    };
  }
  if (action === "sample" && args.length === 5 && args[3] === "--out") {
    const options = JSON.parse((await boundedFile(args[2]!, 16384)).toString("utf8")) as SamplingOptions;
    const result = sampleReference(await boundedFile(input, IMAGE_LIMITS.bytes), options);
    await mkdir(args[4]!, { mode: 0o700 });
    await writeFile(join(args[4]!, "native.png"), result.png, { mode: 0o600, flag: "wx" });
    await writeFile(
      join(args[4]!, "sample.json"),
      JSON.stringify({ grid: result.grid, palette: result.palette }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return { outcome: "ok", directory: args[4], grid: result.grid, approvalRequired: true };
  }
  throw new Error(usage);
}
