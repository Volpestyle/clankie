import { OPERATOR_AGENT_ROLES } from "@clankie/protocol";
import { ProjectsSnapshotSchema, projectRolePolicy, type Project } from "@clankie/protocol/projects";
import { runProjectSettingsCommand } from "./command/project-settings.ts";
import { runProjectRoleCommand } from "./command/project-role.ts";
import type { ClankieFaceShell } from "./shell/shell.ts";

type RolePolicy = NonNullable<ReturnType<typeof projectRolePolicy>>;
/** Flag name for `agents role`, and where the saved value lives on the policy. */
const ROLE_FIELDS: readonly {
  readonly flag: string;
  readonly label: string;
  read(p: RolePolicy): unknown;
}[] = [
  { flag: "harness", label: "Harness", read: (p) => p.harness },
  { flag: "model", label: "Model", read: (p) => p.model },
  { flag: "effort", label: "Effort", read: (p) => p.effort },
  { flag: "subagent-model", label: "Subagent model", read: (p) => p.subagents?.model },
  { flag: "subagent-effort", label: "Subagent effort", read: (p) => p.subagents?.effort },
  { flag: "delegation", label: "Delegation", read: (p) => p.delegation },
  { flag: "account", label: "Account", read: (p) => p.account },
  { flag: "placement", label: "Placement", read: (p) => p.placement },
  { flag: "cap", label: "Concurrency cap", read: (p) => p.concurrencyCap },
  { flag: "naming", label: "Hire naming", read: (p) => p.hireNaming },
];
/** Launch choices where unset is the owner's "no preference": Clankie decides per hire. */
const PREFERENCE_FIELDS = new Set(["harness", "model", "effort", "subagent-model", "subagent-effort"]);
const unset = (value: unknown) => value === undefined || value === null;
const shown = (flag: string, value: unknown) =>
  unset(value) ? (PREFERENCE_FIELDS.has(flag) ? "no preference" : "inherit") : String(value);

/** One-line role summary: only the fields the owner actually set. */
function roleSummary(policy: RolePolicy | undefined): string {
  if (!policy) return "built-in";
  const set = ROLE_FIELDS.flatMap((field) => {
    const value = field.read(policy);
    return value === undefined || value === null ? [] : [`${field.flag} ${String(value)}`];
  });
  return set.length ? set.join(" · ") : "inherits fleet defaults";
}

const listProjects = async () => ProjectsSnapshotSchema.parse(await runProjectSettingsCommand(["list"]));
async function readProject(projectId: string): Promise<Project | undefined> {
  return (await listProjects()).settings.projects.find((p) => p.id === projectId);
}

/** Guided editor for the owner settings, using the revision-bearing project API. */
export async function runProjectRolesMenu(shell: ClankieFaceShell, projectId?: string): Promise<void> {
  const flow = shell.setupFlow;
  flow.begin("project roles");
  try {
    if (projectId === undefined) {
      const snapshot = await listProjects();
      if (!snapshot.settings.projects.length) {
        flow.renderLine("Create a project before defining hire roles.");
        return;
      }
      const chosen = await flow.readSelect({
        message: "Project",
        options: snapshot.settings.projects.map((p) => ({ value: p.id, label: p.name, hint: p.id })),
      });
      if (!chosen) return;
      projectId = chosen;
    }
    for (;;) {
      const project = await readProject(projectId);
      if (!project) return;
      const roles = project.roles.length ? project.roles.map((r) => r.role) : [...OPERATOR_AGENT_ROLES];
      const selected = await flow.readSelect({
        message: `${project.name} · hire roles`,
        options: [
          ...roles.map((role) => ({
            value: role,
            label: role,
            hint: roleSummary(projectRolePolicy(project, role)),
          })),
          { value: "add", label: "Add a role…" },
        ],
        allowBack: true,
      });
      if (!selected) return;
      const role =
        selected === "add"
          ? (await flow.readText({ message: "Role name", allowBack: true }))?.trim()
          : selected;
      if (!role) continue;
      await editRole(shell, projectId, role);
    }
  } finally {
    flow.end();
  }
}

async function editRole(shell: ClankieFaceShell, projectId: string, role: string): Promise<void> {
  const flow = shell.setupFlow;
  for (;;) {
    const project = await readProject(projectId);
    if (!project) return;
    const policy = projectRolePolicy(project, role) ?? { role };
    const field = await flow.readSelect({
      message: `${project.name} · ${role}`,
      options: ROLE_FIELDS.map((entry) => ({
        value: entry.flag,
        label: entry.label,
        hint: shown(entry.flag, entry.read(policy)),
      })),
      allowBack: true,
    });
    if (!field) return;
    const current = ROLE_FIELDS.find((entry) => entry.flag === field)?.read(policy);
    const preference = PREFERENCE_FIELDS.has(field);
    const value = await flow.readText({
      message: preference
        ? `${role} ${field} (auto: no preference, Clankie decides per hire)`
        : `${role} ${field} (inherit clears it)`,
      ...(unset(current) ? (preference ? { defaultValue: "auto" } : {}) : { defaultValue: String(current) }),
      placeholder:
        field === "delegation"
          ? "native-first or panes"
          : field === "placement"
            ? "new-tab or split"
            : preference
              ? "auto, or a friendly model, level or harness"
              : "friendly model, level or label",
      allowBack: true,
    });
    if (!value?.trim()) continue;
    try {
      await runProjectRoleCommand([role, "--project", projectId, `--${field}`, value.trim()]);
      flow.renderLine(`${role} ${field}: ${value.trim()}`, "success");
    } catch (error) {
      flow.renderLine(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
