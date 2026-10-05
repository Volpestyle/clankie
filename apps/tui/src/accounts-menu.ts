/**
 * `/accounts` as a modal: pick a harness, read each registered profile with
 * its headroom, add or remove one. Writes go through the same commands as
 * `clankie accounts codex|claude`, which never read credentials.
 */
import type { runClaudeAccountsCommand } from "./command/claude-accounts.ts";
import type { runCodexAccountsCommand } from "./command/codex-accounts.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

export interface AccountsMenuServices {
  readonly claude: (args: readonly string[]) => ReturnType<typeof runClaudeAccountsCommand>;
  readonly codex: (args: readonly string[]) => ReturnType<typeof runCodexAccountsCommand>;
}
type Harness = "claude" | "codex";
type CodexAccount = Awaited<ReturnType<typeof runCodexAccountsCommand>>["accounts"][number];
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");

/** `signed in · 42% headroom` for Codex; Claude profiles carry no readable status. */
function codexAccountHint(account: CodexAccount): string {
  return [
    account.authPresent ? "signed in" : "not signed in",
    account.headroom === null ? "headroom unknown" : `${Math.round(account.headroom * 100)}% headroom`,
  ].join(" · ");
}

export async function runAccountsMenu(
  shell: ClankieFaceShell,
  services: AccountsMenuServices,
  start?: Harness,
): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("accounts");
  try {
    for (;;) {
      let harness = start;
      if (harness === undefined) {
        const [claude, codex] = await Promise.all([services.claude([]), services.codex([])]);
        const chosen = await flow.readSelect({
          message: "Harness accounts",
          options: [
            { value: "claude", label: "Claude profiles", hint: `${claude.accounts.length}` },
            { value: "codex", label: "Codex accounts", hint: `${codex.accounts.length}` },
          ],
          allowBack: true,
        });
        if (chosen !== "claude" && chosen !== "codex") return;
        harness = chosen;
      }
      await harnessAccounts(shell, services, harness);
      if (start !== undefined) return;
    }
  } catch (error) {
    shell.insertCommandResult("/accounts", message(error), "error");
  } finally {
    flow.end();
  }
}

async function harnessAccounts(shell: ClankieFaceShell, services: AccountsMenuServices, harness: Harness) {
  const flow = shell.setupFlow;
  const run = services[harness];
  const title = harness === "claude" ? "Claude profiles" : "Codex accounts";
  for (;;) {
    const rows =
      harness === "claude"
        ? (await services.claude([])).accounts.map((account) => ({
            value: account.label,
            label: account.label,
            hint: home(account.home),
          }))
        : (await services.codex([])).accounts.map((account) => ({
            value: account.label,
            label: account.label,
            hint: codexAccountHint(account),
            description: home(account.home),
          }));
    const choice = await flow.readSelect({
      message: title,
      options: [...rows, { value: "\0add", label: "Add an account…", hint: "an existing profile home" }],
      allowBack: true,
    });
    if (choice === undefined) return;
    try {
      if (choice === "\0add") {
        const path = await flow.readText({
          message: `${harness === "claude" ? "Claude config" : "CODEX_HOME"} directory`,
          placeholder: harness === "claude" ? "~/.claude-work" : "~/.codex-work",
          allowBack: true,
          validate: (value) => (value.trim() ? undefined : "Enter a directory."),
        });
        if (path === undefined) continue;
        const label = await flow.readText({
          message: "Label",
          allowBack: true,
          validate: (value) =>
            /^[a-z][a-z0-9_-]{0,63}$/u.test(value.trim()) ? undefined : "Lowercase label.",
        });
        if (label === undefined) continue;
        const expanded = path.trim().replace(/^~(?=\/|$)/u, process.env.HOME ?? "~");
        await run(["add", expanded, "--label", label.trim()]);
        flow.renderLine(`Added ${label.trim()}.`, "success");
        continue;
      }
      if (harness === "claude" && choice === "default") {
        flow.renderLine("The default Claude profile is implicit and stays.", "info");
        continue;
      }
      const confirm = await flow.readSelect({
        message: `Remove ${choice}?`,
        options: [
          { value: "no", label: "Keep it" },
          { value: "yes", label: "Remove", hint: "the profile home and its login stay on disk" },
        ],
        allowBack: true,
      });
      if (confirm !== "yes") continue;
      await run(["remove", choice]);
      flow.renderLine(`Removed ${choice}.`, "success");
    } catch (error) {
      flow.renderLine(message(error), "error");
    }
  }
}
