import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  CONNECTOR_IMAGE_READ_BYTES_MAX,
  connectorImageMediaType,
  type SeatImageResult,
} from "@clankie/protocol/connector";

/**
 * One image a seated agent saved in its own workspace, read for a connected
 * app (ADR 0315). The workspace is the containment root, as for the images a
 * seat names in its replies (ADR 0174): the path resolves through symlinks and
 * must stay inside the workspace's real path. Only a regular file whose leading
 * bytes are a PNG, JPEG, GIF or WebP is returned, so no other file's contents
 * leave the machine this way, whatever it is called.
 */
export async function readSeatImage(input: {
  readonly workspace: string;
  readonly path: string;
}): Promise<SeatImageResult> {
  const unavailable = (message: string): SeatImageResult => ({ outcome: "unavailable", message });
  let root: string;
  try {
    root = await realpath(input.workspace);
  } catch {
    return unavailable("The agent's working directory can't be read on this machine.");
  }
  let source: string;
  try {
    source = await realpath(resolve(root, input.path));
  } catch {
    return unavailable(`There's no file at ${input.path} in the agent's working directory.`);
  }
  const inside = relative(root, source);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    return unavailable(
      "Only files inside the agent's working directory can be read. Ask the agent to save the image there, for example in .clankie/inbox/, which git ignores.",
    );
  const handle = await open(source, "r").catch(() => undefined);
  if (handle === undefined) return unavailable(`${input.path} can't be opened.`);
  try {
    const info = await handle.stat();
    if (!info.isFile()) return unavailable(`${input.path} isn't a file.`);
    if (info.size > CONNECTOR_IMAGE_READ_BYTES_MAX)
      return unavailable(
        `${input.path} is ${megabytes(info.size)} MB; images up to ${megabytes(CONNECTOR_IMAGE_READ_BYTES_MAX)} MB can be read. Ask the agent to save a smaller copy (a JPEG, or scaled to about 1600 pixels on its long side).`,
      );
    const data = await handle.readFile();
    const mediaType = connectorImageMediaType(data);
    if (mediaType === undefined || data.byteLength === 0)
      return unavailable(`${input.path} isn't a PNG, JPEG, GIF or WebP image.`);
    return {
      outcome: "ready",
      filename: basename(source).slice(0, 256),
      mediaType,
      byteCount: data.byteLength,
      dataBase64: data.toString("base64"),
    };
  } finally {
    await handle.close();
  }
}

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}
