/**
 * `/rivals` as a modal: the current match first, then start, retarget, watch,
 * stop, or change the server. Same command client as `clankie rivals`.
 */
import { formatRivals } from "./command-format.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

type Run = (args: readonly string[]) => Promise<Record<string, unknown>>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const MODES = [
  { value: "autonomous", label: "Autonomous", hint: "he decides" },
  { value: "combat", label: "Combat", hint: "seek fights" },
  { value: "disengage", label: "Disengage", hint: "avoid fights" },
];

export async function runRivalsMenu(shell: ClankieFaceShell, rivals: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("rivals");
  try {
    for (;;) {
      const status = await rivals(["status"]);
      const session = record(status.session);
      const live = session.phase === "starting" || session.phase === "running";
      const id = typeof session.id === "string" ? session.id : undefined;
      const refused = status.outcome === "refused";
      const choice = await flow.readSelect({
        message: formatRivals(status).split("\n")[0]!,
        options: [
          ...(refused
            ? []
            : live && id
              ? [
                  { value: "objective", label: "Change objective…" },
                  { value: "watch", label: "Watch link", hint: "a URL to open or share" },
                  { value: "stop", label: "Stop the match" },
                ]
              : MODES.map((mode) => ({
                  ...mode,
                  value: `start:${mode.value}`,
                  label: `Start · ${mode.label}`,
                }))),
          { value: "connect", label: "Connect a server…", hint: "bridge URL" },
          ...(refused && status.reason === "rivals_not_configured"
            ? []
            : [{ value: "disconnect", label: "Disconnect" }]),
        ],
        allowBack: true,
      });
      if (choice === undefined) return;
      try {
        let result: Json;
        if (choice.startsWith("start:")) {
          const note = await flow.readText({ message: "Note for him (optional)", allowBack: true });
          if (note === undefined) continue;
          result = await rivals(["start", choice.slice(6), ...(note.trim() ? [note.trim()] : [])]);
        } else if (choice === "objective") {
          const mode = await flow.readSelect({ message: "Objective", options: MODES, allowBack: true });
          if (!mode) continue;
          result = await rivals(["objective", id!, mode]);
        } else if (choice === "watch") result = await rivals(["share", id!]);
        else if (choice === "stop") result = await rivals(["stop", id!]);
        else if (choice === "connect") {
          const url = await flow.readText({
            message: "Rivals bridge URL",
            allowBack: true,
            validate: (value) => (/^https?:\/\//u.test(value.trim()) ? undefined : "Enter an http(s) URL."),
          });
          if (url === undefined) continue;
          result = await rivals(["connect", url.trim()]);
        } else result = await rivals(["disconnect"]);
        // A watch link is worth keeping on screen, not just in the status line.
        if (choice === "watch") shell.insertCommandResult("/rivals", formatRivals(result), "success");
        else flow.renderLine(formatRivals(result), result.outcome === "refused" ? "error" : "success");
      } catch (error) {
        flow.renderLine(message(error), "error");
      }
    }
  } catch (error) {
    shell.insertCommandResult("/rivals", message(error), "error");
  } finally {
    flow.end();
  }
}
