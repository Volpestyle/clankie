import { runProjectSettingsCommand } from "./command/project-settings.ts";
import { runProjectRoleCommand } from "./command/project-role.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

/** Guided editor for the owner settings, using the revision-bearing project API. */
export async function runProjectRolesMenu(shell: ClankieFaceShell): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("project roles");
  try {
    const snapshot = await runProjectSettingsCommand(["list"]);
    if (!snapshot || !("settings" in snapshot)) throw new Error("Project settings unavailable");
    if (!snapshot.settings.projects.length) {
      flow.renderLine("Create a project before defining hire roles.");
      return;
    }
    const projectId = await flow.readSelect({
      message: "Project",
      options: snapshot.settings.projects.map((p) => ({ value: p.id, label: p.name })),
    });
    const project = snapshot.settings.projects.find((p) => p.id === projectId);
    if (!project) return;
    const roles = project.roles.length
      ? project.roles.map((r) => r.role)
      : ["planner", "designer", "builder", "tester", "reviewer", "researcher"];
    const selected = await flow.readSelect({
      message: "Hire role",
      options: [
        ...roles.map((role) => ({ value: role, label: role })),
        { value: "add", label: "Add a role" },
      ],
      allowBack: true,
    });
    if (!selected) return;
    const role =
      selected === "add" ? await flow.readText({ message: "Role name", allowBack: true }) : selected;
    if (!role) return;
    for (;;) {
      const field = await flow.readSelect({
        message: `${role} hire profile`,
        options: [
          ...[
            "harness",
            "model",
            "effort",
            "subagent-model",
            "subagent-effort",
            "delegation",
            "account",
            "placement",
            "cap",
            "naming",
          ].map((value) => ({ value, label: value })),
          { value: "done", label: "Done" },
        ],
        allowBack: true,
      });
      if (!field || field === "done") return;
      const value = await flow.readText({
        message: `${field} (inherit clears this preference)`,
        placeholder:
          field === "delegation"
            ? "native-first or panes"
            : field === "placement"
              ? "new-tab or split"
              : "friendly model, level or label",
        allowBack: true,
      });
      if (!value?.trim()) continue;
      const result = await runProjectRoleCommand([role, "--project", project.id, `--${field}`, value.trim()]);
      flow.renderLine(JSON.stringify(result, null, 2), "success");
    }
  } finally {
    flow.end();
  }
}
