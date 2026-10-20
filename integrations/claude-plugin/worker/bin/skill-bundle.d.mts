/** Authored skills every native worker receives, with or without the repository. */
export const WORKER_SKILLS: readonly string[];
/** Refresh canonical checkout content, or validate a standalone regular snapshot. */
export function prepareWorkerSkill(workerRoot: string): Promise<void>;
