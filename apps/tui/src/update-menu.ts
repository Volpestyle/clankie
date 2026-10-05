/**
 * `/update` as a modal: show what is running and the last durable update,
 * then stage one only when the owner picks it. Same endpoint as `clankie update`.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const short = (value: unknown) => (typeof value === "string" ? value.slice(0, 8) : "?");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `Running 0b9d486d · last update main 887e07f6 → cc9727b9 healthy`. */
export function formatUpdateState(state: unknown): string {
  const runtime = record(record(state).runtime);
  const latest = record(record(state).latest ?? record(state).operation);
  const running = `Running ${short(runtime.commit)}`;
  if (latest.phase === undefined) return `${running} · no update recorded`;
  return `${running} · last update ${String(latest.ref ?? "main")} ${short(latest.oldCommit)} → ${short(latest.newCommit)} ${String(latest.phase)}`;
}

export async function runUpdateMenu(shell: ClankieFaceShell, update: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("update");
  try {
    const state = await update(["status"]);
    const pending = record(state).pending !== undefined && record(record(state).latest).healthy !== true;
    const choice = await flow.readSelect({
      message: formatUpdateState(state),
      options: [
        {
          value: "main",
          label: "Update to latest main",
          hint: pending ? "an update is already in flight" : "installs, restarts, checks health",
        },
        { value: "ref", label: "Update to a ref…", hint: "branch, tag or commit" },
      ],
      allowBack: true,
    });
    if (choice === undefined) return;
    let ref = "main";
    if (choice === "ref") {
      const typed = await flow.readText({
        message: "Ref",
        allowBack: true,
        validate: (value) => (value.trim() && !value.trim().startsWith("-") ? undefined : "Enter a ref."),
      });
      if (typed === undefined) return;
      ref = typed.trim();
    }
    const staged = await update(ref === "main" ? [] : ["--ref", ref]);
    const accepted = record(staged).accepted === true;
    shell.insertCommandResult(
      "/update",
      accepted
        ? `Staged ${ref}. ${formatUpdateState(staged)}\n/update status follows it.`
        : `Not staged: another update is still settling. ${formatUpdateState(staged)}`,
      accepted ? "success" : "error",
    );
  } catch (error) {
    shell.insertCommandResult("/update", message(error), "error");
  } finally {
    flow.end();
  }
}
