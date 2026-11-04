import {
  PROJECT_CI_STARTER_PATH,
  ProjectCiStarterRequestSchema,
  ProjectCiStarterOfferSchema,
} from "@clankie/protocol/project-ci-starter";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

/** An offer only. Applying files or opening a project PR is a separate owner-chosen action. */
export async function runProjectCiCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions & { readonly stdin?: AsyncIterable<unknown> } = {},
) {
  if (args.join(" ") !== "ci offer --json-stdin")
    throw new Error("Usage: clankie project ci offer --json-stdin");
  if (!options.stdin && process.stdin.isTTY) throw new Error("Supply the CI offer request as JSON on stdin");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of options.stdin ?? process.stdin) {
    if (typeof chunk !== "string" && !(chunk instanceof Uint8Array))
      throw new Error("CI input must be UTF-8 JSON");
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += data.byteLength;
    if (bytes > 16 * 1024) throw new Error("CI offer request is too large");
    chunks.push(data);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const input = ProjectCiStarterRequestSchema.parse(JSON.parse(text));
  const api = await ownerSettingsApi(options);
  return api.write(PROJECT_CI_STARTER_PATH, input, ProjectCiStarterOfferSchema);
}
