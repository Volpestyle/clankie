import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Where attachable artifacts live: one rule for everyone who writes one and
 * everyone who reads one back.
 *
 * A screenshot, a generated image, a tldraw export — each is written by the
 * service and later served to Discord by the bridge, which is a *different
 * process*. When the two disagree about the root, the writer produces a
 * reference the reader cannot resolve, and the reply carrying it dies whole.
 * That is not hypothetical: an unset `CLANKIE_DISCORD_ATTACHMENT_ROOT` used to
 * mean "fall back to runner state" on the writing side and "throw" on the
 * reading side, so a browsing turn that took a screenshot lost its answer.
 *
 * The default is therefore a real path rather than an absence — the same
 * `<state>/attachments` both sides derive from the same environment — so the
 * feature works unconfigured and the two processes cannot drift apart.
 */
export function discordAttachmentRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim();
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  const stateRoot = env.CLANKIE_STATE?.trim();
  return join(
    stateRoot !== undefined && stateRoot.length > 0 ? stateRoot : join(homedir(), ".clankie"),
    "attachments",
  );
}
