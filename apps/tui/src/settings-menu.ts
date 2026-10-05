/**
 * The shape every small settings command shares as a modal: a status line on
 * top, one row per setting with its current value as the hint, and choosing a
 * row changes it. The menu re-reads after each change, so hints never go stale.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

interface SettingAction {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  /** Returns a one-line outcome, or undefined when the owner backed out. */
  run(flow: SetupFlow): Promise<string | undefined>;
}
export interface SettingsView {
  readonly title: string;
  readonly actions: readonly SettingAction[];
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runSettingsMenu(
  shell: ClankieFaceShell,
  command: string,
  read: () => Promise<SettingsView>,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin(command.slice(1));
  try {
    for (;;) {
      const view = await read();
      const choice = await flow.readSelect({
        message: view.title,
        options: view.actions.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) })),
        allowBack: true,
      });
      const action = view.actions.find((entry) => entry.value === choice);
      if (!action) return;
      try {
        const outcome = await action.run(flow);
        if (outcome !== undefined) flow.renderLine(outcome, "success");
      } catch (error) {
        flow.renderLine(message(error), "error");
      }
    }
  } catch (error) {
    shell.insertCommandResult(command, message(error), "error");
  } finally {
    flow.end();
  }
}

export const onOff = (value: boolean) => (value ? "on" : "off");
