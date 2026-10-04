import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { WorkConventionSchema, type WorkConvention } from "@clankie/protocol/work-items";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import { projectWorkRepoId } from "./project-work-items.ts";
import { deliveryFingerprint } from "./captain/delivery-fence.ts";

export interface WorkWriteAuthority {
  readonly principal: { readonly kind: "operator" | "device"; readonly id: string };
  readonly authorize: () => Promise<boolean>;
  readonly current: () => boolean;
}

export interface WorkProjectFence {
  readonly projects: ProjectsSettings;
  readonly assertCurrent: () => void;
}

/** Capture the saved tracker, without discovery, enrollment or a path supplied by a device. */
export async function prepareWorkWriteTarget(options: {
  repoId: string;
  localMachineId?: string;
  projectsFence?: () => Promise<WorkProjectFence>;
  locate: () => Promise<{ path: string; assertCurrent: () => void }>;
}): Promise<{ path: string; convention: WorkConvention; binding: string; assertCurrent(): void }> {
  let path: string;
  let projectBinding: unknown;
  let assertBinding: () => void;
  if (/^project-[a-f0-9]{48}$/u.test(options.repoId)) {
    if (!options.projectsFence) throw new Error("Project work settings cannot be checked here.");
    const snapshot = await options.projectsFence();
    const project = snapshot.projects.projects.find(
      (entry) => projectWorkRepoId(entry.id) === options.repoId,
    );
    const workspace = project?.workspaces.find((entry) => entry.id === project.trackerRef?.workspaceId);
    if (
      !project?.trackerRef ||
      !workspace ||
      workspace.machineId !== options.localMachineId ||
      workspace.platform !== (process.platform === "win32" ? "windows" : "posix")
    )
      throw new Error("This project’s saved work tracker is not available on this machine.");
    path = workspace.path;
    projectBinding = project;
    assertBinding = snapshot.assertCurrent;
  } else {
    const registered = await options.locate();
    path = registered.path;
    assertBinding = registered.assertCurrent;
  }
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
    throw new Error("This saved work tracker is not available.");
  const observe = () => {
    if (realpathSync(path) !== path) throw new Error("Workspace path changed.");
    const directory = statSync(path);
    if (!directory.isDirectory()) throw new Error("Workspace is unavailable.");
    const file = join(path, ".clankie", "tracking.json");
    if (realpathSync(file) !== file) throw new Error("Tracker path changed.");
    const raw = readFileSync(file, "utf8");
    return { directory: [directory.dev, directory.ino], raw };
  };
  assertBinding();
  const initial = observe();
  const convention = WorkConventionSchema.parse(JSON.parse(initial.raw));
  const fingerprint = JSON.stringify(initial);
  return {
    path,
    convention,
    binding: deliveryFingerprint(JSON.stringify([path, projectBinding, initial])),
    assertCurrent: () => {
      assertBinding();
      if (JSON.stringify(observe()) !== fingerprint) throw new Error("Saved work tracker changed.");
    },
  };
}
