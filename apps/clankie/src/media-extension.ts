import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ClankieExtension } from "@clankie/extension";
import type { CorePorts, CoreProjection, MediaProjection } from "./extension-host.ts";
import { ConfiguredMediaGenerator } from "./media-generation.ts";
import { mediaRoutes } from "./media-routes.ts";
import type { DiagramPort } from "./ports/media.ts";
import type { ExtensionRoutes } from "./ports/routes.ts";
import { skinDraftGenerator } from "./skin-draft-generation.ts";
import { SkinDraftService } from "./skin-drafts.ts";
import { createTldrawHost, tldrawEnabled } from "./tldraw-host.ts";

type MediaNeeds =
  | "capabilityStateRoot"
  | "attachmentRoot"
  | "logger"
  | "env"
  | "credentials"
  | "stateRoot"
  | "repoRoot"
  | "deliveredFiles"
  | "appearance";

/**
 * What Clankie makes, as an ADR 0328 extension: image and video generation
 * (ADR 0085), the owner's lead-skin drafts, and his drawing hand (ADR 0096).
 * Off, none of their tools reach the captain or a worker and none of their
 * routes are mounted. Pictures of himself read his look from the core's
 * appearance port, which the persona fills, so media never imports the persona.
 *
 * The tldraw desktop app is a GUI app on the operator's Mac, so "not open" is
 * the normal absent case and stays a refusal he says out loud; nothing here
 * reaches the app until he draws something.
 */
export const mediaExtension: ClankieExtension<undefined, CorePorts, MediaNeeds, CoreProjection> = {
  contractVersion: 1,
  id: "media",
  settings: { key: "media", schema: { parse: () => undefined } },
  needs: [
    "capabilityStateRoot",
    "attachmentRoot",
    "logger",
    "env",
    "credentials",
    "stateRoot",
    "repoRoot",
    "deliveredFiles",
    "appearance",
  ],
  create(host) {
    let diagrams: DiagramPort | undefined;
    let media: MediaProjection | undefined;
    let routes: ExtensionRoutes | undefined;
    return {
      async start() {
        media = createMedia(host);
        routes = mediaRoutes(media);
        if (!tldrawEnabled(host.env.CLANKIE_TLDRAW_ENABLED)) return;
        diagrams = await createTldrawHost({
          stateRoot: host.capabilityStateRoot,
          attachmentRoot: host.attachmentRoot,
          logger: host.logger,
          environment: host.env,
        });
        host.logger.info({ event: "tldraw.capability.enabled" }, "diagram host ready");
      },
      async stop() {},
      health: () => ({ state: "ready" }),
      projection: () => ({
        ...(media === undefined ? {} : { media }),
        ...(routes === undefined ? {} : { routes }),
        ...(diagrams === undefined ? {} : { diagrams }),
      }),
    };
  },
};

/** His generators and the owner's skin drafts. Provider and model come from operator config. */
function createMedia(host: Readonly<Pick<CorePorts, MediaNeeds>>): MediaProjection {
  const { repoRoot, deliveredFiles } = host;
  if (repoRoot === undefined || deliveredFiles === undefined)
    throw new Error("media needs the full service's repo root and delivered files");
  const skinDraftOwner = host.env.CLANKIE_OPERATOR_ID ?? "local-operator";
  const skinMediaRoot = join(
    host.stateRoot,
    "skin-drafts-media",
    createHash("sha256").update(skinDraftOwner).digest("hex"),
  );
  const skinDrafts = new SkinDraftService({
    root: join(host.stateRoot, "skin-drafts"),
    ownerId: skinDraftOwner,
    files: deliveredFiles,
    generator: skinDraftGenerator({
      media: new ConfiguredMediaGenerator({
        credentials: host.credentials,
        attachmentRoot: skinMediaRoot,
        configCwd: repoRoot,
      }),
      attachmentRoot: skinMediaRoot,
      // VUH-2041: hosted credit admission is still an owner decision. Neither
      // a model command nor a pose approval can open this paid route.
      admit: async () => false,
    }),
  });
  const generator = new ConfiguredMediaGenerator({
    ...(host.appearance === undefined ? {} : { appearance: host.appearance }),
    credentials: host.credentials,
    attachmentRoot: host.attachmentRoot,
    configCwd: repoRoot,
  });
  return { generator, skinDrafts };
}
