import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { briefPointer } from "../src/captain/brief-file.ts";
import { DeliveryFence, deliveryFingerprint, ReceiptSchema } from "../src/captain/delivery-fence.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createHerdrWatchRunner, HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { HireOwners } from "../src/captain/hire-owners.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);

// #615: a Claude hire whose brief went by file, interrupted by a service restart
// seconds into its start (t6v and t6z on 2026-11-03). Its pane received the
// one-line pointer to the service's brief file, and the receipt stayed uncertain,
// so every later hire into that folder was refused until a lead adopted it by
// hand. After the restart, the retried hire reconciles from the worker's own
// transcript: the pointer names the service's brief file, and that brief is the
// one the receipt fingerprinted. Real Herdr in a scratch home that refuses the
// owner's session, the real runner and transcript lookup, the restored receipt's
// live shape and a new watch store over the same state, as a restarted service
// reads it. Only `claude` is a stand-in: it reports its session to Herdr and
// waits; its transcript is the native JSONL Claude Code writes.
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const standIn = `#!${process.execPath}
import { execFileSync } from "node:child_process";
process.title = "claude";
for (const command of ["report-agent", "report-agent-session"])
  execFileSync("herdr", ["pane", command, process.env.HERDR_PANE_ID, "--source", "herdr:claude",
    "--agent", "claude", ...(command === "report-agent" ? ["--state", "idle"] : []),
    "--agent-session-id", process.env.STAND_IN_SESSION]);
setInterval(() => {}, 1 << 30);
`;

it.skipIf(process.platform !== "darwin")(
  "a brief-file hire interrupted by a restart reconciles from the brief its pointer names",
  async () => {
    const herdr = await isolatedHerdr(
      join(import.meta.dirname, "../../../.local/native-proof/brief-file-615"),
    );
    cleanups.push(() => herdr.close());
    const root = await realpath(herdr.root);
    const env = { ...herdr.env };
    const run = async (args: readonly string[]) =>
      (await exec("herdr", [...args], { env, timeout: 10_000 })).stdout;
    const runner = createHerdrWatchRunner(undefined, run, undefined, { localCodexRecovery: false });
    // This process's transcript lookup reads the scratch home's Claude config, never the owner's.
    const saved = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
    cleanups.push(() => {
      if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = saved;
    });

    // The service's state: its watch store and the brief files it writes beside it.
    const state = join(root, "captain");
    const path = join(state, "herdr-watches.json");
    await mkdir(join(state, "claude-briefs"), { recursive: true });
    const brief = "Fix #615: reconcile a brief-file hire from its own transcript.";
    const briefFile = join(state, "claude-briefs", `clankie-brief-${randomUUID()}.json`);
    await writeFile(briefFile, JSON.stringify({ clankieBrief: brief }), { mode: 0o600 });
    const decoy = join(state, "claude-briefs", `clankie-brief-${randomUUID()}.json`);
    await writeFile(decoy, JSON.stringify({ clankieBrief: "A different brief" }), { mode: 0o600 });
    // A brief-named symlink in the brief directory, pointing at a file elsewhere that
    // holds the very brief the receipt fingerprinted. Reads never follow it.
    const elsewhere = join(root, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ clankieBrief: brief }), { mode: 0o600 });
    const linked = join(state, "claude-briefs", `clankie-brief-${randomUUID()}.json`);
    await symlink(elsewhere, linked);

    // Each hire's pane holds a Claude Code session launched in its start folder.
    const hire = async (pane: string, folder: string) => {
      const cwd = join(root, folder);
      const session = randomUUID();
      await mkdir(cwd, { recursive: true });
      await writeFile(join(root, "claude"), standIn);
      await chmod(join(root, "claude"), 0o755);
      await herdr.cli(
        "pane",
        "run",
        pane,
        `cd '${cwd}' && STAND_IN_SESSION=${session} '${join(root, "claude")}'`,
      );
      await expect
        .poll(async () => (await runner.get(pane)).session !== undefined, { timeout: 15_000 })
        .toBe(true);
      const agent = await runner.get(pane);
      expect(agent.agent).toBe("claude");
      return { cwd, session, agent };
    };
    const received = async (session: string, text: string) => {
      const transcript = join(env.CLAUDE_CONFIG_DIR!, "projects", "-scratch", `${session}.jsonl`);
      await mkdir(join(env.CLAUDE_CONFIG_DIR!, "projects", "-scratch"), { recursive: true });
      await writeFile(
        transcript,
        `${JSON.stringify({ type: "user", uuid: randomUUID(), parentUuid: null, sessionId: session, message: { role: "user", content: text } })}\n`,
      );
    };
    const ok = await hire(herdr.pane, "t6v");
    const other = await hire(herdr.foreignPane, "t6z");
    const third = (
      await herdr.cli("pane", "split", herdr.pane, "--direction", "down", "--cwd", root, "--no-focus")
    ).result.pane.pane_id as string;
    const viaLink = await hire(third, "t70");
    // t6v received the pointer to its brief; t6z a pointer to a different brief file;
    // t70 a pointer to the symlink.
    await received(ok.session, briefPointer(briefFile));
    await received(other.session, briefPointer(decoy));
    await received(viaLink.session, briefPointer(linked));
    for (const { agent } of [ok, other, viaLink])
      await expect
        .poll(
          async () =>
            (await runner.transcript!(agent))?.entries.some(
              (entry) => entry.type === "message" && entry.role === "operator",
            ),
          {
            timeout: 10_000,
          },
        )
        .toBe(true);

    // What the restart left behind: an uncertain receipt and a pending owner for each pane,
    // in the live receipt's shape.
    const golden = JSON.parse(
      await readFile(new URL("./fixtures/hire-receipts/brief-file-restart.json", import.meta.url), "utf8"),
    );
    const lead = { conversationId: golden.owner.conversationId as string };
    const fence = new DeliveryFence(`${path}.hire-receipts.json`);
    const owners = new HireOwners(`${path}.owners.json`);
    for (const { cwd, session, agent } of [ok, other, viaLink]) {
      fence.begin(
        JSON.stringify(["local", "claude", cwd, "new"]),
        ReceiptSchema.parse({
          ...golden.receipt,
          messageId: randomUUID(),
          fingerprint: deliveryFingerprint(brief),
          sessionId: session,
          occupantId: occupantIdForHerdrSession(agent.session!),
          paneId: agent.paneId,
        }),
      );
      owners.bind(agent.paneId, lead);
    }

    // The restarted service: a new store over the same state, and the lead retries each hire.
    const store = new HerdrWatchStore(path, { runner });
    cleanups.push(() => store.close());
    const authority = { owner: lead, current: () => true, authorize: async () => true };
    const retry = (cwd: string) =>
      store.spawnSeat(
        { schemaVersion: 1, harness: "claude", title: "Brief-file proof", workingDirectory: cwd },
        undefined,
        brief,
        undefined,
        authority,
      );
    const reconciled = await retry(ok.cwd);
    expect(reconciled).toMatchObject({ outcome: "spawned", seat: { paneId: herdr.pane } });
    // Read back as the next restart would: the receipt is no longer uncertain.
    expect(
      new DeliveryFence(`${path}.hire-receipts.json`).pending(
        JSON.stringify(["local", "claude", ok.cwd, "new"]),
      ),
    ).toBeUndefined();
    expect(store.nativeOwner(await runner.get(herdr.pane))).toEqual(lead);
    // A pointer to any other brief file proves nothing: that hire stays uncertain.
    expect(await retry(other.cwd)).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
    // Nor does a symlink in the brief directory, even to the same brief.
    expect(await retry(viaLink.cwd)).toMatchObject({ outcome: "failed", reason: "delivery_unconfirmed" });
  },
  90_000,
);
