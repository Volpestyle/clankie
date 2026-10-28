// `clankie` on a linked machine (VUH-2923). Claude Code puts this plugin's
// bin/ on PATH after the machine's own PATH, so a machine with Clankie's CLI
// installed keeps it; one in his fleet with only Node gets these commands,
// which reach his service through this pane's fleet link and carry no
// operator credential.
import { linkEvidenceClient, pushEvidence } from "./evidence-push.mjs";
import { authorization, readLink, seatRoute } from "./link.mjs";

const USAGE =
  "Usage: clankie evidence push [PATH] --issue KEY [--caption TEXT]\n" +
  "This machine has only the fleet worker's clankie; other commands run on Clankie's own machine.";

/** The pane's proven seat route, as `clankie review submit` reaches it. */
function paneEvidenceClient(env) {
  const pane = env.HERDR_PANE_ID?.trim();
  const link = readLink(env.HERDR_SOCKET_PATH, env);
  if (!link || !pane)
    throw new Error(
      "Run clankie evidence push in your own fleet pane: its link proves which seat sends the evidence.",
    );
  const headers = link.authentication === "local-process" ? { "x-clankie-pane": pane } : authorization(link);
  return linkEvidenceClient({
    origin: link.url,
    headers,
    request: (route, suffix = "", init = {}) =>
      fetch(`${seatRoute(link, pane, route).href}${suffix}`, {
        ...init,
        headers: { ...headers, "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }),
  });
}

async function run(args, env = process.env) {
  const [command, verb, ...rest] = args;
  if (command !== "evidence" || verb !== "push") throw new Error(USAGE);
  const positional = [];
  const values = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg.startsWith("--")) {
      const value = rest[index + 1];
      if (!["--issue", "--caption"].includes(arg) || value === undefined || values.has(arg))
        throw new Error(USAGE);
      values.set(arg, value);
      index += 1;
    } else positional.push(arg);
  }
  if (positional.length > 1 || !values.has("--issue")) throw new Error(USAGE);
  return pushEvidence(
    {
      ...(positional[0] === undefined ? {} : { path: positional[0] }),
      issueKey: values.get("--issue"),
      ...(values.has("--caption") ? { caption: values.get("--caption") } : {}),
    },
    { client: async () => paneEvidenceClient(env) },
  );
}

run(process.argv.slice(2)).then(
  (result) => {
    process.stderr.write(`${result.summary}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
  },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
