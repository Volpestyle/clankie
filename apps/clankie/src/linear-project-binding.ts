import type { TrackerToolBackend } from "@clankie/work-items";

/** Validate only through the connected Linear adapter; callers never pass the local fallback. */
export async function linearProjectExists(
  tracker: Pick<TrackerToolBackend, "call">,
  id: string,
): Promise<boolean> {
  try {
    const project = (await tracker.call("get_project", { query: id })) as { id?: unknown };
    return project.id === id;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "not_found") return false;
    throw error;
  }
}
