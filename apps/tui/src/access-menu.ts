/**
 * `/access` as a modal: who holds worker access to which connected account,
 * and revoke on select. Reads and revokes go through `clankie access`.
 */
import type { ClankieFaceShell } from "./shell/shell.ts";

type Run = (args: readonly string[]) => Promise<unknown>;
type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value !== null && typeof value === "object" ? (value as Json) : {});
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface AccessGrantRow {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly active: boolean;
}

/** The grant list is the service's own record shape; read it defensively. */
export function accessGrantRows(list: unknown, now = Date.now()): AccessGrantRow[] {
  return (Array.isArray(list) ? list : []).flatMap((entry) => {
    const item = record(entry);
    const grant = record(item.grant);
    if (typeof grant.grantId !== "string") return [];
    const account = record(item.account);
    const tools = Array.isArray(item.tools) ? item.tools.length : 0;
    const state =
      item.status === "retired"
        ? "retired"
        : typeof item.revokedAt === "string"
          ? "revoked"
          : typeof grant.expiresAt === "number" && grant.expiresAt * 1000 <= now
            ? "expired"
            : "active";
    return [
      {
        id: grant.grantId,
        label: typeof item.project === "string" ? `project ${item.project}` : String(grant.principalId),
        hint: [
          String(item.server ?? "?"),
          tools ? `${tools} tools` : "all worker tools",
          ...(typeof account.name === "string" ? [account.name] : []),
          state,
        ].join(" · "),
        active: state === "active",
      },
    ];
  });
}

export async function runAccessMenu(shell: ClankieFaceShell, access: Run): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("access");
  try {
    for (;;) {
      const [list, linear] = await Promise.all([access(["list"]), access(["linear"]).catch(() => ({}))]);
      const rows = accessGrantRows(list);
      const linearAccount = record(record(linear).account);
      const live = rows.filter((row) => row.active);
      const choice = await flow.readSelect({
        message: `Worker access · ${live.length} active`,
        options: [
          {
            value: "\0linear",
            label: "Linear account",
            hint:
              typeof linearAccount.name === "string"
                ? `${linearAccount.name} · verify now`
                : String(record(linear).status ?? "not connected"),
          },
          ...live.map((row) => ({ value: row.id, label: row.label, hint: row.hint })),
          ...rows
            .filter((row) => !row.active)
            .map((row) => ({ value: row.id, label: row.label, hint: row.hint })),
        ],
        allowBack: true,
      });
      if (choice === undefined) return;
      try {
        if (choice === "\0linear") {
          await access(["linear", "verify"]);
          flow.renderLine("Linear account verified.", "success");
          continue;
        }
        const row = rows.find((entry) => entry.id === choice);
        if (!row || row.hint.endsWith("revoked")) continue;
        const confirm = await flow.readSelect({
          message: `Revoke ${row.label}?`,
          options: [
            { value: "no", label: "Keep it" },
            { value: "yes", label: "Revoke", hint: "ends its open sessions now" },
          ],
          allowBack: true,
        });
        if (confirm !== "yes") continue;
        await access(["revoke", row.id]);
        flow.renderLine(`Revoked ${row.label}.`, "success");
      } catch (error) {
        flow.renderLine(message(error), "error");
      }
    }
  } catch (error) {
    shell.insertCommandResult("/access", message(error), "error");
  } finally {
    flow.end();
  }
}
