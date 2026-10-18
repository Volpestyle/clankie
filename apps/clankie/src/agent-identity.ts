import { homedir } from "node:os";

/**
 * The hosted body's agent identity (VUH-2320). When the image's root entrypoint
 * separates the service from model-directed work, it hands the service this
 * uid, and every such effect (the captain's coding tools, Herdr panes and the
 * workers in them, harness sign-ins) runs as it. The agent cannot write the
 * service's state, and holds no capabilities to switch back.
 */
export interface AgentIdentity {
  readonly uid: number;
  readonly gid: number;
  /** Supplementary groups, such as the one that shares `/workspace` and the Herdr socket. */
  readonly groups: readonly number[];
  readonly home: string;
}

/** Absolute, so a PATH the agent can influence never chooses the switcher. */
export const SETPRIV = "/usr/bin/setpriv";

const id = (value: string | undefined, name: string): number => {
  if (value === undefined || !/^[1-9][0-9]{0,9}$/u.test(value)) throw new Error(`Invalid ${name}`);
  return Number(value);
};

/**
 * Undefined runs everything as the service, as on a Mac or an unseparated body.
 * A partial or self-referential configuration fails closed rather than quietly
 * running agent work as the service.
 */
export function agentIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): AgentIdentity | undefined {
  if (env.CLANKIE_AGENT_UID === undefined) return undefined;
  const uid = id(env.CLANKIE_AGENT_UID, "CLANKIE_AGENT_UID");
  const gid = id(env.CLANKIE_AGENT_GID, "CLANKIE_AGENT_GID");
  const groups = (env.CLANKIE_AGENT_GROUPS ?? "")
    .split(",")
    .filter(Boolean)
    .map((group) => id(group, "CLANKIE_AGENT_GROUPS"));
  const home = env.CLANKIE_AGENT_HOME;
  if (home === undefined || !home.startsWith("/")) throw new Error("Invalid CLANKIE_AGENT_HOME");
  if (uid === process.getuid?.()) throw new Error("The agent uid must differ from the service uid");
  return { uid, gid, groups, home };
}

let cached: AgentIdentity | undefined | null = null;
/** This service's agent identity, read once from its trusted startup environment. */
export function agentIdentity(): AgentIdentity | undefined {
  if (cached === null) cached = agentIdentityFromEnv();
  return cached;
}

/** The command line that runs `command` as the agent with no capabilities. */
export function asAgent(
  identity: AgentIdentity,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  return {
    command: SETPRIV,
    args: [
      `--reuid=${identity.uid}`,
      `--regid=${identity.gid}`,
      identity.groups.length > 0 ? `--groups=${identity.groups.join(",")}` : "--clear-groups",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      "--",
      command,
      ...args,
    ],
  };
}

const SERVICE_ONLY = /^(?:CLANKIE_(?:AGENT_|CREDENTIALS_FILE$|HOSTED_BOOTSTRAP|OPERATOR_|CAPTAIN_|RUNNER_|LAUNCHER_SECRET|DEVICE_)|NODE_CHANNEL_FD$|NODE_OPTIONS$)/u;
const SECRET = /(?:TOKEN|SECRET|PASSWORD|PRIVATE|API_KEY|CREDENTIAL)/iu;

/**
 * The agent's environment: its own home and XDG roots, without the service's
 * secrets or service-only configuration. Defense in depth; the uid boundary is
 * what protects state, but nothing secret should ride along in the environment.
 */
export function agentEnvironment(identity: AgentIdentity, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || SERVICE_ONLY.test(name) || SECRET.test(name)) continue;
    result[name] = value;
  }
  const serviceHome = env.HOME ?? homedir();
  for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR"])
    delete result[name];
  if (result.PI_CODING_AGENT_DIR?.startsWith(serviceHome)) delete result.PI_CODING_AGENT_DIR;
  result.HOME = identity.home;
  result.USER = result.LOGNAME = "clankie-agent";
  return result;
}
