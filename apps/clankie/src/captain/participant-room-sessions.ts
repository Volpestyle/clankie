import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { HerdrWatchRunner, HerdrAgentSnapshot } from "./herdr-watch.ts";
import { isParticipantRoomProfile } from "./participant-room-profile.ts";
import { nativeSessionId } from "./native-session-resume.ts";

const LaunchSchema = z
  .object({
    phase: z.enum(["starting", "waiting", "ready", "uncertain"]),
    paneId: z.string().optional(),
  })
  .strict();
const JournalSchema = z.record(z.string().regex(/^room-[a-f0-9]{24}$/u), LaunchSchema);
type Launch = z.infer<typeof LaunchSchema>;

/** Owner-configured character runtimes, not machine-authorized fleet workers. */
export class ParticipantRoomSessions {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly path: string;
  private readonly launches: Record<string, Launch>;
  private journalError = false;
  private allocation: Promise<void> = Promise.resolve();

  private readonly options: {
    stateDir: string;
    runner: HerdrWatchRunner;
    bound(conversationId: string, pane: HerdrAgentSnapshot): boolean;
    sessionId(conversationId: string): string | undefined;
    retire(conversationId: string): void;
    attach(conversationId: string, pane: HerdrAgentSnapshot): void;
    signal: AbortSignal;
    startupMs?: number;
  };

  public constructor(options: ParticipantRoomSessions["options"]) {
    this.options = options;
    this.path = join(options.stateDir, "participant-room-launches.json");
    this.launches = Object.create(null) as Record<string, Launch>;
    try {
      if (existsSync(this.path))
        Object.assign(this.launches, JournalSchema.parse(JSON.parse(readFileSync(this.path, "utf8"))));
    } catch {
      // Preserve the journal for inspection; a damaged room journal must not
      // bring down the service or authorize duplicate native allocations.
      this.journalError = true;
    }
  }

  public async ensure(input: { conversationId: string; cwd: string; guard(): Promise<void> }): Promise<void> {
    const previous = this.pending.get(input.conversationId);
    if (previous) {
      await previous;
      await input.guard();
      return;
    }
    const priorAllocation = this.allocation;
    const work = priorAllocation.then(() => this.start(input));
    this.allocation = work.then(
      () => {},
      () => {},
    );
    this.pending.set(input.conversationId, work);
    try {
      await work;
    } finally {
      if (this.pending.get(input.conversationId) === work) this.pending.delete(input.conversationId);
    }
  }

  public async assertCurrent(conversationId: string, cwd: string): Promise<void> {
    const launch = this.launches[conversationId];
    if (!launch?.paneId) throw new Error("participant_session_unavailable");
    const pane = await this.options.runner.resolveTerminal(launch.paneId);
    await this.assertProfile(pane, cwd);
    this.options.signal.throwIfAborted();
    if (!pane || !this.options.bound(conversationId, pane))
      throw new Error("participant_session_disconnected");
  }

  private async assertProfile(pane: HerdrAgentSnapshot | undefined, cwd: string): Promise<void> {
    if (!pane || pane.agent !== "claude" || resolve(pane.workingDirectory ?? "") !== resolve(cwd))
      throw new Error("participant_session_profile_required");
    const processes = await this.options.runner.paneProcesses?.(pane.paneId);
    if (!processes?.some((process) => process.argv && isParticipantRoomProfile(process.argv)))
      throw new Error("participant_session_profile_required");
  }

  private save(id: string, launch: Launch): void {
    this.launches[id] = launch;
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.launches), { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  private async start(input: { conversationId: string; cwd: string; guard(): Promise<void> }): Promise<void> {
    if (this.journalError) throw new Error("participant_launch_journal_requires_repair");
    await input.guard();
    this.options.signal.throwIfAborted();
    const runner = this.options.runner;
    if (!runner.list || !runner.createTab || !runner.paneProcesses)
      throw new Error("participant_native_runtime_unavailable");
    // A complete native inventory reconciles an uncertain allocation; it never
    // authorizes replay merely because a response or channel ACK was lost.
    const inventory = await runner.list();
    await input.guard();
    const matches = inventory.filter(
      (pane) => resolve(pane.workingDirectory ?? "") === resolve(input.cwd) && pane.agent === "claude",
    );
    if (matches.length > 1) throw new Error("participant_session_ambiguous");
    const expectedSession = this.options.sessionId(input.conversationId);
    if (matches[0] && expectedSession !== undefined && nativeSessionId(matches[0]) !== expectedSession)
      throw new Error("participant_session_changed");
    let launch = this.launches[input.conversationId];
    if (matches[0]) {
      await this.assertProfile(matches[0], input.cwd);
      launch = { phase: "waiting", paneId: matches[0].paneId };
      this.save(input.conversationId, launch);
    }
    let paneExists = launch?.paneId ? await runner.resolveTerminal(launch.paneId) : undefined;
    await input.guard();
    if (paneExists?.agent === "shell") paneExists = undefined;
    if (!paneExists) {
      if (launch?.phase === "starting" || launch?.phase === "uncertain")
        throw new Error("participant_start_uncertain_inspect_original_pane");
      const occupied = await Promise.all(
        Object.entries(this.launches)
          .filter(([id]) => id !== input.conversationId)
          .map(async ([, entry]) =>
            entry.paneId ? (await runner.resolveTerminal(entry.paneId)) !== undefined : true,
          ),
      );
      // Match the existing four-room admission budget; a Discord burst cannot
      // allocate an unbounded fleet of native processes.
      if (occupied.filter(Boolean).length >= 4) throw new Error("participant_session_capacity");
      await input.guard();
      this.options.retire(input.conversationId);
      mkdirSync(input.cwd, { recursive: true, mode: 0o700 });
      this.save(input.conversationId, { phase: "starting" });
      try {
        const sessionId = this.options.sessionId(input.conversationId);
        const paneId = await runner.createTab({
          cwd: input.cwd,
          label: "Clankie · Discord character",
          command: [
            "clankie",
            "claude",
            "--conversation",
            input.conversationId,
            ...(sessionId ? ["--resume", sessionId] : []),
          ],
        });
        launch = { phase: "waiting", paneId };
        this.save(input.conversationId, launch);
      } catch (error) {
        this.save(input.conversationId, { phase: "uncertain" });
        throw error;
      }
    }
    const deadline = Date.now() + (this.options.startupMs ?? 30_000);
    let attached = false;
    while (Date.now() < deadline) {
      this.options.signal.throwIfAborted();
      await input.guard();
      paneExists = launch?.paneId ? await runner.resolveTerminal(launch.paneId) : undefined;
      if (!attached && paneExists?.agent === "claude" && nativeSessionId(paneExists) !== undefined) {
        await this.assertProfile(paneExists, input.cwd);
        if (expectedSession !== undefined && nativeSessionId(paneExists) !== expectedSession)
          throw new Error("participant_session_changed");
        const matching = (await runner.list()).filter(
          (pane) => nativeSessionId(pane) === nativeSessionId(paneExists!),
        );
        if (matching.length !== 1 || matching[0]!.paneId !== paneExists.paneId)
          throw new Error("participant_session_ambiguous");
        await input.guard();
        this.options.attach(input.conversationId, paneExists);
        attached = true;
      }
      if (paneExists && this.options.bound(input.conversationId, paneExists)) {
        await this.assertProfile(paneExists, input.cwd);
        await input.guard();
        this.save(input.conversationId, { phase: "ready", paneId: launch!.paneId! });
        return;
      }
      await new Promise<void>((done) => setTimeout(done, 500));
    }
    throw new Error("participant_session_starting_check_native_prompt");
  }
}
