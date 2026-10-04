import { writeFile } from "node:fs/promises";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { ComputerRequestSchema, ComputerFrameSchema } from "@clankie/interactive-environment";
import { commandHost } from "./io.ts";
import type { BrowserCommandOptions } from "./browser.ts";

export async function runComputerCommand(
  args: readonly string[],
  options: BrowserCommandOptions = {},
): Promise<unknown> {
  if (
    (args.length !== 2 && !(args.length === 4 && args[2] === "--image-path" && args[3])) ||
    args[0] !== "request"
  )
    throw new Error(
      "Usage: clankie computer request JSON [--image-path NEW_PNG_PATH] (conversationId and command)",
    );
  const request = ComputerRequestSchema.parse(JSON.parse(args[1]!));
  if (args.length === 4 && request.command.action !== "frame")
    throw new Error("--image-path requires a frame request");
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (!credential?.token) throw new Error("No operator credential is available");
  const response = await (options.fetchImpl ?? fetch)(
    new URL("/v1/computer", commandHost({ ...options, env })),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(120000),
    },
  );
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(`Computer request failed (${response.status}): ${JSON.stringify(result)}`);
  if (args.length === 4) {
    const frame = ComputerFrameSchema.parse(result);
    await writeFile(args[3]!, Buffer.from(frame.data, "base64"), { flag: "wx", mode: 0o600 });
    const { data: _data, ...metadata } = frame;
    return { ...metadata, imagePath: args[3] };
  }
  return result;
}
