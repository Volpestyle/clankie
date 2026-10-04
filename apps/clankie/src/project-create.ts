import { createModelRegistry, resolveHireModel } from "@clankie/model-registry";
import { effectiveHireProfile } from "@clankie/protocol";
import { isDeepStrictEqual } from "node:util";
import {
  createProjectSettings,
  observeProjectEnrollment,
  projectsRevision,
  type SettingsStore,
} from "@clankie/settings";
import type { CreateProjectSettings } from "@clankie/protocol/projects";

/** The direct owner route and question confirmation share this existing commit boundary. */
export async function applyProjectCreate(
  settings: Pick<SettingsStore, "load" | "update">,
  input: CreateProjectSettings,
  requireOwner: () => Promise<void>,
  expectedObservation?: Awaited<ReturnType<typeof observeProjectEnrollment>>,
) {
  const original = await settings.load();
  createProjectSettings(original.projects, input);
  const catalog = await createModelRegistry().catalog();
  for (const role of input.roles ?? []) {
    const profile = effectiveHireProfile({}, role, original.fleet.hire);
    for (const model of [profile.model, profile.subagents?.model])
      if (model) resolveHireModel(catalog, profile.harness, model);
  }
  await requireOwner();
  const initial = await observeProjectEnrollment(original.projects, input);
  if (expectedObservation && !isDeepStrictEqual(initial, expectedObservation))
    throw new Error("Project enrollment changed");
  await requireOwner();
  let before: string | undefined;
  const updated = await settings.update(
    (current) => {
      before = JSON.stringify(current);
      return { ...current, projects: createProjectSettings(current.projects, input) };
    },
    async () => {
      await requireOwner();
      const current = await settings.load();
      if (JSON.stringify(current) !== before) throw new Error("Settings changed");
      if (!isDeepStrictEqual(await observeProjectEnrollment(current.projects, input), initial))
        throw new Error("Project workspace or tracker changed");
      await requireOwner();
      if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
      // Recheck the conversation/owner after the final settings await, too.
      await requireOwner();
    },
  );
  return { settings: updated.projects, revision: projectsRevision(updated.projects) };
}
