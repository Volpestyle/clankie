import { createModelRegistry, resolveHireModel } from "@clankie/model-registry";
import { effectiveHireProfile } from "@clankie/protocol";
import { isDeepStrictEqual } from "node:util";
import {
  createProjectSettings,
  observeProjectEnrollment,
  projectsRevision,
  observeProjectTrackerSetup,
  type SettingsStore,
} from "@clankie/settings";
import type { CreateProjectSettings } from "@clankie/protocol/projects";
import { initializeConvention } from "@clankie/work-items";

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
  let initial = await observeProjectEnrollment(original.projects, input);
  if (expectedObservation && !isDeepStrictEqual(initial, expectedObservation))
    throw new Error("Project enrollment changed");
  if (input.trackerSetup) {
    const reviewed = initial;
    let trackerParent = reviewed.trackerSetup?.parent;
    await initializeConvention(input.workspacePath, input.trackerSetup, {
      createOnly: true,
      guard: async () => {
        await requireOwner();
        const current = await settings.load();
        if (projectsRevision(current.projects) !== input.expectedRevision)
          throw new Error("Project settings changed");
        const observation = await observeProjectEnrollment(current.projects, input);
        if (
          !isDeepStrictEqual(observation.directories, reviewed.directories) ||
          (trackerParent && !isDeepStrictEqual(observation.trackerSetup?.parent, trackerParent))
        )
          throw new Error("Project workspace changed");
        // Pin the newly created parent on the first post-mkdir guard too.
        trackerParent ??= observation.trackerSetup?.parent;
        await observeProjectTrackerSetup(input.workspacePath);
        await requireOwner();
      },
    });
    // Setup is part of the reviewed CREATE, consumed once by its question claim.
    input = { ...input, trackerSetup: undefined };
    initial = await observeProjectEnrollment(original.projects, input);
    if (!isDeepStrictEqual(initial.directories, reviewed.directories))
      throw new Error("Project workspace changed after tracker setup");
  }
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
