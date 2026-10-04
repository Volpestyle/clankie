import { execFile } from "node:child_process";
import type { HerdrBinding } from "@clankie/protocol";
import { parseHerdrAgentList } from "./captain/herdr-census.ts";
import { pinHerdrEnvironment } from "./herdr-session.ts";
import { createProjectProcessObserver } from "./project-process-proof.ts";

/** Only this read's subprocesses are canceled. Existing tool-proof runners are unchanged. */
export async function membershipNativeCommand(
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  signal.throwIfAborted();
  const stdout = await new Promise<string>((resolve, reject) => {
    let error: Error | null = null;
    let output = "";
    const child = execFile(
      file,
      [...args],
      { signal, env, timeout: 5000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024, encoding: "utf8" },
      (failure, text) => {
        error = failure;
        output = text;
      },
    );
    // execFile's abort/error callback can precede close. Never release a permit then.
    child.once("close", () => (error ? reject(error) : resolve(output)));
  });
  signal.throwIfAborted();
  return stdout;
}
export function fleetMembershipNative(binding: () => Promise<HerdrBinding | undefined>) {
  return {
    async roster(current: HerdrBinding, signal: AbortSignal) {
      return parseHerdrAgentList(
        await membershipNativeCommand(
          "herdr",
          ["agent", "list"],
          signal,
          pinHerdrEnvironment({ ...process.env }, current.socketPath),
        ),
      );
    },
    async observe(pane: string, expected: HerdrBinding, signal: AbortSignal) {
      const observe = createProjectProcessObserver({
        herdrBinary: "herdr",
        binding: async () => {
          signal.throwIfAborted();
          const current = await binding();
          signal.throwIfAborted();
          return JSON.stringify(current) === JSON.stringify(expected) ? current : undefined;
        },
        run: (file, args, env) => membershipNativeCommand(file, args, signal, env),
      });
      return observe("default", pane);
    },
  };
}
