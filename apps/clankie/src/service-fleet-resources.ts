import { createResourceGovernor } from "@clankie/fleet-resources";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { createFleetResourceRuntime } from "./fleet-resource-runtime.ts";

/** The integration supervisor and service runtime use the same fixture-only boundary. */
export async function serviceResourceDirectory(env: NodeJS.ProcessEnv = process.env) {
  if (env.VITEST !== "true" && env.NODE_ENV !== "test")
    return { directory: undefined, dispose: async () => {} };
  const override = env.CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY?.trim();
  const directory = override ? resolve(override) : await mkdtemp(join(tmpdir(), "clankie-test-resources-"));
  const liveRegistry = resolve(userInfo().homedir, ".clankie/fleet-resources");
  // Resolve existing ancestors before mkdir, including a live registry that
  // does not exist yet beneath a symlinked owner state directory.
  const canonicalPath = async (path: string) => {
    let ancestor = path;
    const missing: string[] = [];
    for (;;) {
      try {
        return join(await realpath(ancestor), ...missing);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        missing.unshift(basename(ancestor));
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  };
  const canonicalRegistry = await canonicalPath(liveRegistry);
  const outsideLiveRegistry = (path: string) =>
    [liveRegistry, canonicalRegistry].every(
      (live) => path !== live && !path.startsWith(`${live}${sep}`) && !live.startsWith(`${path}${sep}`),
    );
  if (!outsideLiveRegistry(directory) || !outsideLiveRegistry(await canonicalPath(directory)))
    throw new Error("Test fleet resources must not overlap the live registry");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!outsideLiveRegistry(await realpath(directory)))
    throw new Error("Test fleet resources must not overlap the live registry");
  return {
    directory,
    dispose: async () => {
      if (!override) await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Only service fixtures honor this seam; worker/CLI governors always share the OS registry. */
export async function createServiceFleetResourceRuntime(
  input: Pick<Parameters<typeof createFleetResourceRuntime>[0], "policy" | "onError"> & {
    nativeSimulatorOwner?: NonNullable<Parameters<typeof createResourceGovernor>[0]>["nativeSimulatorOwner"];
  },
  env: NodeJS.ProcessEnv = process.env,
) {
  const native = input.nativeSimulatorOwner ? { nativeSimulatorOwner: input.nativeSimulatorOwner } : {};
  if (env.VITEST !== "true" && env.NODE_ENV !== "test")
    return createFleetResourceRuntime({ ...input, governor: createResourceGovernor(native) });

  const { directory, dispose } = await serviceResourceDirectory(env);
  const refuse = async (): Promise<never> => {
    throw new Error("Native simulators are unavailable in a test service");
  };
  const governor = createResourceGovernor({ ...native, ...(directory ? { directory } : {}) });
  try {
    const runtime = await createFleetResourceRuntime({
      ...input,
      governor,
      simulator: {
        adapter: {
          inventory: async () => [],
          catalog: async () => ({ deviceTypes: [], runtimes: [] }),
          create: refuse,
          boot: refuse,
          shutdown: refuse,
          delete: refuse,
        },
      },
    });
    const close = runtime.close.bind(runtime);
    runtime.close = async () => {
      await close();
      await dispose();
    };
    return runtime;
  } catch (error) {
    await governor.close();
    await dispose();
    throw error;
  }
}
