import type { InlineExtension } from "@earendil-works/pi-coding-agent";

const UNAVAILABLE = [
  "# Your fleet",
  "",
  "Current fleet responsibility could not be verified. Do not close tracked work or change machine setup, commit, push, or publish a release based on previous preferences until current settings and project membership can be verified. Previous responsibility and working preference values are unavailable for this turn.",
].join("\n");

/** Pi reports extension errors and continues, so a failed policy read must replace stale delegation. */
export function captainFleetSettingsExtension(options: {
  initialPrompt: string;
  loadPrompt: () => Promise<string>;
}): InlineExtension {
  return {
    name: "fleet-settings",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", async (event) => {
        let next: string;
        try {
          next = await options.loadPrompt();
        } catch {
          next = UNAVAILABLE;
        }
        return { systemPrompt: event.systemPrompt.replace(options.initialPrompt, next) };
      });
    },
  };
}
