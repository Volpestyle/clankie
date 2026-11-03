import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HerdrFleet } from "../src/herdr-fleet.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { readMachineWorkerAccounts } from "../src/captain/harness-accounts.ts";
import { harnessAccountIdentities } from "../src/captain/harness-account-identities.ts";

/**
 * A PC's Codex account with two homes on one identity (#326). The service's real
 * account reader, identity grouping and hire path run; only the PC's probe answer
 * at the ssh boundary is modelled, including the slow reads seen on the real PC.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const pc: HerdrFleet = { id: "pc", session: "default", ssh: { host: "pc.invalid", shell: "posix" } };
const HOMES = ["/home/volpe/.codex", "/home/volpe/.codex-james"] as const;
const LABELS = ["default", "james"] as const;

type Home = { signedIn: boolean | null; identity?: string };
/** One entry per home, in HOMES order; `undefined` leaves that home out of the answer. */
const probe = (homes: readonly (Home | undefined)[]) =>
  JSON.stringify({
    schemaVersion: 1,
    accounts: homes.flatMap((home, index) =>
      home === undefined
        ? []
        : [
            {
              harness: "codex",
              label: LABELS[index],
              home: HOMES[index],
              signedIn: home.signedIn,
              ...(index === 0 ? { nativeDefault: true } : {}),
              ...(home.identity === undefined
                ? {}
                : { identity: home.identity, identityId: `user-${home.identity}`, plan: "pro" }),
            },
          ],
    ),
  });
const both = probe([
  { signedIn: true, identity: "owner@example.com" },
  { signedIn: true, identity: "owner@example.com" },
]);

async function hireOnPc(reads: readonly (string | Error)[]) {
  const root = await mkdtemp(join(tmpdir(), "clankie-codex-multi-home-"));
  roots.push(root);
  const registry = harnessAccountIdentities(join(root, "identities.json"));
  let read = 0;
  const shell = async () => {
    const answer = reads[Math.min(read++, reads.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
  // Creating the PC's pane is the first effect after the account checks; stop there.
  const herdr: string[] = [];
  const unexpected = async (name: string): Promise<never> => {
    throw new Error(`unexpected ${name}`);
  };
  const store = new HerdrWatchStore(join(root, "watches.json"), {
    runner: {
      get: async () => unexpected("get"),
      resolveTerminal: async () => unexpected("resolveTerminal"),
      wait: async () => unexpected("wait"),
      createTab: async () => {
        herdr.push("create");
        throw new Error("the fixture PC stops at its first Herdr effect");
      },
      startAgent: async () => unexpected("startAgent"),
    },
    remoteWorkspace: async (fleet, directory) => fleet === "pc" && directory === "/src/app",
    workerAccounts: (fleet, harness) =>
      readMachineWorkerAccounts(pc, shell, { harnesses: [harness], registry }).then((report) => {
        expect(fleet).toBe("pc");
        return report;
      }),
  });
  try {
    const result = await store.spawnSeat({
      schemaVersion: 1,
      harness: "codex",
      title: "Reader",
      workingDirectory: "/src/app",
      fleet: "pc",
    });
    return { result, herdr, reads: read };
  } finally {
    store.close();
  }
}

const reachedPc = (herdr: readonly string[]) => herdr.includes("create");

it("a signed-in identity with two homes reaches the PC's Herdr when every read answers", async () => {
  const { result, herdr } = await hireOnPc([both]);
  expect(JSON.stringify(result)).not.toContain("changed sign-in");
  expect(reachedPc(herdr)).toBe(true);
});

it("a startup re-read the PC never answered is not a sign-in change", async () => {
  const { result, herdr, reads } = await hireOnPc([both, new Error("ssh: timed out"), both]);
  expect(JSON.stringify(result)).not.toContain("changed sign-in");
  expect(reads).toBe(3);
  expect(reachedPc(herdr)).toBe(true);
});

it("the chosen home's own read timing out, twice, still launches on the verified identity", async () => {
  // Its home falls out of the identity group, standing alone with sign-in unknown.
  const slow = probe([{ signedIn: null }, { signedIn: true, identity: "owner@example.com" }]);
  const { result, herdr } = await hireOnPc([both, slow, slow]);
  expect(JSON.stringify(result)).not.toContain("changed sign-in");
  expect(reachedPc(herdr)).toBe(true);
});

it("a home re-signed to another identity during startup still refuses before any Herdr effect", async () => {
  const resigned = probe([
    { signedIn: true, identity: "someone-else@example.com" },
    { signedIn: true, identity: "someone-else@example.com" },
  ]);
  const { result, herdr } = await hireOnPc([both, resigned]);
  expect(JSON.stringify(result)).toContain("changed sign-in");
  expect(reachedPc(herdr)).toBe(false);
});

it("a home signed out during startup still refuses before any Herdr effect", async () => {
  const signedOut = probe([{ signedIn: false }, { signedIn: false }]);
  const { result, herdr } = await hireOnPc([both, signedOut]);
  expect(JSON.stringify(result)).toContain("changed sign-in");
  expect(reachedPc(herdr)).toBe(false);
});

it.each([
  ["answers with no accounts", JSON.stringify({ schemaVersion: 1, accounts: [] })],
  ["no longer lists the chosen home", probe([undefined, { signedIn: true, identity: "owner@example.com" }])],
  ["reports Codex missing", JSON.stringify({ schemaVersion: 1, accounts: [], missing: ["codex"] })],
])(
  "a re-read that %s has no verified sign-in for the chosen home and refuses before any Herdr effect",
  async (_case, reread) => {
    const { result, herdr } = await hireOnPc([both, reread]);
    expect(JSON.stringify(result)).toContain("changed sign-in");
    expect(reachedPc(herdr)).toBe(false);
  },
);
