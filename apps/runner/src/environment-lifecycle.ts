import {
  EnvironmentRuntime,
  type EnvironmentAdapter,
  type EnvironmentEventSink,
} from "@clankie/environment-runtime";

export interface RunnerEnvironmentLifecycleOptions {
  rootDir: string;
  adapter: EnvironmentAdapter;
  events: EnvironmentEventSink;
  clock?: () => Date;
}

/** Runner composition boundary; concrete game adapters remain separate. */
export function createRunnerEnvironmentLifecycle(
  options: RunnerEnvironmentLifecycleOptions,
): EnvironmentRuntime {
  return new EnvironmentRuntime(options);
}
