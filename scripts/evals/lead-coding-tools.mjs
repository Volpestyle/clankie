/** Pi operations enter one immutable helper through the probed native sandbox. */
import { relative, isAbsolute, posix } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { nativePermissionProfile } from "./lead-native-policy.mjs";
import { nativeRuntimeEvidence } from "./lead-native-capability.mjs";
const {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createBashToolDefinition,
} = await import(
  new URL("../../apps/clankie/node_modules/@earendil-works/pi-coding-agent/dist/index.js", import.meta.url)
    .href
);
const LIMIT = 1024 * 1024;

export function createContainedCodingTools({ container, cwd, hostCwd = cwd, admit }) {
  nativePermissionProfile(cwd);
  const signals = new AsyncLocalStorage();
  const pathInContainer = (path) => {
    if (typeof path !== "string") throw Error("Unknown coding path");
    if (path === cwd || path.startsWith(cwd + "/")) return path;
    const rel = relative(hostCwd, path);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel))
      throw Error("Coding path outside allocation");
    return posix.join(cwd, rel);
  };
  const proof = nativeRuntimeEvidence(container.capability);
  if (
    !proof.codingHelper ||
    proof.codingHelper.sha256 !== proof.source.codingHelper ||
    proof.codingHelper.supervisorSha256 !== proof.source.codingSupervisor ||
    proof.binaries["/usr/local/lib/lead-coding-supervisor.mjs"] !== proof.source.codingSupervisor ||
    proof.codingHelper.descendantSettlement?.namespaceGone !== true ||
    proof.codingHelper.descendantSettlement?.noLateWrite !== true ||
    proof.binaries["/usr/local/lib/lead-coding-helper.mjs"] !== proof.source.codingHelper
  )
    throw Error("Actual coding helper execution capability is missing");
  const execute = async (request, signal = signals.getStore()) => {
    if (request.path !== undefined) request = { ...request, path: pathInContainer(request.path) };
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > LIMIT) throw Error("Coding tool input exceeds bound");
    try {
      await admit();
      if (signal?.aborted) throw Error("Coding operation cancelled before dispatch");
      const output = await container.exec(
        [
          "/usr/bin/env",
          "-i",
          "PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
          "HOME=/tmp",
          "CODEX_HOME=/eval/control/coding-helper",
          "/usr/local/bin/node",
          "/usr/local/lib/lead-coding-supervisor.mjs",
          cwd,
        ],
        { input, signal, timeoutMs: 30_000 },
      );
      if (Buffer.byteLength(output) > LIMIT + 64 * 1024) throw Error("Coding helper output exceeds bound");
      const envelope = JSON.parse(output);
      if (
        envelope.settlement?.complete !== true ||
        !Number.isSafeInteger(envelope.settlement.helperPid) ||
        typeof envelope.settlement.helperStart !== "string" ||
        !/^pid:\[[0-9]+\]$/u.test(envelope.settlement.namespace)
      )
        throw Error("Trusted coding supervisor settlement is missing");
      const result = envelope.result;
      if (
        request.op === "read"
          ? typeof result.content !== "string"
          : request.op === "bash"
            ? typeof result.output !== "string" || !Number.isSafeInteger(result.exitCode)
            : result.ok !== true
      )
        throw Error("Malformed contained operation result");
      await admit();
      return result;
    } catch (error) {
      await container.stop("contained coding operation failed or lost settlement");
      throw error;
    }
  };
  const readFile = async (path) => {
    const result = await execute({ op: "read", path });
    if (typeof result.content !== "string") throw Error("Malformed contained text read");
    return Buffer.from(result.content);
  };
  const ok = async (request) => {
    if ((await execute(request)).ok !== true) throw Error("Malformed coding operation result");
  };
  const read = createReadToolDefinition(cwd, {
    autoResizeImages: false,
    operations: {
      readFile,
      access: (path) => ok({ op: "access", path }),
      detectImageMimeType: async () => undefined,
    },
  });
  const edit = createEditToolDefinition(cwd, {
    operations: {
      readFile,
      access: (path) => ok({ op: "access", path }),
      writeFile: (path, content) => ok({ op: "write", path, content }),
    },
  });
  const write = createWriteToolDefinition(cwd, {
    operations: {
      mkdir: (path) => ok({ op: "mkdir", path }),
      writeFile: (path, content) => ok({ op: "write", path, content }),
    },
  });
  // Reuse schema/metadata only; the SDK executor spills large output to host temp files.
  const bash = {
    ...createBashToolDefinition(cwd, { exposeSessionEnvironment: false }),
    description:
      "Run bash inside the allocated isolated workspace. Output and runtime are bounded; no host output file is created.",
    execute: async (_id, parameters, signal) => {
      const result = await execute({ op: "bash", command: parameters.command }, signal);
      if (typeof result.output !== "string" || !Number.isSafeInteger(result.exitCode))
        throw Error("Malformed contained shell result");
      return {
        content: [
          { type: "text", text: result.output + (result.exitCode ? `\nExit code: ${result.exitCode}` : "") },
        ],
        details: {},
        isError: result.exitCode !== 0,
      };
    },
  };
  return [read, edit, write, bash].map((definition) => ({
    ...definition,
    execute: (id, parameters, signal, update, context) =>
      signals.run(signal, () => definition.execute(id, parameters, signal, update, context)),
  }));
}
