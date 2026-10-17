import { randomUUID } from "node:crypto";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, IMAGE_LIMITS } from "@clankie/lead-skin";
import { GenerateImageResultSchema, isGeneratedMediaRef, type GenerateImageResult } from "@clankie/protocol";
import type { SkinKeyPose } from "@clankie/protocol/skin-drafts";
import type { MediaGeneratorPort } from "./media-generation.ts";

export interface SkinDraftGenerator {
  /** Host-selected policy only. Model arguments and owner pose approval cannot enable spending. */
  admit(owner: string): Promise<boolean>;
  generate(input: {
    description: string;
    pose: SkinKeyPose;
    reference?: { bytes: Buffer; mediaType: string };
  }): Promise<{ receipt: GenerateImageResult; bytes?: Buffer }>;
}

/** Uses the configured media seam; no provider/model override or arbitrary source path. */
export function skinDraftGenerator(options: {
  media: Pick<MediaGeneratorPort, "generateImage">;
  attachmentRoot: string;
  admit: SkinDraftGenerator["admit"];
}): SkinDraftGenerator {
  return {
    admit: options.admit,
    async generate(input) {
      const directory = join(options.attachmentRoot, "generated");
      let referencePath: string | undefined;
      let generatedPath: string | undefined;
      try {
        let sourceRef: string | undefined;
        if (input.reference) {
          if (input.reference.bytes.length > IMAGE_LIMITS.bytes)
            throw Error("skin_generation_image_too_large");
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const filename = `skin-reference-${randomUUID()}.${input.reference.mediaType === "image/jpeg" ? "jpg" : "png"}`;
          referencePath = join(directory, filename);
          await writeFile(referencePath, input.reference.bytes, { mode: 0o600, flag: "wx" });
          sourceRef = `sha256:${digest(input.reference.bytes)}:generated/${filename}`;
        }
        const receipt = GenerateImageResultSchema.parse(
          await options.media.generateImage({
            schemaVersion: 1,
            prompt: `Create one full-body pixel-art key pose on a transparent background, facing right. Use a clean native 32-column grid, preserving the character's natural height and transparent margins. No text, sheet, labels or animation. Pose: ${input.pose === "rest" ? "rest, standing comfortably" : input.pose === "work" ? "working with focused attention" : "communicating, speaking or listening"}. Keep the reference's identity, proportions and palette when supplied. Character brief: ${input.description}`,
            aspectRatio: "1:2",
            ...(sourceRef ? { sourceRef } : {}),
          }),
        );
        if (receipt.outcome !== "ok") return { receipt };
        if (!isGeneratedMediaRef(receipt.artifactRef)) throw Error("skin_generation_invalid_artifact");
        const match = /^sha256:([a-f0-9]{64}):generated\/([A-Za-z0-9._-]+)$/u.exec(receipt.artifactRef);
        if (!match || match[2] === "." || match[2] === "..") throw Error("skin_generation_invalid_artifact");
        generatedPath = join(directory, match[2]!);
        const file = await open(generatedPath, "r");
        let bytes: Buffer;
        try {
          if ((await file.stat()).size > IMAGE_LIMITS.bytes) throw Error("skin_generation_image_too_large");
          // Bound reads even if an upstream file changes after stat.
          const buffer = Buffer.alloc(IMAGE_LIMITS.bytes + 1);
          let count = 0;
          while (count < buffer.length) {
            const read = await file.read(buffer, count, buffer.length - count, count);
            if (!read.bytesRead) break;
            count += read.bytesRead;
          }
          bytes = buffer.subarray(0, count);
        } finally {
          await file.close();
        }
        if (
          bytes.length > IMAGE_LIMITS.bytes ||
          bytes.length !== receipt.byteLength ||
          digest(bytes) !== match[1]
        )
          throw Error("skin_generation_artifact_changed");
        return { receipt, bytes };
      } finally {
        if (referencePath) await rm(referencePath, { force: true });
        // This workflow retains the private source copy, not a second,
        // conversationally attachable file in the general media directory.
        if (generatedPath) await rm(generatedPath, { force: true });
      }
    },
  };
}
