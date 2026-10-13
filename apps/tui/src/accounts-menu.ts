/**
 * `/accounts` as a modal: pick a harness, read each registered profile with
 * its headroom, add or remove one. Writes go through the same commands as
 * `clankie accounts codex|claude`, which never read credentials.
 */
import { harnessAccountName } from "@clankie/protocol/worker-accounts";
import type { runClaudeAccountsCommand } from "./command/claude-accounts.ts";
import type { runCodexAccountsCommand } from "./command/codex-accounts.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

export interface AccountsMenuServices {
  readonly claude: (args: readonly string[]) => ReturnType<typeof runClaudeAccountsCommand>;
  readonly codex: (args: readonly string[]) => ReturnType<typeof runCodexAccountsCommand>;
  /** `clankie accounts workers|hold|release …`: worker accounts as a machine reports them. */
  readonly workers?: (args: readonly string[]) => Promise<unknown>;
}
interface WorkerAccountRow {
  harness: "claude" | "codex";
  label: string;
  home: string;
  identity?: string;
  plan?: string;
  headroom: number | null;
  held?: { reason?: string };
  usable: boolean;
  reason?: string;
}

/** `jamescvolpe@… · max · 80% headroom · usable` for one machine-reported account. */
function workerAccountHint(account: WorkerAccountRow): string {
  return [
    account.identity ?? "no identity",
    account.plan,
    account.harness === "codex"
      ? account.headroom === null
        ? "headroom unknown"
        : `${Math.round(account.headroom * 100)}% headroom`
      : undefined,
    account.held ? `held${account.held.reason ? `: ${account.held.reason}` : ""}` : undefined,
    account.usable ? "usable" : (account.reason ?? "unusable"),
  ]
    .filter(Boolean)
    .join(" · ");
}
type Harness = "claude" | "codex";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const home = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");

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
            ...(services.workers
              ? [
                  {
                    value: "workers",
                    label: "Worker accounts by machine",
                    hint: "sign-in, usage, holds — this Mac or a linked machine",
                  },
                ]
              : []),
          ],
          allowBack: true,
        });
        if (chosen === "workers" && services.workers) {
          await machineAccounts(shell, services.workers);
          continue;
        }
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
  const title = harness === "claude" ? "Claude accounts" : "Codex accounts";
  for (;;) {
    const report = await run([]);
    const rows = report.accounts.map((account) => ({
      value: account.label,
      label: harnessAccountName(account),
      hint: `${account.signedIn ? "signed in" : "sign in required"} · ${home(account.home)}`,
    }));
    const choice = await flow.readSelect({
      message: title,
      options: [
        ...rows,
        { value: "\0add", label: "Add a profile override…", hint: "an existing profile home" },
        ...report.profiles.map((profile) => ({
          value: `\0remove:${profile.label}`,
          label: `Remove profile override: ${profile.label}`,
          hint: home(profile.home),
        })),
      ],
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
      if (!choice.startsWith("\0remove:")) {
        const account = report.accounts.find((entry) => entry.label === choice);
        if (account)
          flow.renderLine(
            `${harnessAccountName(account)} · ${account.label} · ${(account.homes ?? [{ home: account.home }]).map((entry) => home(entry.home)).join(", ")}`,
            "info",
          );
        continue;
      }
      const profileLabel = choice.slice("\0remove:".length);
      const confirm = await flow.readSelect({
        message: `Remove profile override ${profileLabel}?`,
        options: [
          { value: "no", label: "Keep it" },
          { value: "yes", label: "Remove", hint: "the profile home and its login stay on disk" },
        ],
        allowBack: true,
      });
      if (confirm !== "yes") continue;
      await run(["remove", profileLabel]);
      flow.renderLine(`Removed profile override ${profileLabel}.`, "success");
    } catch (error) {
      flow.renderLine(message(error), "error");
    }
  }
}

async function machineAccounts(
  shell: ClankieFaceShell,
  workers: NonNullable<AccountsMenuServices["workers"]>,
) {
  const flow = shell.setupFlow;
  const machine = await flow.readText({
    message: "Machine (runtime connection id; empty: this Mac)",
    placeholder: "pc",
    allowBack: true,
    validate: (value) =>
      value.trim() === "" || /^[a-z][a-z0-9-]{0,63}$/u.test(value.trim()) ? undefined : "A connection id.",
  });
  if (machine === undefined) return;
  const target = machine.trim() ? ["--machine", machine.trim()] : [];
  for (;;) {
    flow.renderLine(`Asking ${machine.trim() || "this Mac"} for its worker accounts…`, "info");
    let report: { accounts: WorkerAccountRow[]; unavailable?: Record<string, string> };
    try {
      report = (await workers(["workers", ...target])) as typeof report;
    } catch (error) {
      flow.renderLine(message(error), "error");
      return;
    }
    for (const [harness, why] of Object.entries(report.unavailable ?? {}))
      flow.renderLine(`${harness}: ${why}`, "error");
    const choice = await flow.readSelect({
      message: `Worker accounts on ${machine.trim() || "this Mac"} — pick one to hold or release`,
      options: report.accounts.map((account) => ({
        value: `${account.harness}:${account.label}`,
        label: harnessAccountName(account),
        hint: workerAccountHint(account),
        description: account.home,
      })),
      allowBack: true,
    });
    if (choice === undefined) return;
    const account = report.accounts.find((entry) => `${entry.harness}:${entry.label}` === choice);
    if (!account) continue;
    try {
      if (account.held) {
        await workers(["release", account.harness, account.label, ...target]);
        flow.renderLine(`${harnessAccountName(account)} is back in automatic choice.`, "success");
      } else {
        const reason = await flow.readText({
          message: `Hold ${harnessAccountName(account)} from automatic choice — why? (optional)`,
          placeholder: "e.g. plan not renewed; usage saved for Clankie",
          allowBack: true,
          validate: (value) => (value.length > 200 ? "Keep it under 200 characters." : undefined),
        });
        if (reason === undefined) continue;
        await workers([
          "hold",
          account.harness,
          account.label,
          ...target,
          ...(reason.trim() ? ["--reason", reason.trim()] : []),
        ]);
        flow.renderLine(
          `Held ${harnessAccountName(account)}; an explicit hire may still name it.`,
          "success",
        );
      }
    } catch (error) {
      flow.renderLine(message(error), "error");
    }
  }
}
