import { viewClient, formatDuration, type ViewCommandOptions } from "./command/view.ts";
import { ClankieViewOverlay } from "./face/clankie-view-overlay.ts";
import type { FaceShellCommand } from "./shell/shell.ts";

/**
 * `/view [ID]`: the owner's views (VUH-2035). With an id, a live panel that
 * re-reads the view every `refreshSeconds`; without one, the list. Views are
 * made with `clankie view create` or by asking Clankie.
 */
export function buildViewCommands(options: ViewCommandOptions): FaceShellCommand[] {
  return [
    {
      name: "view",
      aliases: ["views"],
      description: "Open one of your live views, or list them",
      argumentHint: "[ID]",
      takesArgument: true,
      async run(argument, shell): Promise<void> {
        const client = await viewClient(options);
        let id = argument.trim();
        if (id.length === 0) {
          const { views } = await client.list();
          if (views.length !== 1) {
            const now = Date.now();
            shell.insertCommandResult(
              "/view",
              views.length === 0
                ? "No views yet. Ask Clankie for one, or run clankie view create."
                : views
                    .map(
                      (view) =>
                        `${view.id}  ${view.spec.title}  ${view.pinned ? "pinned" : `expires in ${formatDuration((view.expiresAtMs ?? now) - now)}`}`,
                    )
                    .concat("", "Open one with /view ID.")
                    .join("\n"),
              "success",
            );
            return;
          }
          id = views[0]!.id;
        }
        const controller = new AbortController();
        const overlay = new ClankieViewOverlay(
          { onClose: () => close(), onRender: () => shell.requestRender() },
          shell.theme.commandUiTheme,
        );
        const close = shell.openLivePanel(overlay, () => controller.abort());
        void (async () => {
          while (!controller.signal.aborted) {
            let wait = 5_000;
            try {
              const render = await client.render(id);
              overlay.setRender(render);
              wait = render.view.spec.refreshSeconds * 1000;
            } catch (error) {
              overlay.setNotice(error instanceof Error ? error.message : String(error));
            }
            await new Promise<void>((done) => {
              const timer = setTimeout(done, wait);
              controller.signal.addEventListener("abort", () => {
                clearTimeout(timer);
                done();
              });
            });
          }
        })();
      },
    },
  ];
}
