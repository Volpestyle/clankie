import { defineTool } from "eve/tools";
import { z } from "zod";
import { controlPlaneClient } from "../../lib/client.ts";
import { readHostFile } from "../../lib/shell.ts";

/**
 * Reading a file ([ADR 0086](../../../../docs/adr/0086-clankie-holds-a-shell.md)).
 *
 * `bash` could do this with `cat`, and it is here anyway: a first-class read
 * takes a path instead of a quoted shell string, returns line numbers he can
 * refer back to, and is `read`-class rather than `reversible-write`, so an
 * operator can allow looking at files while holding the shell itself shut.
 */
export default defineTool({
  description:
    "Read one file from the machine you live on, by absolute path. This reaches the whole filesystem, " +
    "not just your scratchpad. Use offset and limit to walk a long file rather than pulling all of it — " +
    "the result tells you totalLines and whether what you got was truncated. A 'refused' outcome with " +
    "'path_unreadable' usually means the path is wrong or is a directory; use bash with ls for those.",
  inputSchema: z.object({
    path: z.string().trim().min(1).max(4_096).describe("Absolute path of the file to read."),
    offset: z.number().int().min(1).optional().describe("1-based first line to return. Defaults to the top."),
    limit: z.number().int().min(1).max(5_000).optional().describe("How many lines to return. Defaults to 2000."),
  }),
  async execute(input) {
    return readHostFile(controlPlaneClient(), input);
  },
});
