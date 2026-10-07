import { HIRE_NO_PREFERENCE, effectiveHireProfile } from "@clankie/protocol";
import { ProjectRoleSchema, projectRolePolicy } from "@clankie/protocol/projects";
import { createModelRegistry, resolveHireModel } from "@clankie/model-registry";
import { runProjectSettingsCommand } from "./project-settings.ts";

/** Edit one role with the same revision/owner API as project settings; preserve other roles and fields. */
export async function runProjectRoleCommand(
  args: readonly string[],
  options: Parameters<typeof runProjectSettingsCommand>[1] = {},
) {
  const role = args[0];
  if (!role || args.length < 3 || args.length % 2 !== 1)
    throw new Error(
      "Usage: clankie agents role ROLE --project PROJECT [--model NAME|auto ...]; auto means no preference for harness, model and effort, inherit clears any field",
    );
  const flags = new Map<string, string>();
  const fields = [
    "project",
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
  ];
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!.replace(/^--/u, "");
    if (!args[i]!.startsWith("--") || !fields.includes(key) || flags.has(key))
      throw new Error("Unknown or duplicate role flag");
    flags.set(key, args[i + 1]!);
  }
  const projectId = flags.get("project");
  if (!projectId) throw new Error("Role profiles require --project PROJECT");
  const snapshot = await runProjectSettingsCommand(["list"], options);
  if (!snapshot || !("settings" in snapshot)) throw new Error("Project settings unavailable");
  const project = snapshot.settings.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Unknown project");
  const prior = projectRolePolicy(project, role);
  const value: Record<string, unknown> = { ...prior, role };
  // `auto` is no preference: unset, like the fleet's own `auto`, so Clankie decides per hire.
  const clears = (key: string, v: string | undefined) =>
    v === "inherit" || (v === HIRE_NO_PREFERENCE && /(^|-)(harness|model|effort)$/u.test(key));
  for (const key of ["harness", "model", "effort", "delegation", "account", "placement"]) {
    const v = flags.get(key);
    if (clears(key, v)) delete value[key];
    else if (v !== undefined) value[key] = v;
  }
  const subagents: Record<string, unknown> = { ...prior?.subagents };
  for (const key of ["model", "effort"]) {
    const v = flags.get(`subagent-${key}`);
    if (clears(`subagent-${key}`, v)) delete subagents[key];
    else if (v !== undefined) subagents[key] = v;
  }
  if (Object.keys(subagents).length) value.subagents = subagents;
  else if (prior?.subagents === null && !flags.has("subagent-model") && !flags.has("subagent-effort"))
    value.subagents = null;
  else delete value.subagents;
  if (flags.has("cap")) {
    if (flags.get("cap") === "inherit") delete value.concurrencyCap;
    else value.concurrencyCap = Number(flags.get("cap"));
  }
  if (flags.has("naming")) {
    if (flags.get("naming") === "inherit") delete value.hireNaming;
    else value.hireNaming = flags.get("naming");
  }
  const parsed = ProjectRoleSchema.parse(value);
  const catalog = await createModelRegistry({ env: options.env ?? process.env }).catalog();
  const effective = effectiveHireProfile({}, parsed, snapshot.hireDefaults);
  for (const model of [effective.model, effective.subagents?.model])
    if (model) resolveHireModel(catalog, effective.harness, model);
  const roles = project.roles.length
    ? [...project.roles]
    : ["planner", "designer", "builder", "tester", "reviewer", "researcher"].map((r) =>
        ProjectRoleSchema.parse({ role: r }),
      );
  const index = roles.findIndex((r) => r.role.toLowerCase() === parsed.role.toLowerCase());
  if (index < 0) roles.push(parsed);
  else roles[index] = parsed;
  return runProjectSettingsCommand(
    ["update", projectId, "--changes-json", JSON.stringify({ roles }), "--revision", snapshot.revision],
    options,
  );
}
